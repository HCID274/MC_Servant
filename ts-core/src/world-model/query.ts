/**
 * 世界模型查询逻辑与评分算法。
 *
 * 1. 资源评分：实现 scoreCluster 启发式算法，根据资源密度和距离评估资源簇价值。
 * 2. 候选块筛选：实现优先级筛选逻辑，优先选择暴露且分数高的方块。
 * 3. 稳压查询：提供基于上下文的纯函数查询，确保结果与快照一致且不可变。
 * 4. 边界封装：提供查询和刷新边界的具体实现，维护读写分离架构。
 */

import { RESOURCE_REFRESH_RADIUS_STEPS } from "../core-ports/runtime.js";
import type {
  ResourceRefreshRadius,
  RuntimeResourceBlockSummary,
  RuntimeResourceRefreshResult,
} from "../core-ports/runtime.js";
import type { SnapshotPosition } from "../observation/contracts.js";
import type {
  AcceptedTreeCluster,
  BestResourceClusterResult,
  CandidateBlockSelectionResult,
  RejectedTreeCluster,
  ResourceBlockCandidate,
  ResourceCacheBlockChange,
  ResourceClusterQueryResult,
  ResourceClusterSummary,
  ResourceProfile,
  ResourceServiceBoundary,
  ResourceServiceCacheUpdateResult,
  ResourceServiceRefreshPort,
  ResourceServiceRefreshResult,
  ResourceWorldKeyPort,
  TreeClusterClassificationResult,
  TreeClusterSelectionResult,
  TreeClusterSelectionStatus,
  WorldModelQueryBoundary,
  WorldModelQueryContext,
  WorldModelRefreshBoundary,
  WorldModelRefreshRequest,
} from "./contracts.js";

const DEFAULT_RESOURCE_SERVICE_STALE_AFTER_MS = 60_000;
const DEFAULT_RESOURCE_PLANNER_SUMMARY_LIMIT = 2;
const AIR_BLOCK_NAMES = new Set(["air", "cave_air", "void_air"]);
const RESOURCE_CLUSTER_NEIGHBOR_OFFSETS = Object.freeze(
  [-1, 0, 1].flatMap((x) =>
    [-1, 0, 1].flatMap((y) =>
      [-1, 0, 1]
        .filter((z) => !(x === 0 && y === 0 && z === 0))
        .map((z) => Object.freeze({ x, y, z })),
    ),
  ),
);

interface ClusterableResourceBlock {
  readonly block_name: string;
  readonly position: Readonly<SnapshotPosition>;
  readonly distance: number;
}

interface MutableResourceServiceCacheEntry {
  resource_key: string;
  world_key: string;
  snapshot_version: string;
  refresh_radius: ResourceRefreshRadius;
  refreshed_at: number;
  clusters: readonly ResourceClusterSummary[];
  diagnostics: readonly string[];
}
/** 浅度冻结只读数组。 */

function freezeReadonlyArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
/** 冻结快照坐标对象。 */

function freezePosition(position: SnapshotPosition): Readonly<SnapshotPosition> {
  return Object.freeze({
    x: position.x,
    y: position.y,
    z: position.z,
  });
}
/** 克隆资源候选块数据。 */

function cloneCandidate(candidate: ResourceBlockCandidate): ResourceBlockCandidate {
  return Object.freeze({
    ...candidate,
    position: freezePosition(candidate.position),
    semantic_roles: freezeReadonlyArray(candidate.semantic_roles ?? []),
    is_diggable: candidate.is_diggable ?? false,
    is_reachable: candidate.is_reachable ?? false,
    target_diagnostics: freezeReadonlyArray(candidate.target_diagnostics ?? []),
  });
}

function cloneNullableCandidate(
  candidate: ResourceBlockCandidate | null,
): ResourceBlockCandidate | null {
  return candidate === null ? null : cloneCandidate(candidate);
}

/** 克隆整个资源簇摘要及其候选者。 */

function cloneCluster(cluster: ResourceClusterSummary): ResourceClusterSummary {
  return Object.freeze({
    ...cluster,
    centroid: freezePosition(cluster.centroid),
    blocks: freezeReadonlyArray(cluster.blocks.map((position) => freezePosition(position))),
    recommended_candidate: cloneNullableCandidate(cluster.recommended_candidate),
    candidates: freezeReadonlyArray(
      cluster.candidates.map((candidate) => cloneCandidate(candidate)),
    ),
  });
}

/** 克隆资源索引查询结果。 */
function cloneResourceClusterQueryResult(
  result: ResourceClusterQueryResult,
): ResourceClusterQueryResult {
  return Object.freeze({
    ...result,
    clusters: freezeReadonlyArray(result.clusters.map((cluster) => cloneCluster(cluster))),
    diagnostics: freezeReadonlyArray(result.diagnostics),
  });
}

/** 克隆资源服务刷新结果。 */
function cloneResourceServiceRefreshResult(
  result: ResourceServiceRefreshResult,
): ResourceServiceRefreshResult {
  return Object.freeze({
    ...result,
    clusters: freezeReadonlyArray(result.clusters.map((cluster) => cloneCluster(cluster))),
    diagnostics: freezeReadonlyArray(result.diagnostics),
  });
}

