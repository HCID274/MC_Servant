import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  COLLECT_MIN_RADIUS,
  type CollectSkillCollectedItem,
  type CollectSkillExecutionResult,
  type CollectSkillParams,
  type CollectSkillSkippedItem,
  createCollectSkillExecutionResult,
} from "../../core-ports/skills.js";
import { matchesMinecraftItemName, normalizeMinecraftName } from "./naming.js";
import type {
  MineflayerEntityHandle,
  MineflayerEntityPort,
  MineflayerInventoryPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerVec3Like,
} from "./types.js";

const DEFAULT_COLLECT_TIMEOUT_MS = 10_000;
const AUTO_COLLECT_SETTLE_MS = 250;
const COLLECT_POLL_MS = 100;

/** collect（捡拾） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerCollectPort = MineflayerMovementPort &
  MineflayerEntityPort &
  MineflayerInventoryPort;

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
export async function executeMineflayerCollect(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<CollectSkillParams>;
}): Promise<CollectSkillExecutionResult> {
  const options = normalizeCollectDropsOptions(input.bot, input.params);
  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  configureCollectMovements(movements);
  input.pathfinder.setMovements?.(movements);

  return collectDrops({
    bot: input.bot,
    pathfinder: input.pathfinder,
    pathfinderModule: input.pathfinderModule,
    options,
  });
}

/** 配置 collect（捡拾） 移动策略：当前阶段不允许为了捡物品挖穿障碍。 */
function configureCollectMovements(movements: unknown): void {
  if (movements === null || typeof movements !== "object") {
    return;
  }

  Object.assign(movements, {
    canDig: false,
  });
}

/** 按锚点范围收集掉落物；对外仍承载 collect（捡拾） 技能语义。 */
async function collectDrops(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly options: CollectDropsOptions;
}): Promise<CollectSkillExecutionResult> {
  const startedAt = Date.now();
  const inventoryBefore = countInventoryByName(input.bot);
  let totalSteps = 0;
  const skipped: CollectSkillSkippedItem[] = [];
  let options = input.options;
  let sawTargetEntity = findCollectTargetEntities(input.bot, options).length > 0;
  let confirmedInventoryIncrease = false;

  await moveToCollectCenterIfNeeded({
    bot: input.bot,
    pathfinder: input.pathfinder,
    pathfinderModule: input.pathfinderModule,
    options,
  });
  totalSteps += 1;

  await delay(AUTO_COLLECT_SETTLE_MS);
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
      collected: autoCollected,
      skipped,
      totalSteps,
    });
  }

  while (Date.now() - startedAt < options.timeoutMs) {
    const targets = findCollectTargetEntities(input.bot, options);
    sawTargetEntity ||= targets.length > 0;

    if (targets.length === 0) {
      const collectedSinceStart = createCollectedDiff(options.itemName, inventoryBefore, input.bot);

      if (sawTargetEntity && collectedSinceStart.length > 0) {
        confirmedInventoryIncrease = true;
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
        pathfinder: input.pathfinder,
        pathfinderModule: input.pathfinderModule,
        ...(options.itemName === undefined ? {} : { itemName: options.itemName }),
        target,
        deadlineMs: startedAt + options.timeoutMs,
      });
      totalSteps += 1;

      if (outcome.status === "collected") {
        madeProgress = true;
        confirmedInventoryIncrease = true;
        continue;
      }

      if (createCollectedDiff(input.options.itemName, beforeAttempt, input.bot).length > 0) {
        madeProgress = true;
        confirmedInventoryIncrease = true;
        continue;
      }

      skipped.push(outcome.skipped);
    }

    if (!madeProgress) {
      break;
    }
  }

  const collected = createCollectedDiff(options.itemName, inventoryBefore, input.bot);

  if (confirmedInventoryIncrease && collected.length > 0) {
    return createCollectResult(options, {
      bot: input.bot,
      collected,
      skipped,
      totalSteps,
    });
  }

  if (skipped.length === 0) {
    skipped.push(createSkippedItem("none", "not_found"));
  }

  throw new Error(
    `Mineflayer did not collect ${options.itemName ?? "any item"}; skipped=${formatSkippedItems(
      skipped,
    )}`,
  );
}

