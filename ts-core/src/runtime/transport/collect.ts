/**
 * collect（捡拾掉落物）技能适配器。
 * 流程：移动到中心点 → 等待实体稳定 → 逐个走向捡拾 → 通过背包差异统计收集量。
 */

import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  type CollectSkillCollectedItem,
  type CollectSkillExecutionResult,
  type CollectSkillParams,
  type CollectSkillSkippedItem,
  type SkillExecutionControl,
  createCollectSkillExecutionResult,
} from "../../core-ports/skills.js";
import { createMineBlockFactReader } from "./facts/index.js";
import { matchesMinecraftItemName, normalizeMinecraftName } from "./naming.js";
import { navigateTerrainToFoot, vec3LikeToTerrainFoot } from "./terrain/index.js";
import type {
  MineflayerEntityHandle,
  MineflayerEntityPort,
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
  MineflayerVec3Like,
} from "./types.js";

const DEFAULT_COLLECT_TIMEOUT_MS = 10_000;
const AUTO_COLLECT_SETTLE_MS = 250;
const COLLECT_POLL_MS = 100;
const INTERNAL_COLLECT_MIN_RADIUS = 1;
const COLLECT_MAX_VERTICAL_DELTA_FROM_BOT = 3;
const COLLECT_PICKUP_GOAL_RANGE = 0.75;

/** collect（捡拾） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerCollectPort = MineflayerMovementPort &
  MineflayerEntityPort &
  MineflayerInventoryPort &
  MineflayerMiningPort &
  MineflayerPlacementPort;

/** pickup（单实体捡拾） 的终态原因。 */
type PickupOutcome =
  | {
      readonly status: "collected";
      readonly count: number;
    }
  | {
      readonly status: "skipped";
      readonly skipped: CollectSkillSkippedItem;
    };

/** collectDrops（收集掉落物） 内部规范化参数。 */
interface CollectDropsOptions {
  readonly itemName?: string;
  readonly center: MineflayerVec3Like;
  readonly useLiveBotCenter: boolean;
  readonly radius: number;
  readonly timeoutMs: number;
}

/** 执行 collect（捡拾） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
/** 执行 collect（捡拾）技能：收集指定范围内的掉落物实体。 */
export async function executeMineflayerCollect(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<CollectSkillParams>;
  readonly worldKey: string | null;
  readonly control: SkillExecutionControl;
}): Promise<CollectSkillExecutionResult> {
  input.control.throwIfAborted();
  const options = normalizeCollectDropsOptions(input.bot, input.params);
  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);
  void input.pathfinderModule;

  return collectDrops({
    bot: input.bot,
    worldKey: input.worldKey,
    options,
    control: input.control,
  });
}