function cloneResourceServiceCacheUpdateResult(
  result: ResourceServiceCacheUpdateResult,
): ResourceServiceCacheUpdateResult {
  return Object.freeze({
    ...result,
    resource_keys: freezeReadonlyArray(result.resource_keys),
    diagnostics: freezeReadonlyArray(result.diagnostics),
  });
}

function cloneAcceptedTreeCluster(cluster: AcceptedTreeCluster): AcceptedTreeCluster {
  return Object.freeze({
    ...cluster,
    logs: freezeReadonlyArray(cluster.logs.map((position) => freezePosition(position))),
    recommended_target: cloneCandidate(cluster.recommended_target),
  });
}

function cloneRejectedTreeCluster(cluster: RejectedTreeCluster): RejectedTreeCluster {
  return Object.freeze({
    ...cluster,
  });
}

function cloneTreeClusterClassificationResult(
  result: TreeClusterClassificationResult,
): TreeClusterClassificationResult {
  return Object.freeze({
    ...result,
    accepted: freezeReadonlyArray(
      result.accepted.map((cluster) => cloneAcceptedTreeCluster(cluster)),
    ),
    rejected: freezeReadonlyArray(
      result.rejected.map((cluster) => cloneRejectedTreeCluster(cluster)),
    ),
    diagnostics: freezeReadonlyArray(result.diagnostics),
  });
}

function cloneTreeClusterSelectionResult(
  result: TreeClusterSelectionResult,
): TreeClusterSelectionResult {
  return Object.freeze({
    ...result,
    selected: freezeReadonlyArray(
      result.selected.map((cluster) => cloneAcceptedTreeCluster(cluster)),
    ),
    rejected: freezeReadonlyArray(
      result.rejected.map((cluster) => cloneRejectedTreeCluster(cluster)),
    ),
    refresh_attempts: freezeReadonlyArray(
      result.refresh_attempts.map((attempt) => cloneResourceServiceRefreshResult(attempt)),
    ),
    diagnostics: freezeReadonlyArray(result.diagnostics),
  });
}

/** 克隆资源画像配置。 */

function cloneProfile(profile: ResourceProfile): ResourceProfile {
  return Object.freeze({
    ...profile,
    block_names: freezeReadonlyArray(profile.block_names),
  });
}
/** 评估资源簇启发式分数。 */

function scoreCluster(cluster: ResourceClusterSummary): number {
  return cluster.block_count * 10 - cluster.average_distance - cluster.nearest_distance;
}

/** 按资源簇评分、距离与标识进行稳定排序。 */
function sortResourceClusters(
  clusters: readonly ResourceClusterSummary[],
): readonly ResourceClusterSummary[] {
  return freezeReadonlyArray(
    [...clusters].sort((left, right) => {
      const scoreDelta = scoreCluster(right) - scoreCluster(left);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      if (left.nearest_distance !== right.nearest_distance) {
        return left.nearest_distance - right.nearest_distance;
      }

      return left.cluster_id.localeCompare(right.cluster_id);
    }),
  );
}

/** 校验 ResourceService（世界感知资源服务） 半径阶梯。 */
function isResourceRefreshRadius(value: number): value is ResourceRefreshRadius {
  return RESOURCE_REFRESH_RADIUS_STEPS.includes(value as ResourceRefreshRadius);
}

/** 基于坐标计算三维距离。 */
function distanceBetween(left: SnapshotPosition, right: SnapshotPosition): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function comparePositions(left: SnapshotPosition, right: SnapshotPosition): number {
  if (left.x !== right.x) {
    return left.x - right.x;
  }

  if (left.y !== right.y) {
    return left.y - right.y;
  }

  return left.z - right.z;
}

function compareClusterableResourceBlocks(
  left: ClusterableResourceBlock,
  right: ClusterableResourceBlock,
): number {
  if (left.block_name !== right.block_name) {
    return left.block_name.localeCompare(right.block_name);
  }

  if (left.distance !== right.distance) {
    return left.distance - right.distance;
  }

  return comparePositions(left.position, right.position);
}

function compareResourceBlockGroups<T extends ClusterableResourceBlock>(
  left: readonly T[],
  right: readonly T[],
): number {
  const leftFirst = left[0];
  const rightFirst = right[0];

  if (leftFirst === undefined && rightFirst === undefined) {
    return 0;
  }

  if (leftFirst === undefined) {
    return 1;
  }

  if (rightFirst === undefined) {
    return -1;
  }

  return compareClusterableResourceBlocks(leftFirst, rightFirst);
}

