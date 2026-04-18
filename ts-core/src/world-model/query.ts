/**
 * 世界模型查询逻辑与评分算法。
 *
 * 1. 资源评分：实现 scoreCluster 启发式算法，根据资源密度和距离评估资源簇价值。
 * 2. 候选块筛选：实现优先级筛选逻辑，优先选择暴露且分数高的方块。
 * 3. 稳压查询：提供基于上下文的纯函数查询，确保结果与快照一致且不可变。
 * 4. 边界封装：提供查询和刷新边界的具体实现，维护读写分离架构。
 */

import type { SnapshotPosition } from "../observation/contracts.js";
import type {
  BestResourceClusterResult,
  CandidateBlockSelectionResult,
  ResourceBlockCandidate,
  ResourceClusterSummary,
  ResourceProfile,
  WorldModelQueryBoundary,
  WorldModelQueryContext,
  WorldModelRefreshBoundary,
} from "./contracts.js";
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

/**
 * 创建世界模型的刷新契约边界。
 *
 * 显式定义认知的写接口，强制执行读写分离架构，为后续接入异步资源扫描留出明确切入点。
 *
 * @returns 刷新边界对象
 */
export function createWorldModelRefreshBoundary(): WorldModelRefreshBoundary {
  return Object.freeze({
    async refresh() {
      throw new Error("World-model refresh is intentionally not implemented in Phase 1");
    },
  });
}