/** 按锚点范围收集掉落物；对外仍承载 collect（捡拾） 技能语义。 */
async function collectDrops(input: {
  readonly bot: MineflayerCollectPort;
  readonly worldKey: string | null;
  readonly options: CollectDropsOptions;
  readonly control: SkillExecutionControl;
}): Promise<CollectSkillExecutionResult> {
  const startedAt = Date.now();
  const inventoryBefore = countInventoryByName(input.bot);
  let totalSteps = 0;
  const skipped: CollectSkillSkippedItem[] = [];
  const diagnostics: string[] = [];
  let options = input.options;
  let sawTargetEntity = findCollectTargetEntities(input.bot, options).length > 0;

  totalSteps += await moveToCollectCenterIfNeeded(input.bot, options, diagnostics, input.control);

  await delay(AUTO_COLLECT_SETTLE_MS);
  input.control.throwIfAborted();
  let settledTargets = findCollectTargetEntities(input.bot, options);
  sawTargetEntity ||= settledTargets.length > 0;
  const autoCollected = createCollectedDiff(options.itemName, inventoryBefore, input.bot);

  if (!sawTargetEntity && options.radius < COLLECT_MAX_RADIUS) {
    options = expandCollectDropsOptions(options);
    settledTargets = findCollectTargetEntities(input.bot, options);
    sawTargetEntity ||= settledTargets.length > 0;
  }

  if (sawTargetEntity && autoCollected.length > 0 && settledTargets.length === 0) {
    return createCollectResult(options, {
      bot: input.bot,
      worldKey: input.worldKey,
      collected: autoCollected,
      skipped,
      totalSteps,
    });
  }

  while (Date.now() - startedAt < options.timeoutMs) {
    input.control.throwIfAborted();
    const targets = findCollectTargetEntities(input.bot, options);
    sawTargetEntity ||= targets.length > 0;

    if (targets.length === 0) {
      const collectedSinceStart = createCollectedDiff(options.itemName, inventoryBefore, input.bot);

      if (sawTargetEntity && collectedSinceStart.length > 0) {
        break;
      }

      if (sawTargetEntity && skipped.length > 0) {
        break;
      }

      await delay(COLLECT_POLL_MS);
      continue;
    }

    let madeProgress = false;

    for (const target of targets) {
      if (Date.now() - startedAt >= options.timeoutMs) {
        skipped.push(createSkippedItem(target.id, "timeout"));
        continue;
      }

      const beforeAttempt = countInventoryByName(input.bot);
      const outcome = await pickupEntity({
        bot: input.bot,
        ...(options.itemName === undefined ? {} : { itemName: options.itemName }),
        target,
        deadlineMs: startedAt + options.timeoutMs,
        diagnostics,
        control: input.control,
      });
      totalSteps += 1;

      if (outcome.status === "collected") {
        madeProgress = true;
        continue;
      }

      if (createCollectedDiff(input.options.itemName, beforeAttempt, input.bot).length > 0) {
        madeProgress = true;
        continue;
      }

      skipped.push(outcome.skipped);
    }

    if (!madeProgress) {
      await delay(COLLECT_POLL_MS);
    }
  }

  const collected = createCollectedDiff(options.itemName, inventoryBefore, input.bot);
  const remainingTargets = findCollectTargetEntities(input.bot, options);

  if (sawTargetEntity && collected.length > 0 && remainingTargets.length === 0) {
    return createCollectResult(options, {
      bot: input.bot,
      worldKey: input.worldKey,
      collected,
      skipped,
      totalSteps,
    });
  }

  if (skipped.length === 0) {
    if (remainingTargets.length > 0) {
      skipped.push(...remainingTargets.map((target) => createSkippedItem(target.id, "timeout")));
    } else {
      skipped.push(createSkippedItem("none", "not_found"));
    }
  }

  throw new Error(
    `Mineflayer did not collect ${options.itemName ?? "any item"}; skipped=${formatSkippedItems(
      skipped,
    )}; diagnostics=${diagnostics.slice(-12).join("|")}`,
  );
}