function createPositionKey(position: SnapshotPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function createOffsetPositionKey(
  position: SnapshotPosition,
  offset: Readonly<SnapshotPosition>,
): string {
  return `${position.x + offset.x}:${position.y + offset.y}:${position.z + offset.z}`;
}

/** 计算候选块列表的中心点。 */
function calculateCentroid(candidates: readonly ResourceBlockCandidate[]): SnapshotPosition {
  const sum = candidates.reduce(
    (accumulator, candidate) => ({
      x: accumulator.x + candidate.position.x,
      y: accumulator.y + candidate.position.y,
      z: accumulator.z + candidate.position.z,
    }),
    { x: 0, y: 0, z: 0 },
  );

  return freezePosition({
    x: sum.x / candidates.length,
    y: sum.y / candidates.length,
    z: sum.z / candidates.length,
  });
}

/** 判断运行时扫描块是否属于指定资源键。 */
function runtimeBlockMatchesResourceKey(
  block: RuntimeResourceBlockSummary,
  resourceKey: string,
): boolean {
  return block.resource_keys.includes(resourceKey) || block.block_name === resourceKey;
}

/** 将运行时扫描块转换为资源候选块。 */
function createResourceCandidate(block: RuntimeResourceBlockSummary): ResourceBlockCandidate {
  return Object.freeze({
    block_name: block.block_name,
    position: freezePosition(block.position),
    distance: block.distance,
    score: Math.max(1, 64 - block.distance),
    is_exposed: block.is_reachable ?? false,
    semantic_roles: freezeReadonlyArray(block.semantic_roles ?? []),
    is_diggable: block.is_diggable ?? false,
    is_reachable: block.is_reachable ?? false,
    target_diagnostics: freezeReadonlyArray(block.target_diagnostics ?? []),
  });
}

/** 按具体方块类型和 26 邻域 BFS（广度优先搜索）提取连通块。 */
function groupConnectedResourceBlocks<T extends ClusterableResourceBlock>(
  blocks: readonly T[],
): readonly (readonly T[])[] {
  const blocksByName = new Map<string, T[]>();

  for (const block of [...blocks].sort(compareClusterableResourceBlocks)) {
    blocksByName.set(block.block_name, [...(blocksByName.get(block.block_name) ?? []), block]);
  }

  const connectedGroups: T[][] = [...blocksByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, sameNameBlocks]) => {
      const byPosition = new Map<string, T>();
      const sortedBlocks = sameNameBlocks.sort(compareClusterableResourceBlocks);

      for (const block of sortedBlocks) {
        const positionKey = createPositionKey(block.position);

        if (!byPosition.has(positionKey)) {
          byPosition.set(positionKey, block);
        }
      }

      const visited = new Set<string>();
      const groups: T[][] = [];

      for (const seed of sortedBlocks) {
        const seedKey = createPositionKey(seed.position);

        if (visited.has(seedKey)) {
          continue;
        }

        const group: T[] = [];
        const queue: T[] = [seed];
        visited.add(seedKey);

        while (queue.length > 0) {
          const current = queue.shift();

          if (current === undefined) {
            continue;
          }

          group.push(current);

          for (const offset of RESOURCE_CLUSTER_NEIGHBOR_OFFSETS) {
            const nextKey = createOffsetPositionKey(current.position, offset);

            if (visited.has(nextKey)) {
              continue;
            }

            const next = byPosition.get(nextKey);

            if (next === undefined) {
              continue;
            }

            visited.add(nextKey);
            queue.push(next);
          }
        }

        groups.push(group.sort(compareClusterableResourceBlocks));
      }

      return groups;
    });

  return freezeReadonlyArray(
    connectedGroups
      .sort((left, right) => compareResourceBlockGroups(left, right))
      .map((group) => freezeReadonlyArray(group)),
  );
}

function sortResourceCandidatesForDig(
  candidates: readonly ResourceBlockCandidate[],
): readonly ResourceBlockCandidate[] {
  return freezeReadonlyArray(
    [...candidates].sort((left, right) => {
      if (left.is_exposed !== right.is_exposed) {
        return Number(right.is_exposed) - Number(left.is_exposed);
      }

      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }

      return comparePositions(left.position, right.position);
    }),
  );
}

function selectRecommendedResourceCandidate(
  candidates: readonly ResourceBlockCandidate[],
): ResourceBlockCandidate | null {
  return sortResourceCandidatesForDig(candidates)[0] ?? null;
}

function isCutTreeLogCandidate(candidate: ResourceBlockCandidate): boolean {
  return candidate.semantic_roles.includes("cut_tree_log");
}

function isLegalCutTreeCandidate(candidate: ResourceBlockCandidate): boolean {
  return isCutTreeLogCandidate(candidate) && candidate.is_diggable === true;
}

function sortAcceptedTreeClusters(
  clusters: readonly AcceptedTreeCluster[],
): readonly AcceptedTreeCluster[] {
  return freezeReadonlyArray(
    [...clusters].sort((left, right) => {
      if (left.recommended_target.distance !== right.recommended_target.distance) {
        return left.recommended_target.distance - right.recommended_target.distance;
      }

      if (left.log_count !== right.log_count) {
        return right.log_count - left.log_count;
      }

      return left.cluster_id.localeCompare(right.cluster_id);
    }),
  );
}

