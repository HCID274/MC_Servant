import type { SnapshotPosition } from "../core-ports/observation.js";
import {
  type CollectSkillAdapter,
  type CutTreeSkillClusterExecution,
  type CutTreeSkillExecutionResult,
  type CutTreeSkillParams,
  NOOP_SKILL_EXECUTION_CONTROL,
  type SkillExecutionControl,
  createCutTreeSkillExecutionResult,
} from "../core-ports/skills.js";
import type {
  AcceptedTreeCluster,
  ResourceCacheBlockChange,
  ResourceServiceBoundary,
} from "../world-model/contracts.js";

const DEFAULT_CUT_TREE_SETTLE_MS = 1_000;
const CUT_TREE_DROP_COLLECT_RADIUS = 8;

/** cutTree（砍树） 坐标挖掘端口；真实实现由 transport（传输层） 提供。 */
export interface CutTreeDigTargetAdapter {
  /** 挖掘指定坐标上的单个方块。 */
  digBlockAt(position: Readonly<SnapshotPosition>, control: SkillExecutionControl): Promise<void>;
}

/** cutTree（砍树） 背包只读端口，用于跨 dig（挖掘）+ collect（捡拾）计算真实原木增量。 */
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
}): (
  params: Readonly<CutTreeSkillParams>,
  control: SkillExecutionControl,
) => Promise<CutTreeSkillExecutionResult> {
  const settleMs = input.settleMs ?? DEFAULT_CUT_TREE_SETTLE_MS;

  return async (params, control = NOOP_SKILL_EXECUTION_CONTROL) => {
    control.throwIfAborted();
    const attemptedClusterIds = new Set<string>();
    const clusters: CutTreeSkillClusterExecution[] = [];
    const diagnostics: string[] = [];
    let collectedCount = 0;
    let totalSteps = 0;
    let worldKey: string | null = null;

    while (collectedCount < params.count) {
      control.throwIfAborted();
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

      try {
        await input.digger.digBlockAt(cluster.recommended_target.position, control);
        totalSteps += 1;
        applyClusterRemoval(input.resourceService, cluster);
      } catch (error) {
        throw createCutTreeStructuredError({
          code: readErrorCode(error) ?? "unreachable_target",
          message: getErrorMessage(error),
          params,
          worldKey,
          completedCount: collectedCount,
          diagnostics: [
            ...diagnostics,
            `cut_tree_dig_failed:${sanitizeDiagnostic(getErrorMessage(error))}`,
          ],
          selection,
          cause: error,
        });
      }

      if (settleMs > 0) {
        await delay(settleMs);
        control.throwIfAborted();
      }
      totalSteps += await collectTreeDrops({
        collector: input.collector,
        center: calculateLowestLogCollectCenter(cluster),
        params,
        worldKey,
        completedCount: collectedCount,
        diagnostics,
        selection,
        control,
      });

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
      throw createCutTreeStructuredError({
        code: clusters.length === 0 ? "resource_not_found" : "drop_not_obtained",
        message: `附近木头不足：已获得 ${result.collected_count}/${result.requested_count} 个原木`,
        params,
        worldKey,
        completedCount: collectedCount,
        diagnostics: result.diagnostics,
        clusters,
      });
    }

    return result;
  };
}

async function collectTreeDrops(input: {
  readonly collector: CollectSkillAdapter;
  readonly center: Readonly<SnapshotPosition>;
  readonly params: Readonly<CutTreeSkillParams>;
  readonly worldKey: string | null;
  readonly completedCount: number;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
  readonly selection?: Awaited<ReturnType<ResourceServiceBoundary["selectTreeClusters"]>>;
}): Promise<number> {
  try {
    input.control.throwIfAborted();
    const result = await input.collector.collect(
      {
        center: input.center,
        radius: CUT_TREE_DROP_COLLECT_RADIUS,
      },
      input.control,
    );
    input.diagnostics.push(
      `cut_tree_collect_result:${result.collected
        .map((item) => `${item.name}:${item.count}`)
        .join("|")}`,
    );
    return result.total_steps;
  } catch (error) {
    throw createCutTreeStructuredError({
      code: readErrorCode(error) ?? "drop_not_obtained",
      message: getErrorMessage(error),
      params: input.params,
      worldKey: input.worldKey,
      completedCount: input.completedCount,
      diagnostics: [
        ...input.diagnostics,
        `cut_tree_collect_failed:${sanitizeDiagnostic(getErrorMessage(error))}`,
      ],
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      cause: error,
    });
  }
}

function calculateLowestLogCollectCenter(cluster: AcceptedTreeCluster): Readonly<SnapshotPosition> {
  if (cluster.logs.length === 0) {
    return cluster.recommended_target.position;
  }

  const recommended = cluster.recommended_target.position;
  const lowest = cluster.logs.reduce((currentLowest, position) => {
    if (position.y < currentLowest.y) return position;
    if (position.y > currentLowest.y) return currentLowest;
    return squaredDistance(position, recommended) < squaredDistance(currentLowest, recommended)
      ? position
      : currentLowest;
  }, cluster.logs[0] ?? recommended);

  return Object.freeze({
    x: lowest.x,
    y: lowest.y,
    z: lowest.z,
  });
}

function squaredDistance(a: Readonly<SnapshotPosition>, b: Readonly<SnapshotPosition>): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
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

function createCutTreeStructuredError(input: {
  readonly code: string;
  readonly message: string;
  readonly params: Readonly<CutTreeSkillParams>;
  readonly worldKey: string | null;
  readonly completedCount: number;
  readonly diagnostics: readonly string[];
  readonly selection?: Awaited<ReturnType<ResourceServiceBoundary["selectTreeClusters"]>>;
  readonly clusters?: readonly CutTreeSkillClusterExecution[];
  readonly cause?: unknown;
}): Error {
  const error = new Error(input.message) as Error & {
    error_code?: string;
    details?: Readonly<Record<string, unknown>>;
    cause?: unknown;
  };
  error.error_code = input.code;
  error.cause = input.cause;
  error.details = Object.freeze({
    failure_stage: "cutTree",
    target_kind: "cut_tree_log",
    requested_count: input.params.count,
    completed_count: input.completedCount,
    target_count: input.params.count,
    world_key: input.worldKey,
    diagnostics: Object.freeze([...input.diagnostics]),
    ...(input.selection === undefined
      ? {}
      : {
          selection_status: input.selection.status,
          selected_log_count: input.selection.selected_log_count,
          rejected_reasons: Object.freeze(
            input.selection.rejected.map((rejected) => rejected.reason),
          ),
          refresh_statuses: Object.freeze(
            input.selection.refresh_attempts.map((attempt) => attempt.status),
          ),
        }),
    ...(input.clusters === undefined ? {} : { clusters: input.clusters }),
  });
  return error;
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const code = (error as { readonly error_code?: unknown }).error_code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/\s+/gu, "_").slice(0, 240);
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
