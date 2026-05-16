import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import type { RuntimeSandboxExecutionResult } from "../../core-ports/sandbox.js";
import {
  type TaskResultSummary,
  createTaskResultSummary,
  resolveFailureRecoverable,
} from "../../core-ports/task-result.js";
import type { CodeJob } from "../../core-ports/tasking.js";
import {
  type SummaryOptions,
  asRecord,
  createDurationField,
  createFailureSummary,
  readBoolean,
  readConditionCount,
  readConditionTarget,
  readInventoryDelta,
  readNumber,
  readOptionalString,
} from "./summary-facts.js";

export function createTaskResultSummaryFromGoalResult(
  job: CodeJob,
  goal: Readonly<Record<string, unknown>>,
  options: SummaryOptions,
): TaskResultSummary {
  const name = readOptionalString(goal.name) ?? "code";
  const condition = asRecord(goal.condition);
  const durationMs = options.durationMs ?? readNumber(goal.duration_ms);
  if (goal.ok === true) {
    const summary = asRecord(goal.summary) ?? {};
    const target = readOptionalString(summary.target);
    const requestedCount = readNumber(summary.requested_count) ?? readConditionCount(condition);
    const inventoryDelta = readInventoryDelta(summary.inventory_delta);
    return createTaskResultSummary({
      task_type: job.type,
      operation: name,
      skill_name: name,
      ...(target === undefined ? {} : { target }),
      ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
      completed_count: readNumber(summary.completed_count) ?? 0,
      ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
      ...(summary.world_key === undefined
        ? {}
        : { world_key: readOptionalString(summary.world_key) ?? null }),
      ...createDurationField(durationMs === undefined ? {} : { durationMs }),
      details: {
        goal_name: name,
        ...(Array.isArray(summary.action_results)
          ? { action_results: summary.action_results }
          : {}),
        ...(condition === null ? {} : { condition }),
      },
    });
  }

  const failure = asRecord(goal.failure) ?? {};
  const details = asRecord(failure.details) ?? {};
  const targetProgress = asRecord(details.target_progress);
  const target =
    readOptionalString(targetProgress?.target) ??
    readConditionTarget(condition) ??
    readOptionalString(details.target_item_name) ??
    readOptionalString(details.item_name) ??
    readOptionalString(details.block_name);
  const requestedCount =
    readNumber(targetProgress?.requested_count) ??
    readConditionCount(condition) ??
    readNumber(details.target_count);
  const worldKey = readOptionalString(details.world_key);
  const failureCode = readOptionalString(failure.failure_code) ?? "facade_call_failed";

  return createTaskResultSummary({
    task_type: job.type,
    operation: name,
    skill_name: name,
    status: "failed",
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    completed_count: readNumber(targetProgress?.completed_count) ?? 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...createDurationField(durationMs === undefined ? {} : { durationMs }),
    failure: createFailureSummary({
      code: failureCode,
      stage: readOptionalString(failure.failure_stage) ?? "code",
      message: readOptionalString(failure.message) ?? failureCode,
      recoverable: readBoolean(failure.recoverable) ?? resolveFailureRecoverable(failureCode),
      details,
    }),
    details: {
      ...details,
      goal_name: name,
      ...(condition === null ? {} : { condition }),
    },
  });
}

export function readReportedGoalResult(
  result: RuntimeSandboxExecutionResult,
): Readonly<Record<string, unknown>> | null {
  for (const step of [...result.step_results].reverse()) {
    if (step.action !== "report") {
      continue;
    }

    const resultRecord = asRecord(step.result);
    const resultGoal = asRecord(resultRecord?.goal_result);
    if (isGoalResultRecord(resultGoal)) {
      return resultGoal;
    }

    const paramsRecord = asRecord(step.params);
    const paramsGoal = asRecord(paramsRecord?.goal_result);
    if (isGoalResultRecord(paramsGoal)) {
      return paramsGoal;
    }
  }

  return null;
}

function isGoalResultRecord(
  value: Readonly<Record<string, unknown>> | null,
): value is Readonly<Record<string, unknown>> {
  return value !== null && value.kind === "goal_result" && typeof value.ok === "boolean";
}