/** 执行 pickup（单实体捡拾），只处理明确实体，不扫描周围其他掉落物。 */
/** 捡拾单个实体：接近目标 → 等待拾取 → 验证背包变化。 */
async function pickupEntity(input: {
  readonly bot: MineflayerCollectPort;
  readonly itemName?: string;
  readonly target: MineflayerEntityHandle;
  readonly deadlineMs: number;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
}): Promise<PickupOutcome> {
  input.control.throwIfAborted();
  const entityId = input.target.id;
  const currentTarget = findEntityById(input.bot, entityId);

  if (currentTarget === null || currentTarget.position === undefined) {
    return {
      status: "skipped",
      skipped: createSkippedItem(entityId, "despawned_or_collected_by_other"),
    };
  }

  const inventoryBefore = countInventoryByName(input.bot);

  if (
    !(await goToPickupTarget(input.bot, currentTarget.position, input.diagnostics, input.control))
  ) {
    return {
      status: "skipped",
      skipped: createSkippedItem(entityId, "unreachable"),
    };
  }

  let collectedByOther = false;
  const removeListener = listenForOtherCollector(input.bot, entityId, () => {
    collectedByOther = true;
  });

  try {
    while (Date.now() < input.deadlineMs) {
      input.control.throwIfAborted();
      const collected = createCollectedDiff(input.itemName, inventoryBefore, input.bot);

      if (collected.length > 0) {
        return {
          status: "collected",
          count: collected.reduce((total, item) => total + item.count, 0),
        };
      }

      if (collectedByOther) {
        await delay(COLLECT_POLL_MS);

        if (createCollectedDiff(input.itemName, inventoryBefore, input.bot).length === 0) {
          return {
            status: "skipped",
            skipped: createSkippedItem(entityId, "despawned_or_collected_by_other"),
          };
        }
      }

      if (findEntityById(input.bot, entityId) === null) {
        await delay(COLLECT_POLL_MS);

        if (createCollectedDiff(input.itemName, inventoryBefore, input.bot).length === 0) {
          return {
            status: "skipped",
            skipped: createSkippedItem(entityId, "despawned_or_collected_by_other"),
          };
        }
      }

      if (isInventoryFull(input.bot)) {
        return {
          status: "skipped",
          skipped: createSkippedItem(entityId, "inventory_full"),
        };
      }

      await delay(COLLECT_POLL_MS);
    }
  } finally {
    removeListener();
  }

  return {
    status: "skipped",
    skipped: createSkippedItem(entityId, "timeout"),
  };
}

/** 移动到捡拾目标附近。 */
async function goToPickupTarget(
  bot: MineflayerCollectPort,
  position: MineflayerVec3Like,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<boolean> {
  try {
    const facts = createMineBlockFactReader(bot.registry);
    await navigateTerrainToFoot({
      bot,
      facts,
      targetFoot: vec3LikeToTerrainFoot(position),
      goalRange: COLLECT_PICKUP_GOAL_RANGE,
      allowPlaceUp: true,
      allowDig: true,
      diagnostics,
      diagnosticPrefix: "collect_pickup",
      control,
    });
    return true;
  } catch (error) {
    diagnostics.push(`collect_pickup_route_failed:${getErrorMessage(error)}`);
    return false;
  }
}

/** 规范化 collectDrops（收集掉落物） 参数，保证半径默认值和上限一致。 */
/** 标准化捡拾选项：从参数中提取物品名称、范围、超时等配置。 */
function normalizeCollectDropsOptions(
  bot: MineflayerCollectPort,
  params: Readonly<CollectSkillParams>,
): CollectDropsOptions {
  const center = params.center ?? bot.entity?.position;

  if (center === undefined) {
    throw new Error("Mineflayer collect requires bot position or explicit center");
  }

  const radius = params.radius ?? COLLECT_DEFAULT_RADIUS;

  if (
    !Number.isInteger(radius) ||
    radius < INTERNAL_COLLECT_MIN_RADIUS ||
    radius > COLLECT_MAX_RADIUS
  ) {
    throw new Error(
      `collect radius must be an integer from ${INTERNAL_COLLECT_MIN_RADIUS} to ${COLLECT_MAX_RADIUS}`,
    );
  }

  return Object.freeze({
    ...(params.itemName === undefined ? {} : { itemName: params.itemName }),
    center: Object.freeze({
      x: center.x,
      y: center.y,
      z: center.z,
    }),
    useLiveBotCenter: params.center === undefined,
    radius,
    timeoutMs: params.timeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS,
  });
}

/** 扩大捡拾范围：当初始范围内找不到目标时，逐步扩大搜索半径。 */
function expandCollectDropsOptions(options: CollectDropsOptions): CollectDropsOptions {
  return Object.freeze({
    ...(options.itemName === undefined ? {} : { itemName: options.itemName }),
    center: options.center,
    useLiveBotCenter: options.useLiveBotCenter,
    radius: COLLECT_MAX_RADIUS,
    timeoutMs: options.timeoutMs,
  });
}

/** 当传入 center（中心点） 时先靠近锚点，再执行范围扫描。 */
/** 如果需要，移动到捡拾区域中心（当 Bot 距离目标太远时）。 */
async function moveToCollectCenterIfNeeded(
  bot: MineflayerCollectPort,
  options: CollectDropsOptions,
  diagnostics: string[],
  control: SkillExecutionControl,
): Promise<number> {
  control.throwIfAborted();
  const botPosition = bot.entity?.position;
  if (options.useLiveBotCenter) {
    return 0;
  }

  if (
    botPosition !== undefined &&
    calculateDistanceSquared(botPosition, options.center) <= options.radius ** 2
  ) {
    return 0;
  }

  const facts = createMineBlockFactReader(bot.registry);
  const navigation = await navigateTerrainToFoot({
    bot,
    facts,
    targetFoot: vec3LikeToTerrainFoot(options.center),
    goalRange: Math.max(1, Math.min(options.radius, 3)),
    allowPlaceUp: true,
    allowDig: true,
    diagnostics,
    diagnosticPrefix: "collect_center",
    control,
  });
  return navigation.totalSteps;
}

/** 判断未知值是否为普通对象。 */
/** 判断值是否为 Record 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从注册表中查找物品 ID（按名称匹配）。 */
function findRegistryItemId(registry: unknown, itemName: string): number | null {
  if (!isRecord(registry) || !isRecord(registry.itemsByName)) {
    return null;
  }

  const item = registry.itemsByName[normalizeMinecraftName(itemName)];

  return isRecord(item) && typeof item.id === "number" ? item.id : null;
}

/** 从未知结构中提取可能的物品 ID。 */
/** 从值中收集数字 ID 列表（支持单个数字、数字数组或嵌套结构）。 */
function collectNumericIds(value: unknown): readonly number[] {
  if (typeof value === "number") {
    return Object.freeze([value]);
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.flatMap((entry) => [...collectNumericIds(entry)]));
  }

  if (!isRecord(value)) {
    return Object.freeze([]);
  }

  const ids: number[] = [];

  for (const [key, nested] of Object.entries(value)) {
    if ((key === "itemId" || key === "id") && typeof nested === "number") {
      ids.push(nested);
      continue;
    }

    ids.push(...collectNumericIds(nested));
  }

  return Object.freeze(ids);
}

