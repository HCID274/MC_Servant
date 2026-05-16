import type {
  EquipmentSummary,
  EquippedItemSummary,
  InventorySummary,
  MineflayerObservationInput,
  NearbyBlockSummary,
  NearbyEntityKind,
  NearbyEntitySummary,
  OwnerSnapshot,
  SnapshotPosition,
  WorldTimeSnapshot,
} from "../../../core-ports/observation.js";
import { cloneReadonlyValue } from "../../../domain/invariants.js";
import { readMineflayerWorldKey } from "../naming.js";
import type {
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerEntityHandle,
  MineflayerItemHandle,
} from "../types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./reader.js";

/** 从 Mineflayer 当前状态创建 observation 输入。 */
export function createMineflayerObservationInput(input: {
  readonly bot: MineflayerBotHandle;
  readonly ownerName?: string;
}): MineflayerObservationInput {
  const now = Date.now();
  const botState = readMineflayerBotState(input.bot);

  return cloneReadonlyValue({
    timestamp: now,
    snapshot_version: `${botState.world_key}:${now}:mineflayer-live`,
    bot: botState,
    inventory: readMineflayerInventory(input.bot),
    equipment: readMineflayerEquipment(input.bot),
    nearby_entities: readMineflayerNearbyEntities(input.bot, botState.position),
    nearby_blocks: readMineflayerNearbyBlocks(input.bot, botState.position),
    ...(input.ownerName === undefined
      ? {}
      : { owner: readMineflayerOwner(input.bot, input.ownerName, botState.position) }),
    time: readMineflayerTime(input.bot),
  });
}

function readMineflayerBotState(bot: MineflayerBotHandle): MineflayerObservationInput["bot"] {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  const botRecord = asPlainRecord(bot);
  const entityRecord = asPlainRecord(bot.entity);
  const velocityRecord = asPlainRecord(bot.entity?.velocity);

  return {
    position: createSnapshotPosition(position),
    world_key: readMineflayerWorldKey(bot),
    health: readNumber(botRecord.health, 20),
    food: readNumber(botRecord.food, 20),
    experience: readExperiencePoints(botRecord.experience),
    is_on_fire: readBoolean(entityRecord.isOnFire, readNumber(entityRecord.fire, 0) > 0),
    is_in_water: readBoolean(entityRecord.isInWater, false),
    y_velocity: readNumber(velocityRecord.y, 0),
  };
}

function readMineflayerInventory(bot: MineflayerBotHandle): InventorySummary {
  const items = (bot.inventory?.items() ?? [])
    .map((item, index) => createInventoryItemSummary(item, index))
    .filter((item): item is InventorySummary["items"][number] => item !== null);
  const totalItems = items.reduce((sum, item) => sum + item.count, 0);
  const freeSlots = bot.inventory?.emptySlotCount?.() ?? Math.max(0, 36 - items.length);

  return {
    items,
    total_items: totalItems,
    occupied_slots: items.length,
    free_slots: freeSlots,
  };
}

function createInventoryItemSummary(
  item: MineflayerItemHandle,
  fallbackSlot: number,
): InventorySummary["items"][number] | null {
  if (item.name === undefined || item.name.length === 0) {
    return null;
  }

  return {
    slot: fallbackSlot,
    item_name: item.name,
    count: item.count ?? 1,
  };
}

function readMineflayerEquipment(bot: MineflayerBotHandle): EquipmentSummary {
  const slots = bot.inventory?.slots ?? [];

  return {
    head: createEquippedItemSummary("head", slots[5] ?? null),
    chest: createEquippedItemSummary("chest", slots[6] ?? null),
    legs: createEquippedItemSummary("legs", slots[7] ?? null),
    feet: createEquippedItemSummary("feet", slots[8] ?? null),
    main_hand: createEquippedItemSummary("main_hand", bot.heldItem ?? null),
    off_hand: createEquippedItemSummary("off_hand", slots[45] ?? null),
    has_weapon_equipped: bot.heldItem?.name !== undefined,
  };
}

function createEquippedItemSummary(
  slot: EquippedItemSummary["slot"],
  item: MineflayerItemHandle | null | undefined,
): EquippedItemSummary | null {
  if (item?.name === undefined || item.name.length === 0) {
    return null;
  }

  return {
    slot,
    item_name: item.name,
    count: item.count ?? 1,
  };
}