function classifyTreeResourceClusters(input: {
  readonly query: ResourceClusterQueryResult;
}): TreeClusterClassificationResult {
  const accepted: AcceptedTreeCluster[] = [];
  const rejected: RejectedTreeCluster[] = [];

  for (const cluster of input.query.clusters) {
    const logCandidates = cluster.candidates.filter((candidate) =>
      isCutTreeLogCandidate(candidate),
    );

    if (logCandidates.length === 0) {
      rejected.push(
        Object.freeze({
          cluster_id: cluster.cluster_id,
          world_key: cluster.world_key ?? input.query.world_key,
          snapshot_version: cluster.snapshot_version,
          block_name: cluster.block_name,
          candidate_count: cluster.candidates.length,
          reason: "not_cut_tree_log",
        }),
      );
      continue;
    }

    if (cluster.block_count <= 0 || logCandidates.length === 0) {
      rejected.push(
        Object.freeze({
          cluster_id: cluster.cluster_id,
          world_key: cluster.world_key ?? input.query.world_key,
          snapshot_version: cluster.snapshot_version,
          block_name: cluster.block_name,
          candidate_count: cluster.candidates.length,
          reason: "empty_log_cluster",
        }),
      );
      continue;
    }

    if (!logCandidates.some((candidate) => candidate.is_diggable)) {
      rejected.push(
        Object.freeze({
          cluster_id: cluster.cluster_id,
          world_key: cluster.world_key ?? input.query.world_key,
          snapshot_version: cluster.snapshot_version,
          block_name: cluster.block_name,
          candidate_count: cluster.candidates.length,
          reason: "not_diggable",
        }),
      );
      continue;
    }

    const recommendedTarget = selectLowestLegalTreeCandidate(
      logCandidates.filter((candidate) => isLegalCutTreeCandidate(candidate)),
    );

    if (recommendedTarget === null) {
      rejected.push(
        Object.freeze({
          cluster_id: cluster.cluster_id,
          world_key: cluster.world_key ?? input.query.world_key,
          snapshot_version: cluster.snapshot_version,
          block_name: cluster.block_name,
          candidate_count: cluster.candidates.length,
          reason: "missing_recommended_target",
        }),
      );
      continue;
    }

    accepted.push(
      Object.freeze({
        cluster_id: cluster.cluster_id,
        world_key: cluster.world_key ?? input.query.world_key,
        snapshot_version: cluster.snapshot_version,
        log_block_name: cluster.block_name,
        logs: freezeReadonlyArray(
          logCandidates.map((candidate) => freezePosition(candidate.position)),
        ),
        log_count: logCandidates.length,
        recommended_target: cloneCandidate(recommendedTarget),
        reason: "diggable_cut_tree_log",
      }),
    );
  }

  return cloneTreeClusterClassificationResult({
    status: input.query.status,
    world_key: input.query.world_key,
    snapshot_version: input.query.snapshot_version,
    accepted: sortAcceptedTreeClusters(accepted),
    rejected: freezeReadonlyArray(rejected),
    diagnostics: input.query.diagnostics,
  });
}

function selectLowestLegalTreeCandidate(
  candidates: readonly ResourceBlockCandidate[],
): ResourceBlockCandidate | null {
  return (
    [...candidates].sort((left, right) => {
      if (left.position.y !== right.position.y) {
        return left.position.y - right.position.y;
      }

      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }

      return comparePositions(left.position, right.position);
    })[0] ?? null
  );
}

function createResourceClusterFromCandidates(input: {
  readonly resourceKey: string;
  readonly worldKey: string;
  readonly snapshotVersion: string;
  readonly refreshRadius: ResourceRefreshRadius;
  readonly refreshedAt: number;
  readonly clusterIndex: number;
  readonly candidates: readonly ResourceBlockCandidate[];
}): ResourceClusterSummary {
  const candidates = freezeReadonlyArray(
    [...input.candidates]
      .sort(compareClusterableResourceBlocks)
      .map((candidate) => cloneCandidate(candidate)),
  );
  const centroid = calculateCentroid(candidates);
  const nearestDistance = Math.min(...candidates.map((candidate) => candidate.distance));
  const averageDistance =
    candidates.reduce((sum, candidate) => sum + candidate.distance, 0) / candidates.length;
  const blockName = candidates[0]?.block_name ?? "unknown";

  return cloneCluster({
    resource_key: input.resourceKey,
    cluster_id: `${input.worldKey}:${input.resourceKey}:${blockName}:${input.refreshRadius}:${input.clusterIndex}:${Math.round(centroid.x)}:${Math.round(centroid.y)}:${Math.round(centroid.z)}`,
    snapshot_version: input.snapshotVersion,
    world_key: input.worldKey,
    block_name: blockName,
    refresh_radius: input.refreshRadius,
    refreshed_at: input.refreshedAt,
    centroid,
    blocks: freezeReadonlyArray(candidates.map((candidate) => freezePosition(candidate.position))),
    block_count: candidates.length,
    nearest_distance: nearestDistance,
    average_distance: averageDistance,
    recommended_candidate: selectRecommendedResourceCandidate(candidates),
    candidates,
  });
}

function rebuildResourceClustersFromCandidates(input: {
  readonly resourceKey: string;
  readonly worldKey: string;
  readonly snapshotVersion: string;
  readonly refreshRadius: ResourceRefreshRadius;
  readonly refreshedAt: number;
  readonly candidates: readonly ResourceBlockCandidate[];
}): readonly ResourceClusterSummary[] {
  return sortResourceClusters(
    groupConnectedResourceBlocks(input.candidates).map((group, index) =>
      createResourceClusterFromCandidates({
        ...input,
        clusterIndex: index + 1,
        candidates: group,
      }),
    ),
  );
}

