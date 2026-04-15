/**
 * 环境快照构建与威胁评估实现。
 * 
 * 架构职责：
 * 1. 数据聚合：通过 createEnvironmentSnapshot 将来自不同源（Mineflayer 和 JAR Bridge）的观测片段合并为全局一致的环境快照。
 * 2. 状态稳压：实现深度的克隆与冻结逻辑，确保快照在被各个模块（Runtime, Sandbox）消费时是绝对只读的。
 * 3. 反应式评估：实现 assessThreat 逻辑，根据预设的威胁规则（Threat Rules）对环境进行实时安全判定。
 * 4. 边界封装：提供 ObservationReadBoundary，为上层应用提供统一的、基于快照的世界状态和主人状态查询视图。
 */

import {
  type BotStateSnapshot,
  type BridgeObservationInput,
  type EnvironmentSnapshot,
  type EquipmentSummary,
  type InventorySummary,
  type MineflayerObservationInput,
  type NearbyBlockSummary,
  type NearbyEntityKind,
  type NearbyEntitySummary,
  type ObservationReadBoundary,
  type ObservationSnapshotSource,
  type ObservationWorldView,
  type OwnerSnapshot,
  type ReflexInterruptSource,
  type SnapshotPosition,
  type ThreatAssessment,
  type ThreatDetectorInput,
  ThreatLevel,
  ThreatRuleId,
} from "./contracts.js";

function freezeReadonlyArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezePosition(position: SnapshotPosition): SnapshotPosition {
  return Object.freeze({ x: position.x, y: position.y, z: position.z });
}

function freezeBotStateSnapshot(bot: BotStateSnapshot): BotStateSnapshot {
  return Object.freeze({
    ...bot,
    position: freezePosition(bot.position),
  });
}

function cloneInventorySummary(summary: InventorySummary): InventorySummary {
  return Object.freeze({
    items: freezeReadonlyArray(summary.items.map((item) => Object.freeze({ ...item }))),
    total_items: summary.total_items,
    occupied_slots: summary.occupied_slots,
    free_slots: summary.free_slots,
  });
}

function cloneEquipmentSummary(summary: EquipmentSummary): EquipmentSummary {
  return Object.freeze({
    head: summary.head ? Object.freeze({ ...summary.head }) : null,
    chest: summary.chest ? Object.freeze({ ...summary.chest }) : null,
    legs: summary.legs ? Object.freeze({ ...summary.legs }) : null,
    feet: summary.feet ? Object.freeze({ ...summary.feet }) : null,
    main_hand: summary.main_hand ? Object.freeze({ ...summary.main_hand }) : null,
    off_hand: summary.off_hand ? Object.freeze({ ...summary.off_hand }) : null,
    has_weapon_equipped: summary.has_weapon_equipped,
  });
}

function cloneEntitySummary(entity: NearbyEntitySummary): NearbyEntitySummary {
  return Object.freeze({
    ...entity,
    position: freezePosition(entity.position),
  });
}

function cloneBlockSummary(block: NearbyBlockSummary): NearbyBlockSummary {
  return Object.freeze({
    ...block,
    position: freezePosition(block.position),
  });
}

function cloneOwnerSnapshot(owner: OwnerSnapshot): OwnerSnapshot {
  return Object.freeze({
    ...owner,
    position: freezePosition(owner.position),
  });
}

function cloneEnvironmentSnapshot(snapshot: EnvironmentSnapshot): EnvironmentSnapshot {
  const snapshotBase = {
    timestamp: snapshot.timestamp,
    snapshot_version: snapshot.snapshot_version,
    bot: freezeBotStateSnapshot(snapshot.bot),
    inventory: cloneInventorySummary(snapshot.inventory),
    equipment: cloneEquipmentSummary(snapshot.equipment),
    nearby_entities: freezeReadonlyArray(
      snapshot.nearby_entities.map((entity) => cloneEntitySummary(entity)),
    ),
    nearby_blocks: freezeReadonlyArray(
      snapshot.nearby_blocks.map((block) => cloneBlockSummary(block)),
    ),
  } satisfies Omit<EnvironmentSnapshot, "owner" | "server_extended">;

  return Object.freeze({
    ...snapshotBase,
    ...(snapshot.owner ? { owner: cloneOwnerSnapshot(snapshot.owner) } : {}),
    ...(snapshot.server_extended
      ? { server_extended: Object.freeze({ ...snapshot.server_extended }) }
      : {}),
  });
}

