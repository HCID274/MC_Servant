/** 三维坐标快照，用于表达 observation 与 world-model 的只读位置。 */
export interface SnapshotPosition {
  /** X 坐标。 */
  x: number;
  /** Y 坐标。 */
  y: number;
  /** Z 坐标。 */
  z: number;
}

/** 背包条目摘要，用于表达已观测到的物品数量。 */
export interface InventoryItemSummary {
  /** 物品所在槽位。 */
  slot: number;
  /** 标准物品标识。 */
  item_name: string;
  /** 物品数量。 */
  count: number;
}

/** 背包摘要，用于表达可观测的物品概况。 */
export interface InventorySummary {
  /** 已归一化的物品条目。 */
  items: readonly InventoryItemSummary[];
  /** 当前物品总数。 */
  total_items: number;
  /** 已占用槽位数。 */
  occupied_slots: number;
  /** 空槽位数。 */
  free_slots: number;
}

/** 装备槽名称，用于统一装备摘要结构。 */
export type EquipmentSlot = "head" | "chest" | "legs" | "feet" | "main_hand" | "off_hand";

/** 装备条目摘要，用于表达当前已穿戴或手持的物品。 */
export interface EquippedItemSummary {
  /** 对应装备槽位。 */
  slot: EquipmentSlot;
  /** 标准物品标识。 */
  item_name: string;
  /** 物品数量。 */
  count: number;
}

/** 装备摘要，用于支撑只读观察与威胁评估。 */
export interface EquipmentSummary {
  /** 头盔槽位。 */
  head: EquippedItemSummary | null;
  /** 胸甲槽位。 */
  chest: EquippedItemSummary | null;
  /** 护腿槽位。 */
  legs: EquippedItemSummary | null;
  /** 鞋子槽位。 */
  feet: EquippedItemSummary | null;
  /** 主手槽位。 */
  main_hand: EquippedItemSummary | null;
  /** 副手槽位。 */
  off_hand: EquippedItemSummary | null;
  /** 当前是否已装备武器。 */
  has_weapon_equipped: boolean;
}

/** 附近实体分类，用于威胁检测与只读查询。 */
export type NearbyEntityKind = "hostile" | "neutral" | "passive" | "player" | "other";

/** 附近实体摘要，用于表达 Mineflayer 与 Bridge 的统一可见实体。 */
export interface NearbyEntitySummary {
  /** 统一实体标识。 */
  entity_id: string;
  /** 标准实体类型。 */
  entity_type: string;
  /** 实体分类。 */
  kind: NearbyEntityKind;
  /** 显示名称。 */
  display_name: string;
  /** 当前坐标。 */
  position: SnapshotPosition;
  /** 与 Bot 的距离。 */
  distance: number;
  /** 当前生命值。 */
  health?: number;
  /** 是否是婴儿形态。 */
  is_baby?: boolean;
}

/** 附近方块摘要，用于表达环境资源与局部可见块。 */
export interface NearbyBlockSummary {
  /** 标准方块标识。 */
  block_name: string;
  /** 当前坐标。 */
  position: SnapshotPosition;
  /** 与 Bot 的距离。 */
  distance: number;
  /** 可选资源簇标识。 */
  cluster_key?: string;
}

/** 主人状态快照，用于支撑 api.owner 只读视图。 */
export interface OwnerSnapshot {
  /** 主人当前位置。 */
  position: SnapshotPosition;
  /** 主人名称。 */
  name: string;
  /** 主人是否在线。 */
  online: boolean;
}

/** Bot 自身状态快照，用于执行前一致性校验与威胁检测。 */
export interface BotStateSnapshot {
  /** Bot 当前坐标。 */
  position: SnapshotPosition;
  /** 当前生命值。 */
  health: number;
  /** 当前饥饿值。 */
  food: number;
  /** 当前经验值。 */
  experience: number;
  /** 当前是否着火。 */
  is_on_fire: boolean;
  /** 当前是否在水中。 */
  is_in_water: boolean;
  /** 当前 Y 轴速度。 */
  y_velocity: number;
}

/** 服务端扩展快照，用于表达 JAR Bridge 提供的额外观测信息。 */
export interface ServerExtendedSnapshot {
  /** 服务端全局实体数量。 */
  global_entity_count: number;
  /** 当前已加载区块数量。 */
  chunk_loaded_count: number;
  /** 服务端 TPS。 */
  tps: number;
}

/** Mineflayer 原始输入，用于表达客户端可直接读取的只读快照源。 */
export interface MineflayerObservationInput {
  /** 原始快照时间戳。 */
  timestamp: number;
  /** 快照版本号。 */
  snapshot_version: string;
  /** Bot 自身状态。 */
  bot: BotStateSnapshot;
  /** 背包摘要。 */
  inventory: InventorySummary;
  /** 装备摘要。 */
  equipment: EquipmentSummary;
  /** 附近实体。 */
  nearby_entities: readonly NearbyEntitySummary[];
  /** 附近方块。 */
  nearby_blocks: readonly NearbyBlockSummary[];
  /** 主人信息。 */
  owner?: OwnerSnapshot;
}