/** 执行 pickup（单实体捡拾），只处理明确实体，不扫描周围其他掉落物。 */
async function pickupEntity(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly itemName?: string;
  readonly target: MineflayerEntityHandle;
  readonly deadlineMs: number;
}): Promise<PickupOutcome> {
  const entityId = input.target.id;
  const currentTarget = findEntityById(input.bot, entityId);

  if (currentTarget === null || currentTarget.position === undefined) {
    return {
      status: "skipped",
      skipped: createSkippedItem(entityId, "despawned_or_collected_by_other"),
    };
  }

  const inventoryBefore = countInventoryByName(input.bot);

  if (!(await goToPickupTarget(input.pathfinder, input.pathfinderModule, currentTarget.position))) {
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

async function goToPickupTarget(
  pathfinder: MineflayerPathfinderApi,
  pathfinderModule: MineflayerPathfinderModule,
  position: MineflayerVec3Like,
): Promise<boolean> {
  const GoalNearXZ = resolveGoalNearXZConstructor(pathfinderModule);
  if (GoalNearXZ !== undefined) {
    try {
      await pathfinder.goto(new GoalNearXZ(position.x, position.z, 1.5));
      return true;
    } catch {
      return false;
    }
  }

  const GoalNear = resolveGoalNearConstructor(pathfinderModule);
  try {
    await pathfinder.goto(new GoalNear(position.x, position.y, position.z, 1));
    return true;
  } catch {
    return false;
  }
}

function resolveGoalNearConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown {
  const goalConstructor = readPathfinderGoals(pathfinderModule).GoalNear;

  if (typeof goalConstructor !== "function") {
    throw new Error("mineflayer-pathfinder GoalNear constructor is unavailable");
  }

  return goalConstructor as new (
    x: number,
    y: number,
    z: number,
    range: number,
  ) => unknown;
}

function resolveGoalNearXZConstructor(
  pathfinderModule: MineflayerPathfinderModule,
): (new (x: number, z: number, range: number) => unknown) | undefined {
  const goalConstructor = readPathfinderGoals(pathfinderModule).GoalNearXZ;

  return typeof goalConstructor === "function"
    ? (goalConstructor as new (
        x: number,
        z: number,
        range: number,
      ) => unknown)
    : undefined;
}

function readPathfinderGoals(
  pathfinderModule: MineflayerPathfinderModule,
): Readonly<Record<string, unknown>> {
  const moduleRecord = isRecord(pathfinderModule) ? pathfinderModule : undefined;
  const directGoalsValue = readOptionalRecordValue(moduleRecord, "goals");
  const directGoals = isRecord(directGoalsValue) ? directGoalsValue : undefined;
  const defaultRecordValue = readOptionalRecordValue(moduleRecord, "default");
  const defaultRecord = isRecord(defaultRecordValue) ? defaultRecordValue : undefined;
  const defaultGoalsValue = readOptionalRecordValue(defaultRecord, "goals");
  const defaultGoals = isRecord(defaultGoalsValue) ? defaultGoalsValue : undefined;
  return directGoals ?? defaultGoals ?? {};
}

function readOptionalRecordValue(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): unknown {
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }

  try {
    return record[key];
  } catch {
    return undefined;
  }
}

/** 规范化 collectDrops（收集掉落物） 参数，保证半径默认值和上限一致。 */
function normalizeCollectDropsOptions(
  bot: MineflayerCollectPort,
  params: Readonly<CollectSkillParams>,
): CollectDropsOptions {
  const center = params.center ?? bot.entity?.position;

  if (center === undefined) {
    throw new Error("Mineflayer collect requires bot position or explicit center");
  }

  const radius = params.radius ?? COLLECT_DEFAULT_RADIUS;

  if (!Number.isInteger(radius) || radius < COLLECT_MIN_RADIUS || radius > COLLECT_MAX_RADIUS) {
    throw new Error(
      `collect radius must be an integer from ${COLLECT_MIN_RADIUS} to ${COLLECT_MAX_RADIUS}`,
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
async function moveToCollectCenterIfNeeded(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly options: CollectDropsOptions;
}): Promise<void> {
  const botPosition = input.bot.entity?.position;
  if (input.options.useLiveBotCenter) {
    return;
  }

  if (
    botPosition !== undefined &&
    calculateDistanceSquared(botPosition, input.options.center) <= input.options.radius ** 2
  ) {
    return;
  }

  await input.pathfinder.goto(
    new input.pathfinderModule.goals.GoalNear(
      input.options.center.x,
      input.options.center.y,
      input.options.center.z,
      Math.min(1, input.options.radius),
    ),
  );
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 解析注册表中的标准物品 ID。 */
function findRegistryItemId(registry: unknown, itemName: string): number | null {
  if (!isRecord(registry) || !isRecord(registry.itemsByName)) {
    return null;
  }

  const item = registry.itemsByName[normalizeMinecraftName(itemName)];

  return isRecord(item) && typeof item.id === "number" ? item.id : null;
}

/** 从未知结构中提取可能的物品 ID。 */
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
function isLikelyItemEntity(entity: MineflayerEntityHandle): boolean {
  return (
    entity.name === "item" ||
    entity.displayName === "Item" ||
    entity.item !== undefined ||
    entity.droppedItem !== undefined
  );
}

/** 计算两点间的平方距离。 */
function calculateDistanceSquared(a: MineflayerVec3Like, b: MineflayerVec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  return dx * dx + dy * dy + dz * dz;
}

/** 从当前世界状态中定位范围内所有目标掉落物。 */
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
function readEntityId(entity: unknown): number | string | undefined {
  if (!isRecord(entity)) {
    return undefined;
  }

  const id = entity.id;

  return typeof id === "number" || typeof id === "string" ? id : undefined;
}

/** 创建收集增量结果。 */
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
function createCollectResult(
  options: CollectDropsOptions,
  outcome: {
    readonly bot: MineflayerCollectPort;
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
      center,
      collected: outcome.collected,
      skipped: outcome.skipped,
      total_steps: outcome.totalSteps,
    },
  );
}

function resolveCollectCenter(
  bot: MineflayerCollectPort,
  options: CollectDropsOptions,
): MineflayerVec3Like {
  return options.useLiveBotCenter ? (bot.entity?.position ?? options.center) : options.center;
}

/** 格式化跳过记录，作为失败诊断的一部分。 */
function formatSkippedItems(skipped: readonly CollectSkillSkippedItem[]): string {
  return skipped.map((item) => `${String(item.entityId)}:${item.reason}`).join(",");
}

/** 等待指定毫秒数。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