function mergeEntitySummaries(
  mineflayer: readonly NearbyEntitySummary[],
  bridge?: readonly NearbyEntitySummary[],
): readonly NearbyEntitySummary[] {
  const byId = new Map<string, NearbyEntitySummary>();

  for (const entity of mineflayer) {
    byId.set(entity.entity_id, cloneEntitySummary(entity));
  }

  for (const entity of bridge ?? []) {
    byId.set(entity.entity_id, cloneEntitySummary(entity));
  }

  return freezeReadonlyArray(
    [...byId.values()].sort((left, right) => left.distance - right.distance),
  );
}

function getBlockKey(block: NearbyBlockSummary): string {
  return `${block.block_name}:${block.position.x}:${block.position.y}:${block.position.z}`;
}

function mergeBlockSummaries(
  mineflayer: readonly NearbyBlockSummary[],
  bridge?: readonly NearbyBlockSummary[],
): readonly NearbyBlockSummary[] {
  const byKey = new Map<string, NearbyBlockSummary>();

  for (const block of mineflayer) {
    byKey.set(getBlockKey(block), cloneBlockSummary(block));
  }

  for (const block of bridge ?? []) {
    byKey.set(getBlockKey(block), cloneBlockSummary(block));
  }

  return freezeReadonlyArray(
    [...byKey.values()].sort((left, right) => left.distance - right.distance),
  );
}

function mergeBotState(
  mineflayer: BotStateSnapshot | undefined,
  bridge: BridgeObservationInput["bot"],
): BotStateSnapshot {
  const basePosition = mineflayer?.position ?? bridge?.position;

  if (!basePosition) {
    throw new Error("Environment snapshot requires bot.position");
  }

  const health = mineflayer?.health ?? bridge?.health;
  const food = mineflayer?.food ?? bridge?.food;
  const experience = mineflayer?.experience ?? bridge?.experience;
  const isOnFire = mineflayer?.is_on_fire ?? bridge?.is_on_fire;
  const isInWater = mineflayer?.is_in_water ?? bridge?.is_in_water;
  const yVelocity = mineflayer?.y_velocity ?? bridge?.y_velocity;

  if (
    health === undefined ||
    food === undefined ||
    experience === undefined ||
    isOnFire === undefined ||
    isInWater === undefined ||
    yVelocity === undefined
  ) {
    throw new Error("Environment snapshot requires a complete bot state");
  }

  return {
    position: freezePosition(basePosition),
    health,
    food,
    experience,
    is_on_fire: isOnFire,
    is_in_water: isInWater,
    y_velocity: yVelocity,
  };
}

function mergeOwnerSnapshot(
  mineflayer?: OwnerSnapshot,
  bridge?: BridgeObservationInput["owner"],
): OwnerSnapshot | undefined {
  if (!mineflayer && !bridge) {
    return undefined;
  }

  const position = mineflayer?.position ?? bridge?.position;
  const name = mineflayer?.name ?? bridge?.name;
  const online = mineflayer?.online ?? bridge?.online;

  if (!position || !name || online === undefined) {
    return undefined;
  }

  return cloneOwnerSnapshot({ position, name, online });
}

/**
 * 创建环境快照。
 * 
 * 架构意图：
 * 它是系统感知的“合成器”。它接收来自 Mineflayer（主要负责基础状态、背包、装备）
 * 和 JAR Bridge（主要负责扩展实体、方块和服务器元数据）的原始输入，
 * 并根据优先级和完整性规则合并成一个全局唯一的 EnvironmentSnapshot。
 * 
 * @param input 包含 Mineflayer 和 JAR Bridge 观测输入的源
 * @returns 合并并冻结后的环境快照
 */
