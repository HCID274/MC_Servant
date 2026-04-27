/**
 * 世界模型契约与资源查询协议。
 *
 * 1. 资源抽象：定义 ResourceProfile 和 ResourceClusterSummary，将底层方块数据抽象为高层的“资源”概念。
 * 2. 空间语义：定义 ResourceBlockCandidate，包含位置、距离、可见性及启发式评分。
 * 3. 读写分离：通过 QueryBoundary 和 RefreshBoundary 接口，明确区分对认知的只读查询与更新操作。
 * 4. 决策支持：定义结果结构，为 Bot 决定去哪里采集资源提供结构化参考。
 */

import type { SnapshotPosition } from "../observation/contracts.js";

/** 资源画像，用于声明某类资源的查询参数边界。 */
export interface ResourceProfile {
  /** 资源键。 */
  readonly resource_key: string;
  /** 资源对应的标准方块标识列表。 */
  readonly block_names: readonly string[];
  /** 查询半径。 */
  readonly search_radius: number;
  /** 聚类半径。 */
  readonly cluster_radius: number;
  /** 返回的最大候选数。 */
  readonly max_candidates: number;
}

/** 资源候选块，用于表达 world-model 查询阶段的局部结果。 */
export interface ResourceBlockCandidate {
  /** 标准方块标识。 */
  readonly block_name: string;
  /** 方块坐标。 */
  readonly position: Readonly<SnapshotPosition>;
  /** 与查询锚点的距离。 */
  readonly distance: number;
  /** 当前候选分数。 */
  readonly score: number;
  /** 是否可直接接触。 */
  readonly is_exposed: boolean;
}

/** 资源簇摘要，用于表达同类资源的局部聚类结果。 */
export interface ResourceClusterSummary {
  /** 资源键。 */
  readonly resource_key: string;
  /** 资源簇标识。 */
  readonly cluster_id: string;
  /** 生成该摘要时的快照版本。 */
  readonly snapshot_version: string;
  /** 资源簇中心点。 */
  readonly centroid: Readonly<SnapshotPosition>;
  /** 资源块数量。 */
  readonly block_count: number;
  /** 最近距离。 */
  readonly nearest_distance: number;
  /** 平均距离。 */
  readonly average_distance: number;
  /** 当前簇内候选块。 */
  readonly candidates: readonly ResourceBlockCandidate[];
}

/** 最优簇查询结果，用于表达 queryBestCluster 的返回结构。 */
export interface BestResourceClusterResult {
  /** 资源画像。 */
  readonly profile: ResourceProfile;
  /** 被选中的资源簇。 */
  readonly cluster: ResourceClusterSummary;
  /** 综合评分。 */
  readonly score: number;
  /** 选择原因。 */
  readonly reason: string;
}

/** 候选块选择结果，用于表达 selectBestBlock 的只读返回。 */
export interface CandidateBlockSelectionResult {
  /** 来源资源簇标识。 */
  readonly cluster_id: string;
  /** 被选中的候选块。 */
  readonly candidate: ResourceBlockCandidate;
  /** 选择原因。 */
  readonly reason: string;
}

/** world-model 查询上下文，用于隔离 query 与 refresh 的输入边界。 */
export interface WorldModelQueryContext {
  /** 当前查询锚点。 */
  readonly anchor: Readonly<SnapshotPosition>;
  /** 当前快照版本。 */
  readonly snapshot_version: string;
  /** 当前可见资源簇。 */
  readonly clusters: readonly ResourceClusterSummary[];
}

/** world-model 查询边界，用于表达只读 query 接口。 */
export interface WorldModelQueryBoundary {
  /** 查询指定资源键的资源簇列表。 */
  queryClusters(resourceKey: string, maxCount?: number): readonly ResourceClusterSummary[];
  /** 查询最优资源簇。 */
  queryBestCluster(profile: ResourceProfile): BestResourceClusterResult | null;
  /** 从给定资源簇中选择最佳候选块。 */
  selectBestBlock(cluster: ResourceClusterSummary): CandidateBlockSelectionResult | null;
}

