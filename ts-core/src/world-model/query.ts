/**
 * 世界模型查询逻辑与评分算法。
 * 
 * 架构职责：
 * 1. 资源评分：实现 `scoreCluster` 启发式算法，根据资源密度（block_count）和距离评估资源簇的价值。
 * 2. 候选块筛选：实现 `selectBestClusterCandidate` 逻辑，优先选择暴露（exposed）且分数高的方块，支撑采集技能的精准定位。
 * 3. 稳压查询：提供基于 `WorldModelQueryContext` 的纯函数查询，确保查询结果与快照版本一致且数据不可变。
 * 4. 边界封装：提供 QueryBoundary 和 RefreshBoundary 的具体实现（或占位），维护系统的读写分离架构。
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

function freezeReadonlyArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezePosition(position: SnapshotPosition): Readonly<SnapshotPosition> {
  return Object.freeze({
    x: position.x,
    y: position.y,
    z: position.z,
  });
}

function cloneCandidate(candidate: ResourceBlockCandidate): ResourceBlockCandidate {
  return Object.freeze({
    ...candidate,
    position: freezePosition(candidate.position),
  });
}

function cloneCluster(cluster: ResourceClusterSummary): ResourceClusterSummary {
  return Object.freeze({
    ...cluster,
    centroid: freezePosition(cluster.centroid),
    candidates: freezeReadonlyArray(
      cluster.candidates.map((candidate) => cloneCandidate(candidate)),
    ),
  });
}

function cloneProfile(profile: ResourceProfile): ResourceProfile {
  return Object.freeze({
    ...profile,
    block_names: freezeReadonlyArray(profile.block_names),
  });
}

function scoreCluster(cluster: ResourceClusterSummary): number {
  return cluster.block_count * 10 - cluster.average_distance - cluster.nearest_distance;
}

/**
 * 查询指定资源键的资源簇列表。
 * 
 * 架构意图：
 * 它是资源检索的基础。它从上下文中筛选出属于当前快照版本且匹配资源键的簇，
 * 并按评分（scoreCluster）降序排列，返回冻结的副本。
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
 * 架构意图：
 * 作为一个“选优器”，它接收 ResourceProfile（定义了寻找什么的逻辑），
 * 并返回评分最高的一个 ResourceClusterSummary。这为上层决策（如“我该去哪砍树”）
 * 提供了直接的领域模型结果。
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
 * 架构算法：
 * 它是采集动作的“精确定位器”。它的筛选优先级如下：
 * 1. 暴露优先：优先选择 is_exposed 为 true 的块（易于触达）。
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
 * 架构意图：
 * 它是 WorldModel 模块的“对外只读接口”。通过封装当前上下文，
 * 它向上层提供了查询资源簇、选优簇和选优块的标准化方法。
 * 这种封装确保了调用方只需关注“查什么”，而无需理解底层的评分和筛选算法。
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
 * 架构意图：
 * 显式定义了认知的“写接口”。虽然 Phase 1 暂未实现真实刷新逻辑，
 * 但通过这个占位接口，强制执行了读写分离架构，为后续接入异步资源扫描留出了明确的切入点。
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