/** JAR Bridge 原始输入，用于表达服务端补充的观测字段。 */
export interface BridgeObservationInput {
  /** 原始快照时间戳。 */
  timestamp?: number;
  /** 快照版本号。 */
  snapshot_version?: string;
  /** 可选 Bot 状态补丁。 */
  bot?: Partial<BotStateSnapshot>;
  /** 可选背包摘要补丁。 */
  inventory?: InventorySummary;
  /** 可选装备摘要补丁。 */
  equipment?: EquipmentSummary;
  /** 可选实体补充列表。 */
  nearby_entities?: readonly NearbyEntitySummary[];
  /** 可选方块补充列表。 */
  nearby_blocks?: readonly NearbyBlockSummary[];
  /** 可选主人信息补丁。 */
  owner?: Partial<OwnerSnapshot>;
  /** 服务端扩展字段。 */
  server_extended?: ServerExtendedSnapshot;
}

/** 环境快照，用于表达运行时、沙箱与诊断共享的只读环境副本。 */
export interface EnvironmentSnapshot {
  /** 快照采集时间戳。 */
  timestamp: number;
  /** 快照版本号，用于执行前一致性校验。 */
  snapshot_version: string;
  /** Bot 自身状态。 */
  bot: BotStateSnapshot;
  /** 背包摘要。 */
  inventory: InventorySummary;
  /** 装备摘要。 */
  equipment: EquipmentSummary;
  /** 附近实体摘要。 */
  nearby_entities: readonly NearbyEntitySummary[];
  /** 附近方块摘要。 */
  nearby_blocks: readonly NearbyBlockSummary[];
  /** 主人信息。 */
  owner?: OwnerSnapshot;
  /** JAR Bridge 扩展信息。 */
  server_extended?: ServerExtendedSnapshot;
}

/** 威胁等级枚举，用于与 reflex 规则表保持一致。 */
export enum ThreatLevel {
  Fight = "fight",
  Flee = "flee",
  Emergency = "emergency",
}

/** 威胁规则标识，用于审计反射来源。 */
export enum ThreatRuleId {
  HostileSwarm = "hostile_swarm",
  HostileCloseArmed = "hostile_close_armed",
  HostileCloseUnarmed = "hostile_close_unarmed",
  BotOnFire = "bot_on_fire",
  CriticalHealth = "critical_health",
  Falling = "falling",
}

/** 威胁检测输入，用于表达 observation 的纯函数评估边界。 */
export interface ThreatDetectorInput {
  /** 当前环境快照。 */
  snapshot: EnvironmentSnapshot;
  /** 当前被视为敌对的实体列表。 */
  hostile_entities: readonly NearbyEntitySummary[];
}

/** 威胁评估结果，用于驱动 reflex 中断与诊断日志。 */
export interface ThreatAssessment {
  /** 匹配到的规则标识。 */
  rule_id: ThreatRuleId;
  /** 评估出的威胁等级。 */
  level: ThreatLevel;
  /** 触发原因说明。 */
  reason: string;
  /** 是否要求立即触发中断。 */
  interrupt_required: boolean;
  /** 评估发生时间。 */
  detected_at: number;
  /** 参与评估的敌对实体。 */
  hostile_entities: readonly NearbyEntitySummary[];
  /** 当前 Bot 生存状态摘要。 */
  bot_state: {
    /** 当前生命值。 */
    health: number;
    /** 当前是否着火。 */
    is_on_fire: boolean;
    /** 当前 Y 轴速度。 */
    y_velocity: number;
    /** 当前是否装备武器。 */
    has_weapon_equipped: boolean;
  };
}

/** reflex 中断来源结构，用于与 runtime 的 InterruptSource 直接复用。 */
export interface ReflexInterruptSource {
  /** 中断来源类型。 */
  type: "reflex";
  /** 对应的威胁评估结果。 */
  threat: ThreatAssessment;
}

/** 只读世界观察边界，用于支撑后续 api.world 代理。 */
export interface ObservationWorldView {
  /** 查找附近方块。 */
  nearestBlocks(
    blockName: string,
    radius?: number,
    maxCount?: number,
  ): readonly NearbyBlockSummary[];
  /** 查找附近实体。 */
  nearestEntities(kind?: NearbyEntityKind, radius?: number): readonly NearbyEntitySummary[];
  /** 获取指定坐标处的方块摘要。 */
  blockAt(position: SnapshotPosition): NearbyBlockSummary | null;
}

/** 只读主人观察边界，用于支撑后续 api.owner 代理。 */
export interface ObservationOwnerView {
  /** 获取最新主人快照。 */
  getOwnerSnapshot(): OwnerSnapshot | null;
}

/** observation 快照读取器，用于为只读边界提供读取时的当前值。 */
export interface ObservationSnapshotSource {
  /** 获取读取时的最新环境快照。 */
  getCurrentSnapshot(): EnvironmentSnapshot;
}

/** observation 只读边界，用于统一快照读取与威胁评估。 */
export interface ObservationReadBoundary extends ObservationOwnerView {
  /** 获取最新环境快照副本。 */
  getSnapshot(): EnvironmentSnapshot;
  /** 获取只读世界视图。 */
  getWorldView(): ObservationWorldView;
}