/** 从实体上提取可用于匹配的物品名称。 */
/** 收集实体的候选名称（用于匹配捡拾目标）。 */
function collectEntityCandidateNames(entity: MineflayerEntityHandle): readonly string[] {
  const names = [
    entity.name,
    entity.displayName,
    entity.item?.name,
    entity.item?.displayName,
    entity.droppedItem?.name,
    entity.droppedItem?.displayName,
  ].filter((value): value is string => typeof value === "string");

  if (isRecord(entity.objectData)) {
    const objectNames = [entity.objectData.name, entity.objectData.displayName].filter(
      (value): value is string => typeof value === "string",
    );
    names.push(...objectNames);
  }

  for (const metadataEntry of entity.metadata ?? []) {
    if (!isRecord(metadataEntry)) {
      continue;
    }

    for (const key of ["name", "displayName"] as const) {
      const candidate = metadataEntry[key];

      if (typeof candidate === "string") {
        names.push(candidate);
      }
    }

    if (isRecord(metadataEntry.item)) {
      for (const key of ["name", "displayName"] as const) {
        const candidate = metadataEntry.item[key];

        if (typeof candidate === "string") {
          names.push(candidate);
        }
      }
    }
  }

  return Object.freeze(names);
}

/** 判断掉落物实体是否匹配目标物品名。 */
/** 判断实体是否匹配捡拾目标（按名称或 ID 匹配）。 */
function matchesCollectTargetEntity(
  entity: MineflayerEntityHandle,
  itemName: string | undefined,
  registry: unknown,
): boolean {
  if (itemName === undefined) {
    return isLikelyItemEntity(entity);
  }

  const expected = normalizeMinecraftName(itemName);

  if (
    collectEntityCandidateNames(entity).some(
      (candidate) => normalizeMinecraftName(candidate) === expected,
    )
  ) {
    return true;
  }

  const expectedItemId = findRegistryItemId(registry, itemName);

  return expectedItemId !== null && collectNumericIds(entity.metadata).includes(expectedItemId);
}

