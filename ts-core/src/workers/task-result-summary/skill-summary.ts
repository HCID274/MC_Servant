import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import type { SkillExecutionResult } from "../../core-ports/skills.js";
import { type TaskResultSummary, createTaskResultSummary } from "../../core-ports/task-result.js";
import { type SummaryOptions, createDurationField, createInventoryDelta } from "./summary-facts.js";

/** 从 skill（技能）执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromSkillResult(
  resultOrJob: SkillExecutionResult | unknown,
  resultOrOptions: SkillExecutionResult | SummaryOptions = {},
  maybeOptions: SummaryOptions = {},
): TaskResultSummary {
  const result = isSkillExecutionResult(resultOrJob)
    ? resultOrJob
    : (resultOrOptions as SkillExecutionResult);
  const options = isSkillExecutionResult(resultOrOptions) ? maybeOptions : resultOrOptions;
  switch (result.skill) {
    case "goTo":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: result.skill,
        target: `${result.target.x},${result.target.y},${result.target.z}`,
        completed_count: 1,
        world_key: result.world_key,
        ...createDurationField(options),
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        details: { total_steps: result.total_steps },
      });
    case "mine": {
      const inventoryDelta = createInventoryDelta(
        result.collected_item_name,
        result.collected_count,
      );
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: result.skill,
        target: result.block_name,
        completed_count: result.collected_count,
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        world_key: result.world_key,
        ...createDurationField(options),
        diagnostics: result.diagnostics,
        details: { mined_count: result.mined_count },
      });
    }
    case "cutTree": {
      const itemName = result.clusters.find(
        (cluster) => cluster.collected_count > 0,
      )?.log_block_name;
      const inventoryDelta = createInventoryDelta(itemName ?? "logs", result.collected_count);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: result.skill,
        target: itemName ?? result.clusters[0]?.log_block_name ?? "logs",
        requested_count: result.requested_count,
        completed_count: result.collected_count,
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        world_key: result.world_key,
        ...createDurationField(options),
        diagnostics: result.diagnostics,
        details: {
          cluster_count: result.clusters.length,
          status: result.status,
        },
      });
    }
    case "collect":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: result.skill,
        target: result.item_name ?? "all_items",
        completed_count: result.collected.reduce((sum, item) => sum + item.count, 0),
        inventory_delta: result.collected.map((item) => ({
          item_name: item.name,
          count: item.count,
        })),
        world_key: result.world_key,
        ...createDurationField(options),
        details: { skipped_count: result.skipped.length },
      });
    case "equip":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: result.skill,
        target: result.item_name,
        completed_count: 1,
        world_key: result.world_key,
        ...createDurationField(options),
        details: {
          destination: result.destination,
          status: result.status,
        },
      });
  }
}

function isSkillExecutionResult(value: unknown): value is SkillExecutionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "skill" in value &&
    typeof (value as { readonly skill?: unknown }).skill === "string"
  );
}