export function createEnvironmentSnapshot(input: {
  mineflayer?: MineflayerObservationInput;
  bridge?: BridgeObservationInput;
}): EnvironmentSnapshot {
  if (!input.mineflayer && !input.bridge) {
    throw new Error("Environment snapshot requires at least one observation source");
  }

  const timestamp = input.mineflayer?.timestamp ?? input.bridge?.timestamp;
  const snapshotVersion = input.mineflayer?.snapshot_version ?? input.bridge?.snapshot_version;
  const inventory = input.mineflayer?.inventory ?? input.bridge?.inventory;
  const equipment = input.mineflayer?.equipment ?? input.bridge?.equipment;
  const owner = mergeOwnerSnapshot(input.mineflayer?.owner, input.bridge?.owner);

  if (timestamp === undefined || !snapshotVersion || !inventory || !equipment) {
    throw new Error(
      "Environment snapshot requires timestamp, snapshot_version, inventory and equipment",
    );
  }

  const snapshotBase = {
    timestamp,
    snapshot_version: snapshotVersion,
    bot: mergeBotState(input.mineflayer?.bot, input.bridge?.bot),
    inventory: cloneInventorySummary(inventory),
    equipment: cloneEquipmentSummary(equipment),
    nearby_entities: mergeEntitySummaries(
      input.mineflayer?.nearby_entities ?? [],
      input.bridge?.nearby_entities,
    ),
    nearby_blocks: mergeBlockSummaries(
      input.mineflayer?.nearby_blocks ?? [],
      input.bridge?.nearby_blocks,
    ),
  } satisfies Omit<EnvironmentSnapshot, "owner" | "server_extended">;

  return cloneEnvironmentSnapshot({
    ...snapshotBase,
    ...(owner ? { owner } : {}),
    ...(input.bridge?.server_extended
      ? { server_extended: Object.freeze({ ...input.bridge.server_extended }) }
      : {}),
  });
}

/** 创建威胁检测输入，用于把环境快照裁剪成 reflex 评估所需数据。 */
export function createThreatDetectorInput(snapshot: EnvironmentSnapshot): ThreatDetectorInput {
  return Object.freeze({
    snapshot,
    hostile_entities: freezeReadonlyArray(
      snapshot.nearby_entities
        .filter((entity) => entity.kind === "hostile")
        .map((entity) => cloneEntitySummary(entity)),
    ),
  });
}

function pickThreatRule(input: ThreatDetectorInput): {
  rule_id: ThreatRuleId;
  threat_level: ThreatLevel;
  reason: string;
} | null {
  const hostileCount = input.hostile_entities.filter((entity) => entity.distance < 16).length;
  const hasNearbyHostile = hostileCount > 0;

  if (input.snapshot.bot.is_on_fire) {
    return {
      rule_id: ThreatRuleId.BotOnFire,
      threat_level: ThreatLevel.Emergency,
      reason: "bot_on_fire",
    };
  }

  if (input.snapshot.bot.health < 4) {
    return {
      rule_id: ThreatRuleId.CriticalHealth,
      threat_level: ThreatLevel.Emergency,
      reason: "critical_health",
    };
  }

  if (input.snapshot.bot.y_velocity < -0.8) {
    return {
      rule_id: ThreatRuleId.Falling,
      threat_level: ThreatLevel.Emergency,
      reason: "falling",
    };
  }

  if (hostileCount >= 4) {
    return {
      rule_id: ThreatRuleId.HostileSwarm,
      threat_level: ThreatLevel.Flee,
      reason: "hostile_swarm",
    };
  }

  if (hasNearbyHostile && input.snapshot.equipment.has_weapon_equipped) {
    return {
      rule_id: ThreatRuleId.HostileCloseArmed,
      threat_level: ThreatLevel.Fight,
      reason: "hostile_close_armed",
    };
  }

  if (hasNearbyHostile) {
    return {
      rule_id: ThreatRuleId.HostileCloseUnarmed,
      threat_level: ThreatLevel.Flee,
      reason: "hostile_close_unarmed",
    };
  }

  return null;
}

