import {
  type CollectSkillExecutionResult,
  type CollectSkillParams,
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

/** collect（捡拾） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerCollectPort = MineflayerMovementPort &
  MineflayerEntityPort &
  MineflayerInventoryPort;

/** 执行 collect（捡拾） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerCollect(input: {
  readonly bot: MineflayerCollectPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<CollectSkillParams>;
}): Promise<CollectSkillExecutionResult> {
  const radius = input.params.radius ?? 8;
  const targetEntity = findCollectTargetEntity(input.bot, input.params.itemName, radius);

  if (targetEntity === null || targetEntity.position === undefined) {
    throw new Error(`Mineflayer cannot find collectible item ${input.params.itemName}`);
  }

  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  input.pathfinder.setMovements?.(movements);
  const inventoryCountBefore = countInventoryItems(input.bot, input.params.itemName);

  await input.pathfinder.goto(
    new input.pathfinderModule.goals.GoalNear(
      targetEntity.position.x,
      targetEntity.position.y,
      targetEntity.position.z,
      1,
    ),
  );
  await waitForCollectResolution({
    bot: input.bot,
    itemName: input.params.itemName,
    radius,
    inventoryCountBefore,
    initialTargetId: targetEntity.id,
  });

  return createCollectSkillExecutionResult(input.params);
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
  itemName: string,
  registry: unknown,
): boolean {
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

/** 计算两点间的平方距离。 */
function calculateDistanceSquared(a: MineflayerVec3Like, b: MineflayerVec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  return dx * dx + dy * dy + dz * dz;
}

/** 从当前世界状态中定位最近的目标掉落物。 */
function findCollectTargetEntity(
  bot: MineflayerCollectPort,
  itemName: string,
  radius: number,
): MineflayerEntityHandle | null {
  const botPosition = bot.entity?.position;

  if (botPosition === undefined) {
    return null;
  }

  const radiusSquared = radius * radius;
  const isInRadius = (entity: MineflayerEntityHandle): boolean =>
    entity.position !== undefined &&
    calculateDistanceSquared(entity.position, botPosition) <= radiusSquared;

  if (typeof bot.nearestEntity === "function") {
    const entity = bot.nearestEntity(
      (candidate) =>
        isInRadius(candidate) && matchesCollectTargetEntity(candidate, itemName, bot.registry),
    );

    if (entity !== null) {
      return entity;
    }
  }

  const entities = Object.values(bot.entities ?? {}).filter(
    (entity): entity is MineflayerEntityHandle =>
      entity !== null &&
      entity !== undefined &&
      entity.position !== undefined &&
      isInRadius(entity) &&
      matchesCollectTargetEntity(entity, itemName, bot.registry),
  );

  entities.sort(
    (left, right) =>
      calculateDistanceSquared(left.position as MineflayerVec3Like, botPosition) -
      calculateDistanceSquared(right.position as MineflayerVec3Like, botPosition),
  );

  return entities[0] ?? null;
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

/** 等待掉落物被真正捡起，防止“走到附近就算成功”。 */
async function waitForCollectResolution(input: {
  bot: MineflayerCollectPort;
  itemName: string;
  radius: number;
  inventoryCountBefore: number;
  initialTargetId: number | string | undefined;
}): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 3_000) {
    if (countInventoryItems(input.bot, input.itemName) > input.inventoryCountBefore) {
      return;
    }

    const currentTarget = findCollectTargetEntity(input.bot, input.itemName, input.radius);

    if (
      currentTarget !== null &&
      input.bot.entity?.position !== undefined &&
      currentTarget.position !== undefined &&
      calculateDistanceSquared(input.bot.entity.position, currentTarget.position) >
        input.radius * input.radius
    ) {
      throw new Error(`Mineflayer failed to get close enough to collect ${input.itemName}`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`Mineflayer did not collect ${input.itemName} in time`);
}