/** 从运行时刷新结果构建资源簇。 */
export function createResourceClustersFromRuntimeRefresh(
  refresh: RuntimeResourceRefreshResult,
): readonly ResourceClusterSummary[] {
  const candidates = refresh.blocks
    .filter((candidate) => runtimeBlockMatchesResourceKey(candidate, refresh.resource_key))
    .map((block) => createResourceCandidate(block));

  return rebuildResourceClustersFromCandidates({
    resourceKey: refresh.resource_key,
    worldKey: refresh.world_key,
    snapshotVersion: refresh.snapshot_version,
    refreshRadius: refresh.radius,
    refreshedAt: refresh.scanned_at,
    candidates,
  });
}

/**
 * 查询指定资源键的资源簇列表。
 *
 * 从上下文中筛选出属于当前快照版本且匹配资源键的簇，按评分降序排列并返回冻结的副本，作为资源检索的基础。
 *
 * @param input 包含查询上下文、资源键和最大数量限制的输入
 * @returns 排序后的资源簇摘要列表
 */
export function queryResourceClusters(input: {
  context: WorldModelQueryContext;
  resourceKey: string;
  maxCount?: number;
}): readonly ResourceClusterSummary[] {
  const maxCount = input.maxCount ?? input.context.clusters.length;

  return freezeReadonlyArray(
    input.context.clusters
      .filter(
        (cluster) =>
          cluster.resource_key === input.resourceKey &&
          cluster.snapshot_version === input.context.snapshot_version,
      )
      .sort((left, right) => scoreCluster(right) - scoreCluster(left))
      .slice(0, maxCount)
      .map((cluster) => cloneCluster(cluster)),
  );
}

/**
 * 查询最优资源簇。
 *
 * 作为一个“选优器”，接收定义了检索逻辑的资源画像，返回评分最高的一个资源簇摘要，为上层决策提供直接的领域模型结果。
 *
 * @param input 包含查询上下文和资源画像的输入
 * @returns 最优簇结果或 null
 */
export function queryBestResourceCluster(input: {
  context: WorldModelQueryContext;
  profile: ResourceProfile;
}): BestResourceClusterResult | null {
  const matchedClusters = queryResourceClusters({
    context: input.context,
    resourceKey: input.profile.resource_key,
  });

  const bestCluster = matchedClusters[0];

  if (!bestCluster) {
    return null;
  }

  return Object.freeze({
    profile: cloneProfile(input.profile),
    cluster: cloneCluster(bestCluster),
    score: scoreCluster(bestCluster),
    reason: "highest_cluster_score",
  });
}

/**
 * 选择资源簇中的最佳候选块。
 *
 * 1. 暴露优先：优先选择 is_exposed 为 true 的块，易于触达。
 * 2. 分数优先：在同样可见的情况下，选择启发式评分最高的块。
 * 3. 距离优先：最后选择距离 Bot 最近的块。
 *
 * @param input 包含资源簇摘要的输入
 * @returns 选中的候选块详情或 null
 */
export function selectBestClusterCandidate(input: {
  cluster: ResourceClusterSummary;
}): CandidateBlockSelectionResult | null {
  const candidate =
    input.cluster.recommended_candidate ??
    sortResourceCandidatesForDig(input.cluster.candidates)[0];

  if (!candidate) {
    return null;
  }

  return Object.freeze({
    cluster_id: input.cluster.cluster_id,
    candidate: cloneCandidate(candidate),
    reason: candidate.is_exposed ? "prefer_exposed_candidate" : "prefer_highest_score_candidate",
  });
}

/**
 * 创建世界模型的只读查询边界。
 *
 * 作为 WorldModel 模块的对外只读接口，通过封装当前上下文向上层提供标准化的查询方法，屏蔽底层算法细节。
 *
 * @param context 当前查询上下文
 * @returns 完整的只读查询边界对象
 */
export function createWorldModelQueryBoundary(
  context: WorldModelQueryContext,
): WorldModelQueryBoundary {
  return Object.freeze({
    queryClusters(resourceKey: string, maxCount?: number) {
      return queryResourceClusters(
        maxCount === undefined
          ? {
              context,
              resourceKey,
            }
          : {
              context,
              resourceKey,
              maxCount,
            },
      );
    },
    queryBestCluster(profile: ResourceProfile) {
      return queryBestResourceCluster({
        context,
        profile,
      });
    },
    selectBestBlock(cluster: ResourceClusterSummary) {
      return selectBestClusterCandidate({
        cluster,
      });
    },
  });
}