/**
 * 评估环境快照中的威胁。
 * 
 * 架构意图：
 * 它是 Bot 的“边缘计算”单元，负责快速判定环境风险。
 * 策略包括：生命值过低、着火、正在坠落、以及被敌对生物包围等。
 * 如果评估命中规则，将返回 ThreatAssessment，用于在运行时触发“反射式中断”。
 * 
 * @param input 包含快照和敌对实体的检测输入
 * @returns 威胁评估结果或 null
 */
export function assessThreat(input: ThreatDetectorInput): ThreatAssessment | null {
  const pickedRule = pickThreatRule(input);

  if (!pickedRule) {
    return null;
  }

  return Object.freeze({
    rule_id: pickedRule.rule_id,
    level: pickedRule.threat_level,
    reason: pickedRule.reason,
    interrupt_required: true,
    detected_at: input.snapshot.timestamp,
    hostile_entities: freezeReadonlyArray(
      input.hostile_entities.map((entity) => cloneEntitySummary(entity)),
    ),
    bot_state: {
      health: input.snapshot.bot.health,
      is_on_fire: input.snapshot.bot.is_on_fire,
      y_velocity: input.snapshot.bot.y_velocity,
      has_weapon_equipped: input.snapshot.equipment.has_weapon_equipped,
    },
  });
}

/** 创建 reflex 中断来源，用于把威胁评估结果直接交给 runtime。 */
export function createReflexInterruptSource(threat: ThreatAssessment): ReflexInterruptSource {
  return Object.freeze({
    type: "reflex",
    threat,
  });
}

/** 创建 observation 的只读世界视图，用于后续 api.world 代理。 */
export function createObservationWorldView(
  snapshotSource: ObservationSnapshotSource,
): ObservationWorldView {
  return Object.freeze({
    nearestBlocks(blockName: string, radius = 64, maxCount = 10) {
      const snapshot = snapshotSource.getCurrentSnapshot();

      return freezeReadonlyArray(
        snapshot.nearby_blocks
          .filter((block) => block.block_name === blockName && block.distance <= radius)
          .slice(0, maxCount)
          .map((block) => cloneBlockSummary(block)),
      );
    },
    nearestEntities(kind?: NearbyEntityKind, radius = 64) {
      const snapshot = snapshotSource.getCurrentSnapshot();

      return freezeReadonlyArray(
        snapshot.nearby_entities
          .filter((entity) => entity.distance <= radius && (kind ? entity.kind === kind : true))
          .map((entity) => cloneEntitySummary(entity)),
      );
    },
    blockAt(position: SnapshotPosition) {
      const snapshot = snapshotSource.getCurrentSnapshot();
      const matchedBlock =
        snapshot.nearby_blocks.find(
          (block) =>
            block.position.x === position.x &&
            block.position.y === position.y &&
            block.position.z === position.z,
        ) ?? null;

      return matchedBlock ? cloneBlockSummary(matchedBlock) : null;
    },
  });
}

/**
 * 创建观测模块的只读边界。
 * 
 * 架构意图：
 * 它是 Observation 模块的“对外接口”。通过封装 snapshotSource，
 * 它向上层提供了查询当前快照、主人快照和三维世界视图（World View）的标准化方法。
 * 这种封装确保了调用方始终只能获取到观测数据的快照副本，从而保证了线程/任务间的隔离。
 * 
 * @param snapshotSource 提供最新快照的源对象
 * @returns 完整的只读边界对象
 */
export function createObservationReadBoundary(
  snapshotSource: ObservationSnapshotSource,
): ObservationReadBoundary {
  const worldView = createObservationWorldView(snapshotSource);

  return Object.freeze({
    getSnapshot() {
      return cloneEnvironmentSnapshot(snapshotSource.getCurrentSnapshot());
    },
    getOwnerSnapshot() {
      const currentSnapshot = snapshotSource.getCurrentSnapshot();

      return currentSnapshot.owner ? cloneOwnerSnapshot(currentSnapshot.owner) : null;
    },
    getWorldView() {
      return worldView;
    },
  });
}
