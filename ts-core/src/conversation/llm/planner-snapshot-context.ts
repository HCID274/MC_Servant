import type {
  EnvironmentSnapshot,
  EquipmentSummary,
  NearbyBlockSummary,
  NearbyEntitySummary,
  SnapshotPosition,
  WorldTimeSnapshot,
} from "../../core-ports/observation.js";

const MAX_INVENTORY_ITEMS = 12;
const MAX_NEARBY_BLOCKS = 5;
const MAX_NEARBY_ENTITIES = 5;

/** 将 observation（观测）快照压缩为 planner（规划器） prompt（提示词）上下文。 */
export function createPlannerSnapshotContext(input: {
  readonly snapshot: EnvironmentSnapshot | null;
  readonly resourceContext?: string;
}): string {
  void input.resourceContext;

  if (input.snapshot === null) {
    return "online_runtime: observation unavailable; executable skills: goTo, collect";
  }

  return [
    createBotLine(input.snapshot),
    `[世界] ${input.snapshot.bot.world_key ?? "unknown"}`,
    createOwnerLine(input.snapshot),
    createEquipmentLine(input.snapshot.equipment),
    createInventoryLine(input.snapshot),
    createNearbyBlocksLine(input.snapshot.nearby_blocks),
    createNearbyEntitiesLine(input.snapshot.nearby_entities),
    createTimeLine(input.snapshot.time),
  ].join("\n");
}

function createBotLine(snapshot: EnvironmentSnapshot): string {
  return `[Bot] 位置:${formatPosition(snapshot.bot.position)} 生命:${formatNumber(snapshot.bot.health)}/20 饥饿:${formatNumber(snapshot.bot.food)}/20 着火:${snapshot.bot.is_on_fire ? "是" : "否"}`;
}

function createOwnerLine(snapshot: EnvironmentSnapshot): string {
  const owner = snapshot.owner;

  if (owner === undefined || !owner.online) {
    return "[主人] 离线";
  }

  return `[主人] 位置:${formatPosition(owner.position)} 距离:${formatNumber(getDistance(snapshot.bot.position, owner.position))}格 在线:是`;
}

function createEquipmentLine(equipment: EquipmentSummary): string {
  return [
    `[装备] 头:${formatEquipmentItem(equipment.head)}`,
    `身:${formatEquipmentItem(equipment.chest)}`,
    `腿:${formatEquipmentItem(equipment.legs)}`,
    `脚:${formatEquipmentItem(equipment.feet)}`,
    `主手:${formatEquipmentItem(equipment.main_hand)}`,
    `副手:${formatEquipmentItem(equipment.off_hand)}`,
  ].join(" ");
}

function createInventoryLine(snapshot: EnvironmentSnapshot): string {
  const renderedItems = snapshot.inventory.items
    .slice(0, MAX_INVENTORY_ITEMS)
    .map((item) => `${item.item_name} x${item.count}`);
  const suffix = snapshot.inventory.items.length > MAX_INVENTORY_ITEMS ? ", ..." : "";

  return `[背包] ${renderedItems.length === 0 ? "空" : `${renderedItems.join(", ")}${suffix}`}`;
}

function createNearbyBlocksLine(blocks: readonly NearbyBlockSummary[]): string {
  const renderedBlocks = [...groupNearbyBlocks(blocks).values()]
    .sort((left, right) => left.nearest - right.nearest)
    .slice(0, MAX_NEARBY_BLOCKS)
    .map((block) => `${block.blockName}x${block.count}(最近${formatNumber(block.nearest)}格)`);

  return `[附近方块] ${renderedBlocks.length === 0 ? "无" : renderedBlocks.join(", ")}`;
}

function createNearbyEntitiesLine(entities: readonly NearbyEntitySummary[]): string {
  const renderedEntities = [...entities]
    .sort((left, right) => {
      const priorityDiff = getEntityPriority(left) - getEntityPriority(right);
      return priorityDiff === 0 ? left.distance - right.distance : priorityDiff;
    })
    .slice(0, MAX_NEARBY_ENTITIES)
    .map(
      (entity) =>
        `${entity.entity_type}(${formatEntityKind(entity.kind)},${formatNumber(entity.distance)}格)`,
    );

  return `[附近生物] ${renderedEntities.length === 0 ? "无" : renderedEntities.join(", ")}`;
}

function createTimeLine(time: WorldTimeSnapshot | undefined): string {
  if (time === undefined) {
    return "[时间] 未知(unknown)";
  }

  return `[时间] ${formatTimePhase(time.phase)}(${time.time_of_day ?? "unknown"})`;
}

function formatPosition(position: SnapshotPosition): string {
  return `(${formatNumber(position.x)},${formatNumber(position.y)},${formatNumber(position.z)})`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatEquipmentItem(item: EquipmentSummary["main_hand"]): string {
  return item?.item_name ?? "无";
}

function formatEntityKind(kind: NearbyEntitySummary["kind"]): string {
  switch (kind) {
    case "hostile":
      return "敌对";
    case "neutral":
      return "中立";
    case "passive":
      return "被动";
    case "player":
      return "玩家";
    case "other":
      return "其他";
  }
}

function formatTimePhase(phase: WorldTimeSnapshot["phase"]): string {
  switch (phase) {
    case "day":
      return "白天";
    case "night":
      return "夜晚";
    case "unknown":
      return "未知";
  }
}

function groupNearbyBlocks(
  blocks: readonly NearbyBlockSummary[],
): Map<string, { blockName: string; count: number; nearest: number }> {
  const grouped = new Map<string, { blockName: string; count: number; nearest: number }>();

  for (const block of blocks) {
    const current = grouped.get(block.block_name);

    if (current === undefined) {
      grouped.set(block.block_name, {
        blockName: block.block_name,
        count: 1,
        nearest: block.distance,
      });
      continue;
    }

    current.count += 1;
    current.nearest = Math.min(current.nearest, block.distance);
  }

  return grouped;
}

function getEntityPriority(entity: NearbyEntitySummary): number {
  if (entity.kind === "hostile") {
    return 0;
  }

  if (entity.kind === "player") {
    return 1;
  }

  return 2;
}

function getDistance(left: SnapshotPosition, right: SnapshotPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
