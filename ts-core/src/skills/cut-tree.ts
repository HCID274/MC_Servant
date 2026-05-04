import type { SnapshotPosition } from "../core-ports/observation.js";
import {
  type CollectSkillAdapter,
  type CutTreeSkillClusterExecution,
  type CutTreeSkillExecutionResult,
  type CutTreeSkillParams,
  createCutTreeSkillExecutionResult,
} from "../core-ports/skills.js";
import type {
  AcceptedTreeCluster,
  ResourceCacheBlockChange,
  ResourceServiceBoundary,
} from "../world-model/contracts.js";

const DEFAULT_CUT_TREE_SETTLE_MS = 500;
const CUT_TREE_COLLECT_RADIUS = 8;

/** cutTree（砍树） 坐标挖掘端口；真实实现由 BotActor（机器人执行代理） 持有的 transport（传输层） 提供。 */
export interface CutTreeDigTargetAdapter {
  /** 挖掘指定坐标上的单个方块。 */
  digBlockAt(position: Readonly<SnapshotPosition>): Promise<void>;
}

/** cutTree（砍树） 背包只读端口，用于跨 dig（挖掘）+ collect（捡拾） 计算真实增量。 */
export interface CutTreeInventoryReader {
  /** 读取当前背包物品快照。 */
  readInventoryItems(): readonly Readonly<{ readonly item_name: string; readonly count: number }>[];
}

/** 创建确定性 cutTree（砍树） 技能执行器。 */
export function createCutTreeSkillExecutor(input: {
  readonly resourceService: ResourceServiceBoundary;
  readonly digger: CutTreeDigTargetAdapter;
  readonly collector: CollectSkillAdapter;
  readonly inventory: CutTreeInventoryReader;
  readonly settleMs?: number;
}): (params: Readonly<CutTreeSkillParams>) => Promise<CutTreeSkillExecutionResult> {
  const settleMs = input.settleMs ?? DEFAULT_CUT_TREE_SETTLE_MS;

  return async (params) => {
    const attemptedClusterIds = new Set<string>();
    const clusters: CutTreeSkillClusterExecution[] = [];
    const diagnostics: string[] = [];
    let collectedCount = 0;
    let totalSteps = 0;
    let worldKey: string | null = null;

    while (collectedCount < params.count) {
      const remaining = params.count - collectedCount;
      const selection = await input.resourceService.selectTreeClusters(remaining);
      worldKey = selection.world_key;
      diagnostics.push(...selection.diagnostics);

      const cluster = selectNextUnattemptedCluster(selection.selected, attemptedClusterIds);

      if (cluster === null) {
        diagnostics.push(
          selection.status === "selected"
            ? "tree_selection_exhausted"
            : `tree_selection_${selection.status}`,
        );
        break;
      }

      attemptedClusterIds.add(cluster.cluster_id);

      const before = countInventoryItem(
        input.inventory.readInventoryItems(),
        cluster.log_block_name,
      );
      await input.digger.digBlockAt(cluster.recommended_target.position);
      totalSteps += 1;
      applyClusterRemoval(input.resourceService, cluster);

      if (settleMs > 0) {
        await delay(settleMs);
      }

      const collectResult = await input.collector.collect({
        center: calculateClusterCenter(cluster),
        radius: CUT_TREE_COLLECT_RADIUS,
      });
      totalSteps += collectResult.total_steps;

      const after = countInventoryItem(
        input.inventory.readInventoryItems(),
        cluster.log_block_name,
      );
      const gained = Math.max(0, after - before);
      collectedCount += gained;
      clusters.push(
        Object.freeze({
          cluster_id: cluster.cluster_id,
          log_block_name: cluster.log_block_name,
          estimated_log_count: cluster.log_count,
          target: Object.freeze({
            x: cluster.recommended_target.position.x,
            y: cluster.recommended_target.position.y,
            z: cluster.recommended_target.position.z,
          }),
          collected_count: gained,
        }),
      );

      if (gained === 0) {
        diagnostics.push(`cut_tree_no_inventory_gain:${cluster.cluster_id}`);
      }
    }

    const result = createCutTreeSkillExecutionResult(params, {
      world_key: worldKey,
      collected_count: collectedCount,
      completed: collectedCount >= params.count,
      status: collectedCount >= params.count ? "completed" : "insufficient",
      clusters,
      diagnostics:
        collectedCount >= params.count
          ? [...diagnostics, "cut_tree_completed_by_inventory_diff"]
          : [...diagnostics, "nearby_tree_logs_insufficient"],
      total_steps: totalSteps,
    });

    if (!result.completed) {
      throw new Error(
        `附近木头不足：已获得 ${result.collected_count}/${result.requested_count} 个原木`,
      );
    }

    return result;
  };
}

function calculateClusterCenter(cluster: AcceptedTreeCluster): Readonly<SnapshotPosition> {
  if (cluster.logs.length === 0) {
    return cluster.recommended_target.position;
  }

  const sum = cluster.logs.reduce(
    (accumulator, position) => ({
      x: accumulator.x + position.x,
      y: accumulator.y + position.y,
      z: accumulator.z + position.z,
    }),
    { x: 0, y: 0, z: 0 },
  );

  return Object.freeze({
    x: sum.x / cluster.logs.length,
    y: sum.y / cluster.logs.length,
    z: sum.z / cluster.logs.length,
  });
}

function selectNextUnattemptedCluster(
  clusters: readonly AcceptedTreeCluster[],
  attemptedClusterIds: ReadonlySet<string>,
): AcceptedTreeCluster | null {
  return clusters.find((cluster) => !attemptedClusterIds.has(cluster.cluster_id)) ?? null;
}

function applyClusterRemoval(
  resourceService: ResourceServiceBoundary,
  cluster: AcceptedTreeCluster,
): void {
  const changes: ResourceCacheBlockChange[] = cluster.logs.map((position) =>
    Object.freeze({
      position,
      block_name: null,
    }),
  );

  resourceService.applyBlockChanges(changes);
}

function countInventoryItem(
  items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  itemName: string,
): number {
  const expected = normalizeMinecraftName(itemName);

  return items.reduce(
    (sum, item) => (normalizeMinecraftName(item.item_name) === expected ? sum + item.count : sum),
    0,
  );
}

function normalizeMinecraftName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/u, "")
    .replace(/[\s-]+/gu, "_");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
