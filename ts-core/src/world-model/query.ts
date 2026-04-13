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

/** 查询指定资源键的资源簇列表，用于保持 query 与 refresh 分离。 */
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

/** 查询最优资源簇，用于提供 world-model 的只读选择结果。 */
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

/** 选择资源簇中的最佳候选块，用于为后续技能层提供只读候选。 */
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

/** 创建 world-model 的只读查询边界，用于后续 api.world 与技能层消费。 */
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

/** 创建 world-model 的 refresh 契约边界，用于明确未来实现独立于 query。 */
export function createWorldModelRefreshBoundary(): WorldModelRefreshBoundary {
  return Object.freeze({
    async refresh() {
      throw new Error("World-model refresh is intentionally not implemented in Phase 1");
    },
  });
}