/** 创建 ResourceService（世界感知资源服务） 缓存与查询边界。 */
export function createResourceService(
  input: {
    /** runtime（运行时） 只读刷新端口。 */
    readonly refreshPort?: ResourceServiceRefreshPort;
    /** 当前世界解析端口；生产环境必须由 transport（传输层） 提供。 */
    readonly worldKeyPort?: ResourceWorldKeyPort;
    /** 可注入当前时间。 */
    readonly now?: () => number;
    /** 缓存过期毫秒数。 */
    readonly staleAfterMs?: number;
    /** 初始资源簇。 */
    readonly initialClusters?: readonly ResourceClusterSummary[];
  } = {},
): ResourceServiceBoundary {
  const now = input.now ?? Date.now;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_RESOURCE_SERVICE_STALE_AFTER_MS;
  const cache = new Map<string, MutableResourceServiceCacheEntry>();
  const readWorldKey = () => input.worldKeyPort?.getCurrentWorldKey() ?? "unknown";

  for (const cluster of input.initialClusters ?? []) {
    const worldKey = cluster.world_key ?? readWorldKey();
    const cacheKey = createResourceCacheKey(worldKey, cluster.resource_key);
    const existing = cache.get(cacheKey);
    const refreshedAt = cluster.refreshed_at ?? now();
    const entry: MutableResourceServiceCacheEntry = existing ?? {
      resource_key: cluster.resource_key,
      world_key: worldKey,
      snapshot_version: cluster.snapshot_version,
      refresh_radius: cluster.refresh_radius ?? 16,
      refreshed_at: refreshedAt,
      clusters: [],
      diagnostics: [],
    };

    entry.clusters = sortResourceClusters([...entry.clusters, cloneCluster(cluster)]);
    entry.refreshed_at = Math.max(entry.refreshed_at, refreshedAt);
    cache.set(cacheKey, entry);
  }

  const query = (resourceKey: string, maxCount?: number): ResourceClusterQueryResult => {
    const worldKey = readWorldKey();
    const entry = cache.get(createResourceCacheKey(worldKey, resourceKey));

    if (entry === undefined) {
      return cloneResourceClusterQueryResult({
        resource_key: resourceKey,
        status: "cache_miss",
        world_key: worldKey,
        snapshot_version: null,
        refresh_radius: null,
        refreshed_at: null,
        clusters: [],
        diagnostics: ["cache_miss"],
      });
    }

    const stale = now() - entry.refreshed_at > staleAfterMs;
    const sortedClusters = sortResourceClusters(entry.clusters);

    return cloneResourceClusterQueryResult({
      resource_key: resourceKey,
      status: stale ? "stale_snapshot" : sortedClusters.length > 0 ? "found" : "cache_miss",
      world_key: entry.world_key,
      snapshot_version: entry.snapshot_version,
      refresh_radius: entry.refresh_radius,
      refreshed_at: entry.refreshed_at,
      clusters: sortedClusters.slice(0, maxCount ?? sortedClusters.length),
      diagnostics: stale ? ["stale_snapshot", ...entry.diagnostics] : entry.diagnostics,
    });
  };

  const refreshResource = async (
    resourceKey: string,
    radius: ResourceRefreshRadius,
  ): Promise<ResourceServiceRefreshResult> => {
    const currentWorldKey = readWorldKey();

    if (!isResourceRefreshRadius(radius)) {
      return cloneResourceServiceRefreshResult({
        resource_key: resourceKey,
        radius: null,
        status: "invalid_radius",
        world_key: currentWorldKey,
        snapshot_version: null,
        refreshed_at: null,
        clusters: [],
        diagnostics: [`invalid_radius:${String(radius)}`],
      });
    }

    if (input.refreshPort === undefined) {
      return cloneResourceServiceRefreshResult({
        resource_key: resourceKey,
        radius,
        status: "runtime_unavailable",
        world_key: currentWorldKey,
        snapshot_version: null,
        refreshed_at: null,
        clusters: [],
        diagnostics: ["runtime_unavailable"],
      });
    }

    let refresh: RuntimeResourceRefreshResult;

    try {
      refresh = await input.refreshPort.refreshAroundBot(resourceKey, radius);
    } catch (error) {
      return cloneResourceServiceRefreshResult({
        resource_key: resourceKey,
        radius,
        status: "runtime_unavailable",
        world_key: currentWorldKey,
        snapshot_version: null,
        refreshed_at: null,
        clusters: [],
        diagnostics: ["runtime_unavailable", `refresh_port_failed:${formatUnknownError(error)}`],
      });
    }

    const clusters = createResourceClustersFromRuntimeRefresh(refresh);
    const result: ResourceServiceRefreshResult = {
      resource_key: resourceKey,
      radius,
      status: refresh.status,
      world_key: refresh.world_key,
      snapshot_version: refresh.snapshot_version,
      refreshed_at: refresh.scanned_at,
      clusters,
      diagnostics: refresh.diagnostics,
    };

    cache.set(createResourceCacheKey(refresh.world_key, resourceKey), {
      resource_key: resourceKey,
      world_key: refresh.world_key,
      snapshot_version: refresh.snapshot_version,
      refresh_radius: radius,
      refreshed_at: refresh.scanned_at,
      clusters,
      diagnostics: refresh.diagnostics,
    });

    return cloneResourceServiceRefreshResult(result);
  };

  const classifyTrees = () => classifyTreeResourceClusters({ query: query("tree") });

  const selectAcceptedTrees = (
    accepted: readonly AcceptedTreeCluster[],
    requiredLogCount: number,
  ): readonly AcceptedTreeCluster[] => {
    const nearestSufficientCluster = accepted.find(
      (cluster) => cluster.log_count >= requiredLogCount,
    );

    if (nearestSufficientCluster !== undefined) {
      return freezeReadonlyArray([nearestSufficientCluster]);
    }

    let selectedLogCount = 0;
    const selected: AcceptedTreeCluster[] = [];

    for (const cluster of accepted) {
      if (selectedLogCount >= requiredLogCount) {
        break;
      }

      selected.push(cluster);
      selectedLogCount += cluster.log_count;
    }

    return freezeReadonlyArray(selected);
  };

  const createTreeSelectionResult = (input: {
    readonly status: TreeClusterSelectionStatus;
    readonly classification: TreeClusterClassificationResult;
    readonly requiredLogCount: number;
    readonly selected: readonly AcceptedTreeCluster[];
    readonly refreshAttempts: readonly ResourceServiceRefreshResult[];
    readonly diagnostics: readonly string[];
  }): TreeClusterSelectionResult => {
    const selectedLogCount = input.selected.reduce((sum, cluster) => sum + cluster.log_count, 0);

    return cloneTreeClusterSelectionResult({
      status: input.status,
      world_key: input.classification.world_key,
      required_log_count: input.requiredLogCount,
      selected_log_count: selectedLogCount,
      selected: input.selected,
      rejected: input.classification.rejected,
      refresh_attempts: input.refreshAttempts,
      diagnostics: input.diagnostics,
    });
  };

  return Object.freeze({
    query,
    refresh: refreshResource,
    applyBlockChanges(
      changes: readonly ResourceCacheBlockChange[],
    ): ResourceServiceCacheUpdateResult {
      const worldKey = readWorldKey();
      const changeByPosition = new Map(
        changes.map((change) => [createPositionKey(change.position), change] as const),
      );

      if (changeByPosition.size === 0) {
        return cloneResourceServiceCacheUpdateResult({
          world_key: worldKey,
          resource_keys: [],
          removed_block_count: 0,
          deleted_cluster_count: 0,
          split_cluster_count: 0,
          diagnostics: ["no_block_changes"],
        });
      }

      const affectedResourceKeys: string[] = [];
      let removedBlockCount = 0;
      let deletedClusterCount = 0;
      let splitClusterCount = 0;

      for (const [cacheKey, entry] of [...cache.entries()]) {
        if (entry.world_key !== worldKey) {
          continue;
        }

        const remainingCandidates: ResourceBlockCandidate[] = [];
        let entryChanged = false;
        let nonEmptyOriginalClusterCount = 0;

        for (const cluster of entry.clusters) {
          let clusterRemainingCount = 0;

          for (const candidate of cluster.candidates) {
            const change = changeByPosition.get(createPositionKey(candidate.position));

            if (change !== undefined && blockChangeRemovesCandidate(candidate, change)) {
              removedBlockCount += 1;
              entryChanged = true;
              continue;
            }

            clusterRemainingCount += 1;
            remainingCandidates.push(candidate);
          }

          if (clusterRemainingCount === 0 && cluster.candidates.length > 0) {
            deletedClusterCount += 1;
          } else if (clusterRemainingCount > 0) {
            nonEmptyOriginalClusterCount += 1;
          }
        }

        if (!entryChanged) {
          continue;
        }

        affectedResourceKeys.push(entry.resource_key);

        if (remainingCandidates.length === 0) {
          cache.delete(cacheKey);
          continue;
        }

        const updatedAt = now();
        const snapshotVersion = `${entry.snapshot_version}:block_change:${updatedAt}`;
        const clusters = rebuildResourceClustersFromCandidates({
          resourceKey: entry.resource_key,
          worldKey: entry.world_key,
          snapshotVersion,
          refreshRadius: entry.refresh_radius,
          refreshedAt: updatedAt,
          candidates: remainingCandidates,
        });

        splitClusterCount += Math.max(0, clusters.length - nonEmptyOriginalClusterCount);

        cache.set(cacheKey, {
          resource_key: entry.resource_key,
          world_key: entry.world_key,
          snapshot_version: snapshotVersion,
          refresh_radius: entry.refresh_radius,
          refreshed_at: updatedAt,
          clusters,
          diagnostics: [
            ...entry.diagnostics.filter((diagnostic) => diagnostic !== "cache_miss"),
            `resource_cache_updated:removed=${removedBlockCount}`,
          ],
        });
      }

      return cloneResourceServiceCacheUpdateResult({
        world_key: worldKey,
        resource_keys: affectedResourceKeys,
        removed_block_count: removedBlockCount,
        deleted_cluster_count: deletedClusterCount,
        split_cluster_count: splitClusterCount,
        diagnostics:
          removedBlockCount > 0
            ? ["resource_cache_updated"]
            : ["no_cached_resource_blocks_changed"],
      });
    },
    classifyTreeClusters(): TreeClusterClassificationResult {
      return classifyTrees();
    },
    async selectTreeClusters(requiredLogCount: number): Promise<TreeClusterSelectionResult> {
      if (!Number.isSafeInteger(requiredLogCount) || requiredLogCount <= 0) {
        return cloneTreeClusterSelectionResult({
          status: "invalid_request",
          world_key: readWorldKey(),
          required_log_count: requiredLogCount,
          selected_log_count: 0,
          selected: [],
          rejected: [],
          refresh_attempts: [],
          diagnostics: [`invalid_required_log_count:${String(requiredLogCount)}`],
        });
      }

      let classification = classifyTrees();
      let selected = selectAcceptedTrees(classification.accepted, requiredLogCount);
      const refreshAttempts: ResourceServiceRefreshResult[] = [];

      if (
        classification.status === "found" &&
        selected.reduce((sum, cluster) => sum + cluster.log_count, 0) >= requiredLogCount
      ) {
        return createTreeSelectionResult({
          status: "selected",
          classification,
          requiredLogCount,
          selected,
          refreshAttempts,
          diagnostics: ["selected_from_cache"],
        });
      }

      for (const radius of RESOURCE_REFRESH_RADIUS_STEPS) {
        const refresh = await refreshResource("tree", radius);
        refreshAttempts.push(refresh);
        classification = classifyTrees();
        selected = selectAcceptedTrees(classification.accepted, requiredLogCount);

        const selectedLogCount = selected.reduce((sum, cluster) => sum + cluster.log_count, 0);

        if (selectedLogCount >= requiredLogCount) {
          return createTreeSelectionResult({
            status: "selected",
            classification,
            requiredLogCount,
            selected,
            refreshAttempts,
            diagnostics: [`selected_after_refresh:${radius}`],
          });
        }

        if (
          refresh.status === "runtime_unavailable" ||
          refresh.status === "unsupported_resource_key"
        ) {
          return createTreeSelectionResult({
            status: refresh.status,
            classification,
            requiredLogCount,
            selected,
            refreshAttempts,
            diagnostics: refresh.diagnostics,
          });
        }
      }

      return createTreeSelectionResult({
        status: selected.length > 0 ? "insufficient" : "cache_miss",
        classification,
        requiredLogCount,
        selected,
        refreshAttempts,
        diagnostics:
          selected.length > 0
            ? ["insufficient_tree_logs_after_refresh"]
            : ["tree_cache_miss_after_refresh"],
      });
    },
    createPlannerSummary(
      resourceKeys: readonly string[],
      maxClustersPerKey = DEFAULT_RESOURCE_PLANNER_SUMMARY_LIMIT,
    ): string {
      const lines = resourceKeys.map((resourceKey) => {
        if (resourceKey === "tree") {
          const classification = classifyTrees();

          if (classification.status !== "found") {
            return `${resourceKey}: ${classification.status}`;
          }

          const executableClusters = classification.accepted.slice(0, maxClustersPerKey);
          const clusterSummaries = executableClusters
            .map(
              (cluster) =>
                `${cluster.cluster_id} count=${cluster.log_count} nearest=${cluster.recommended_target.distance.toFixed(1)}`,
            )
            .join("; ");

          if (executableClusters.length === 0) {
            const rejectedReasons = [
              ...new Set(classification.rejected.map((entry) => entry.reason)),
            ];
            return `${resourceKey}: found 0 executable cluster(s)${rejectedReasons.length === 0 ? "" : ` rejected=${rejectedReasons.join(",")}`}`;
          }

          return `${resourceKey}: found ${executableClusters.length} executable cluster(s): ${clusterSummaries}`;
        }

        const result = query(resourceKey, maxClustersPerKey);

        if (result.status !== "found") {
          return `${resourceKey}: ${result.status}`;
        }

        const clusterSummaries = result.clusters
          .map(
            (cluster) =>
              `${cluster.cluster_id} count=${cluster.block_count} nearest=${cluster.nearest_distance.toFixed(1)} radius=${cluster.refresh_radius ?? "unknown"}`,
          )
          .join("; ");

        return `${resourceKey}: found ${result.clusters.length} cluster(s): ${clusterSummaries}`;
      });

      return lines.length > 0 ? `resources: ${lines.join(" | ")}` : "resources: unavailable";
    },
  });
}