function readMineflayerNearbyEntities(
  bot: MineflayerBotHandle,
  origin: SnapshotPosition,
): readonly NearbyEntitySummary[] {
  const botEntityId = bot.entity?.id;

  return Object.values(bot.entities ?? {})
    .filter((entity): entity is MineflayerEntityHandle => entity !== undefined)
    .filter((entity) => entity.position !== undefined && entity.id !== botEntityId)
    .map((entity) => createNearbyEntitySummary(entity, origin))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 16);
}

function createNearbyEntitySummary(
  entity: MineflayerEntityHandle,
  origin: SnapshotPosition,
): NearbyEntitySummary {
  const position = createSnapshotPosition(entity.position ?? origin);
  const kind = inferNearbyEntityKind(entity);
  const name = entity.username ?? entity.displayName ?? entity.name ?? "unknown";

  return {
    entity_id: String(entity.id ?? name),
    entity_type: entity.name ?? entity.objectType ?? "unknown",
    kind,
    display_name: name,
    position,
    distance: getDistance(origin, position),
  };
}

function inferNearbyEntityKind(entity: MineflayerEntityHandle): NearbyEntityKind {
  if (entity.username !== undefined || entity.name === "player") {
    return "player";
  }

  return "other";
}

function readMineflayerNearbyBlocks(
  bot: MineflayerBotHandle,
  origin: SnapshotPosition,
): readonly NearbyBlockSummary[] {
  if (!canReadMineflayerBlockAt(bot)) {
    return [];
  }

  return createNearbyBlockSamplePositions(origin)
    .map((position) => readMineflayerBlockAt(bot, position))
    .filter((block): block is MineflayerBlockHandle => block !== null && block !== undefined)
    .filter((block) => block.name !== undefined && block.name !== "air")
    .map((block) => createNearbyBlockSummary(block, origin))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 5);
}

function createNearbyBlockSamplePositions(origin: SnapshotPosition): readonly SnapshotPosition[] {
  const x = Math.floor(origin.x);
  const y = Math.floor(origin.y);
  const z = Math.floor(origin.z);

  return [
    { x, y: y - 1, z },
    { x: x + 1, y, z },
    { x: x - 1, y, z },
    { x, y, z: z + 1 },
    { x, y, z: z - 1 },
    { x: x + 1, y: y - 1, z },
    { x: x - 1, y: y - 1, z },
    { x, y: y - 1, z: z + 1 },
    { x, y: y - 1, z: z - 1 },
  ];
}

function createNearbyBlockSummary(
  block: MineflayerBlockHandle,
  origin: SnapshotPosition,
): NearbyBlockSummary {
  const position = createSnapshotPosition(block.position ?? origin);

  return {
    block_name: block.name ?? "unknown",
    position,
    distance: getDistance(origin, position),
  };
}

function readMineflayerOwner(
  bot: MineflayerBotHandle,
  ownerName: string,
  origin: SnapshotPosition,
): OwnerSnapshot {
  const playerEntity = readMineflayerPlayerEntity(bot, ownerName);

  if (playerEntity?.position === undefined) {
    return {
      name: ownerName,
      online: false,
      position: origin,
    };
  }

  return {
    name: ownerName,
    online: true,
    position: createSnapshotPosition(playerEntity.position),
  };
}

function readMineflayerPlayerEntity(
  bot: MineflayerBotHandle,
  ownerName: string,
): MineflayerEntityHandle | null {
  const players = asPlainRecord(asPlainRecord(bot).players);
  const player = asPlainRecord(players[ownerName]);
  const entity = player.entity;

  if (entity === undefined || entity === null || typeof entity !== "object") {
    return null;
  }

  return entity as MineflayerEntityHandle;
}

function readMineflayerTime(bot: MineflayerBotHandle): WorldTimeSnapshot {
  const time = asPlainRecord(asPlainRecord(bot).time);
  const timeOfDay = typeof time.timeOfDay === "number" ? time.timeOfDay : null;
  const phase = typeof time.isDay === "boolean" ? (time.isDay ? "day" : "night") : "unknown";

  return {
    phase,
    time_of_day: timeOfDay,
  };
}

function readExperiencePoints(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  return readNumber(asPlainRecord(value).points, 0);
}

function createSnapshotPosition(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): SnapshotPosition {
  return {
    x: position.x,
    y: position.y,
    z: position.z,
  };
}

function getDistance(left: SnapshotPosition, right: SnapshotPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
