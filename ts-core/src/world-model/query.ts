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
  BestResourceClusterResult,
  CandidateBlockSelectionResult,
  ResourceBlockCandidate,
  ResourceClusterQueryResult,
  ResourceClusterSummary,
  ResourceProfile,
  ResourceServiceBoundary,
  ResourceServiceRefreshPort,
  ResourceServiceRefreshResult,
  ResourceWorldKeyPort,
  WorldModelQueryBoundary,
  WorldModelQueryContext,
  WorldModelRefreshBoundary,
  WorldModelRefreshRequest,
} from "./contracts.js";

const DEFAULT_RESOURCE_SERVICE_STALE_AFTER_MS = 60_000;
const DEFAULT_RESOURCE_CLUSTER_RADIUS = 4;
const DEFAULT_RESOURCE_PLANNER_SUMMARY_LIMIT = 2;

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
  });
}
/** 克隆整个资源簇摘要及其候选者。 */

function cloneCluster(cluster: ResourceClusterSummary): ResourceClusterSummary {
  return Object.freeze({
    ...cluster,
    centroid: freezePosition(cluster.centroid),
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
    is_exposed: true,
  });
}

/** 按显式 cluster_key（资源簇键） 或近邻半径把候选块分组。 */
function groupRuntimeResourceBlocks(
  resourceKey: string,
  blocks: readonly RuntimeResourceBlockSummary[],
): readonly (readonly RuntimeResourceBlockSummary[])[] {
  const explicitGroups = new Map<string, RuntimeResourceBlockSummary[]>();
  const ungrouped: RuntimeResourceBlockSummary[] = [];

  for (const block of blocks.filter((candidate) =>
    runtimeBlockMatchesResourceKey(candidate, resourceKey),
  )) {
    if (block.cluster_key) {
      explicitGroups.set(block.cluster_key, [
        ...(explicitGroups.get(block.cluster_key) ?? []),
        block,
      ]);
    } else {
      ungrouped.push(block);
    }
  }

  const proximityGroups: RuntimeResourceBlockSummary[][] = [];

  for (const block of ungrouped.sort((left, right) => left.distance - right.distance)) {
    const matchedGroup = proximityGroups.find((group) =>
      group.some(
        (candidate) =>
          distanceBetween(candidate.position, block.position) <= DEFAULT_RESOURCE_CLUSTER_RADIUS,
      ),
    );

    if (matchedGroup) {
      matchedGroup.push(block);
    } else {
      proximityGroups.push([block]);
    }
  }

  return freezeReadonlyArray([
    ...[...explicitGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => freezeReadonlyArray(value)),
    ...proximityGroups.map((group) => freezeReadonlyArray(group)),
  ]);
}

/** 从运行时刷新结果构建资源簇。 */
export function createResourceClustersFromRuntimeRefresh(
  refresh: RuntimeResourceRefreshResult,
): readonly ResourceClusterSummary[] {
  const groups = groupRuntimeResourceBlocks(refresh.resource_key, refresh.blocks);

  return sortResourceClusters(
    groups.map((group, index) => {
      const candidates = freezeReadonlyArray(group.map((block) => createResourceCandidate(block)));
      const centroid = calculateCentroid(candidates);
      const nearestDistance = Math.min(...candidates.map((candidate) => candidate.distance));
      const averageDistance =
        candidates.reduce((sum, candidate) => sum + candidate.distance, 0) / candidates.length;
      const clusterKey = group.find((block) => block.cluster_key !== undefined)?.cluster_key;

      return cloneCluster({
        resource_key: refresh.resource_key,
        cluster_id:
          clusterKey ??
          `${refresh.world_key}:${refresh.resource_key}:${refresh.radius}:${index + 1}:${Math.round(centroid.x)}:${Math.round(centroid.y)}:${Math.round(centroid.z)}`,
        snapshot_version: refresh.snapshot_version,
        world_key: refresh.world_key,
        refresh_radius: refresh.radius,
        refreshed_at: refresh.scanned_at,
        centroid,
        block_count: candidates.length,
        nearest_distance: nearestDistance,
        average_distance: averageDistance,
        candidates,
      });
    }),
  );
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
  const sortedCandidates = [...input.cluster.candidates].sort((left, right) => {
    if (left.is_exposed !== right.is_exposed) {
      return Number(right.is_exposed) - Number(left.is_exposed);
    }

    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return left.distance - right.distance;
  });

  const candidate = sortedCandidates[0];

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

  return Object.freeze({
    query,
    async refresh(
      resourceKey: string,
      radius: ResourceRefreshRadius,
    ): Promise<ResourceServiceRefreshResult> {
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
    },
    createPlannerSummary(
      resourceKeys: readonly string[],
      maxClustersPerKey = DEFAULT_RESOURCE_PLANNER_SUMMARY_LIMIT,
    ): string {
      const lines = resourceKeys.map((resourceKey) => {
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