/** 判断实体是否可能是掉落物，兼容不同 Mineflayer（Minecraft 协议客户端） 版本字段。 */
/** 判断实体是否为掉落物实体（非玩家、非生物、有位置）。 */
function isLikelyItemEntity(entity: MineflayerEntityHandle): boolean {
  return (
    entity.name === "item" ||
    entity.displayName === "Item" ||
    entity.item !== undefined ||
    entity.droppedItem !== undefined
  );
}

/** 计算两点间的平方距离。 */
/** 计算两个坐标的欧几里得距离平方（避免开方运算）。 */
function calculateDistanceSquared(a: MineflayerVec3Like, b: MineflayerVec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** 查找所有匹配捡拾目标的实体（按名称/ID 和距离筛选）。 */
function findCollectTargetEntities(
  bot: MineflayerCollectPort,
  options: CollectDropsOptions,
): readonly MineflayerEntityHandle[] {
  const scanCenter = resolveCollectCenter(bot, options);
  const botPosition = bot.entity?.position ?? scanCenter;
  const radiusSquared = options.radius * options.radius;
  const entities = Object.values(bot.entities ?? {}).filter(
    (entity): entity is MineflayerEntityHandle =>
      entity !== null &&
      entity !== undefined &&
      entity.position !== undefined &&
      calculateDistanceSquared(entity.position, scanCenter) <= radiusSquared &&
      Math.abs(entity.position.y - botPosition.y) <= COLLECT_MAX_VERTICAL_DELTA_FROM_BOT &&
      matchesCollectTargetEntity(entity, options.itemName, bot.registry),
  );

  entities.sort(
    (left, right) =>
      calculateDistanceSquared(left.position as MineflayerVec3Like, botPosition) -
      calculateDistanceSquared(right.position as MineflayerVec3Like, botPosition),
  );

  return Object.freeze(entities);
}

/** 按实体标识读取当前实体快照。 */
/** 按实体 ID 查找实体对象。 */
function findEntityById(
  bot: MineflayerCollectPort,
  entityId: number | string | undefined,
): MineflayerEntityHandle | null {
  if (entityId === undefined) {
    return null;
  }

  return (
    Object.values(bot.entities ?? {}).find(
      (entity): entity is MineflayerEntityHandle =>
        entity !== undefined && entity !== null && entity.id === entityId,
    ) ?? null
  );
}

/** 统计背包内匹配物品的数量。 */
/** 统计背包中指定物品的数量。 */
function countInventoryItems(bot: MineflayerInventoryPort, itemName: string): number {
  return (
    bot.inventory
      ?.items()
      .reduce(
        (total, item) => total + (matchesMinecraftItemName(item, itemName) ? (item.count ?? 1) : 0),
        0,
      ) ?? 0
  );
}

/** 按标准物品名统计背包快照。 */
/** 统计背包中所有物品的数量（按名称分组）。 */
function countInventoryByName(bot: MineflayerInventoryPort): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const item of bot.inventory?.items() ?? []) {
    if (item.name === undefined) {
      continue;
    }

    const name = normalizeMinecraftName(item.name);
    counts.set(name, (counts.get(name) ?? 0) + (item.count ?? 1));
  }

  return counts;
}

/** 判断背包是否无空槽，支持测试替身与 Mineflayer（Minecraft 协议客户端） 常见接口。 */
/** 判断背包是否已满（所有槽位都有物品）。 */
function isInventoryFull(bot: MineflayerInventoryPort): boolean {
  const inventory = bot.inventory;

  if (inventory === undefined) {
    return false;
  }

  if (typeof inventory.emptySlotCount === "function") {
    return inventory.emptySlotCount() <= 0;
  }

  return false;
}