/** world-model 刷新原因，用于显式声明 refresh 入口与 query 分离。 */
export type WorldModelRefreshReason = "stale_snapshot" | "cache_miss" | "manual";

/** world-model 刷新请求，用于声明未来 refresh 的独立契约。 */
export interface WorldModelRefreshRequest {
  /** 触发刷新时看到的快照版本。 */
  snapshot_version: string;
  /** 需要刷新的资源键。 */
  resource_key: string;
  /** 刷新原因。 */
  reason: WorldModelRefreshReason;
}

/** world-model 刷新边界，用于保留未来扫描实现的独立入口。 */
export interface WorldModelRefreshBoundary {
  /** 请求刷新资源缓存。 */
  refresh(request: WorldModelRefreshRequest): Promise<never>;
}

/** Minecraft（我的世界）方块事实快照，用于封装 minecraft-data 的只读方块基础字段。 */
export interface MinecraftBlockFact {
  /** 数字标识。 */
  readonly id: number;
  /** 标准英文名称。 */
  readonly name: string;
  /** 展示名称。 */
  readonly display_name: string;
  /** 堆叠数量上限。 */
  readonly stack_size: number;
  /** 硬度；不存在时为 null。 */
  readonly hardness: number | null;
  /** 爆炸抗性；不存在时为 null。 */
  readonly resistance: number | null;
  /** 是否可被挖掘。 */
  readonly diggable: boolean;
  /** 材质分类；不存在时为 null。 */
  readonly material: string | null;
  /** 是否透明。 */
  readonly transparent: boolean;
  /** 发光等级。 */
  readonly emit_light: number;
  /** 滤光等级。 */
  readonly filter_light: number;
  /** 默认状态标识；不存在时为 null。 */
  readonly default_state: number | null;
  /** 最小状态标识；不存在时为 null。 */
  readonly min_state_id: number | null;
  /** 最大状态标识；不存在时为 null。 */
  readonly max_state_id: number | null;
  /** 掉落物数字标识列表。 */
  readonly drops: readonly number[];
  /** 碰撞盒类型；不存在时为 null。 */
  readonly bounding_box: string | null;
}

/** Minecraft（我的世界）物品事实快照，用于封装 minecraft-data 的只读物品基础字段。 */
export interface MinecraftItemFact {
  /** 数字标识。 */
  readonly id: number;
  /** 标准英文名称。 */
  readonly name: string;
  /** 展示名称。 */
  readonly display_name: string;
  /** 堆叠数量上限。 */
  readonly stack_size: number;
}

/** Minecraft（我的世界）配方产出快照。 */
export interface MinecraftRecipeResultFact {
  /** 产出物品数字标识。 */
  readonly id: number;
  /** 产出物品标准英文名称。 */
  readonly name: string;
  /** 产出数量。 */
  readonly count: number;
}

/** Minecraft（我的世界）配方事实快照，用于只读表达 minecraft-data 中的基础配方结构。 */
export interface MinecraftRecipeFact {
  /** 产出物品。 */
  readonly result: MinecraftRecipeResultFact;
  /** 无形配方原料数字标识列表。 */
  readonly ingredients: readonly number[];
  /** 有形配方输入形状。 */
  readonly in_shape: readonly (readonly number[])[];
  /** 有形配方额外输出形状。 */
  readonly out_shape: readonly (readonly number[])[];
}

/** Minecraft（我的世界）事实查询端口，用于按版本查询本地 minecraft-data 注册表。 */
export interface MinecraftFactsQueryPort {
  /** 已绑定的 Minecraft（我的世界）版本。 */
  readonly version: string;
  /** 按标准名称查询方块。 */
  getBlockByName(name: string): MinecraftBlockFact | null;
  /** 按数字标识查询方块。 */
  getBlockById(id: number): MinecraftBlockFact | null;
  /** 按标准名称查询物品。 */
  getItemByName(name: string): MinecraftItemFact | null;
  /** 按数字标识查询物品。 */
  getItemById(id: number): MinecraftItemFact | null;
  /** 按产出物品标准名称查询配方。 */
  queryRecipesByResultName(resultItemName: string): readonly MinecraftRecipeFact[];
}