function createResourceCacheKey(worldKey: string, resourceKey: string): string {
  return `${worldKey}\u0000${resourceKey}`;
}

function blockChangeRemovesCandidate(
  candidate: ResourceBlockCandidate,
  change: ResourceCacheBlockChange,
): boolean {
  const normalizedBlockName = normalizeBlockName(change.block_name);

  return normalizedBlockName === null || normalizedBlockName !== candidate.block_name;
}

function normalizeBlockName(blockName: string | null | undefined): string | null {
  if (blockName === null || blockName === undefined) {
    return null;
  }

  const normalized = blockName.startsWith("minecraft:")
    ? blockName.slice("minecraft:".length)
    : blockName;

  return AIR_BLOCK_NAMES.has(normalized) ? null : normalized;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * 创建世界模型的刷新契约边界。
 *
 * 显式定义认知的写接口，强制执行读写分离架构，为后续接入异步资源扫描留出明确切入点。
 *
 * @returns 刷新边界对象
 */
export function createWorldModelRefreshBoundary(
  input: {
    /** 复用的 ResourceService（世界感知资源服务） 边界。 */
    readonly resourceService?: ResourceServiceBoundary;
  } = {},
): WorldModelRefreshBoundary {
  const resourceService = input.resourceService ?? createResourceService();

  return Object.freeze({
    async refresh(request: WorldModelRefreshRequest) {
      return resourceService.refresh(request.resource_key, request.radius ?? 16);
    },
  });
}