/** 监听 playerCollect（玩家捡拾） 事件，用于缩短被其他玩家拾取时的等待时间。 */
/** 监听其他 Bot 的捡拾事件，避免重复捡拾同一实体。 */
function listenForOtherCollector(
  bot: MineflayerCollectPort,
  entityId: number | string | undefined,
  onCollectedByOther: () => void,
): () => void {
  if (entityId === undefined) {
    return () => undefined;
  }

  const listener = (collector: unknown, collected: unknown): void => {
    const collectedId = readEntityId(collected);

    if (collectedId !== entityId) {
      return;
    }

    const collectorId = readEntityId(collector);
    const botEntityId = readEntityId(bot.entity);

    if (botEntityId === undefined || collectorId !== botEntityId) {
      onCollectedByOther();
    }
  };

  bot.on("playerCollect", listener);

  return () => {
    bot.off?.("playerCollect", listener);
    bot.removeListener?.("playerCollect", listener);
  };
}

/** 从实体兼容结构读取标识。 */
/** 读取实体 ID（支持数字或字符串）。 */
function readEntityId(entity: unknown): number | string | undefined {
  if (!isRecord(entity)) {
    return undefined;
  }

  const id = entity.id;

  return typeof id === "number" || typeof id === "string" ? id : undefined;
}

/** 创建收集增量结果。 */
/** 计算捡拾前后背包物品差异（用于确定实际捡到了什么）。 */
function createCollectedDiff(
  itemName: string | undefined,
  before: ReadonlyMap<string, number>,
  bot: MineflayerInventoryPort,
): readonly CollectSkillCollectedItem[] {
  const after = countInventoryByName(bot);
  const names = itemName === undefined ? after.keys() : [normalizeMinecraftName(itemName)].values();
  const collected: CollectSkillCollectedItem[] = [];

  for (const name of names) {
    const countDiff = (after.get(name) ?? 0) - (before.get(name) ?? 0);

    if (countDiff > 0) {
      collected.push(
        Object.freeze({
          name,
          count: countDiff,
        }),
      );
    }
  }

  return Object.freeze(collected);
}

/** 创建跳过记录。 */
/** 创建跳过捡拾的记录（携带原因）。 */
function createSkippedItem(
  entityId: number | string | undefined,
  reason: CollectSkillSkippedItem["reason"],
): CollectSkillSkippedItem {
  return Object.freeze({
    entityId: entityId ?? "unknown",
    reason,
  });
}

/** 创建 collect（捡拾） 执行结果。 */
/** 创建捡拾结果对象。 */
function createCollectResult(
  options: CollectDropsOptions,
  outcome: {
    readonly bot: MineflayerCollectPort;
    readonly worldKey: string | null;
    readonly collected: readonly CollectSkillCollectedItem[];
    readonly skipped: readonly CollectSkillSkippedItem[];
    readonly totalSteps: number;
  },
): CollectSkillExecutionResult {
  const center = resolveCollectCenter(outcome.bot, options);
  return createCollectSkillExecutionResult(
    {
      ...(options.itemName === undefined ? {} : { itemName: options.itemName }),
      center,
      radius: options.radius,
      timeoutMs: options.timeoutMs,
    },
    {
      world_key: outcome.worldKey,
      center,
      collected: outcome.collected,
      skipped: outcome.skipped,
      total_steps: outcome.totalSteps,
    },
  );
}

/** 计算捡拾区域中心坐标。 */
function resolveCollectCenter(
  bot: MineflayerCollectPort,
  options: CollectDropsOptions,
): MineflayerVec3Like {
  return options.useLiveBotCenter ? (bot.entity?.position ?? options.center) : options.center;
}

/** 格式化跳过记录，作为失败诊断的一部分。 */
/** 格式化跳过捡拾的记录为可读字符串。 */
function formatSkippedItems(skipped: readonly CollectSkillSkippedItem[]): string {
  return skipped.map((item) => `${item.entityId}:${item.reason}`).join("; ");
}

/** 从错误对象中提取错误消息。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 延迟指定毫秒。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
