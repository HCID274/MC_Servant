/**
 * BotWorker（机器人工作线程） 执行结果到 TaskResultSummary（任务结果摘要）的纯转换。
 */

import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import { ExecutionTaskKind } from "../core-ports/foundation.js";
import type { RuntimeSandboxExecutionResult } from "../core-ports/sandbox.js";
import type { SkillExecutionResult } from "../core-ports/skills.js";
import {
  type TaskResultInventoryDelta,
  type TaskResultSummary,
  classifyFailureCode,
  createTaskResultSummary,
} from "../core-ports/task-result.js";
import type { CodeJob, ExecJob } from "../core-ports/tasking.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";

/** 从 skill（技能） 执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromSkillResult(
  resultOrJob: SkillExecutionResult | unknown,
  resultOrOptions: SkillExecutionResult | { readonly durationMs?: number } = {},
  maybeOptions: { readonly durationMs?: number } = {},
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

/** 从 code（代码） 执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromCodeResult(
  job: CodeJob,
  result: RuntimeSandboxExecutionResult,
  options: { readonly durationMs?: number } = {},
): TaskResultSummary {
  const reportedGoal = readReportedGoalResult(result);
  if (reportedGoal !== null) {
    return createTaskResultSummaryFromGoalResult(job, reportedGoal, options);
  }

  if (result.status !== TaskHistoryStatus.Completed) {
    return createSandboxTerminalResultSummary(job, result, options);
  }

  const lastStep = [...result.step_results].reverse().find((step) => step.status === "ok");
  const resultRecord = lastStep?.result;
  const toolchainData = readToolchainSuccessData(resultRecord);
  if (toolchainData !== null) {
    const target = toolchainData.item_name ?? toolchainData.block_name;
    const requestedCount = readRequestedCount(lastStep?.params);
    const inventoryDelta = createInventoryDelta(target ?? null, toolchainData.completed_count);
    return createTaskResultSummary({
      task_type: ExecutionTaskKind.Code,
      operation: lastStep?.action ?? "code",
      ...(target === undefined ? {} : { target }),
      ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
      completed_count: toolchainData.completed_count,
      ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
      world_key: toolchainData.world_key,
      ...createDurationField(options),
      details: { total_steps: result.summary.total_steps },
    });
  }

  const skillResult = readSandboxSkillResult(resultRecord);
  if (skillResult !== null) {
    return createTaskResultSummary({
      ...skillResult,
      ...createDurationField(options),
    });
  }

  return createTaskResultSummary({
    task_type: job.type,
    operation: lastStep?.action ?? "code",
    completed_count: result.status === TaskHistoryStatus.Completed ? result.summary.total_steps : 0,
    ...createDurationField(options),
    details: { total_steps: result.summary.total_steps },
  });
}

export const createTaskResultSummaryFromSandboxResult = createTaskResultSummaryFromCodeResult;

function createTaskResultSummaryFromGoalResult(
  job: CodeJob,
  goal: Readonly<Record<string, unknown>>,
  options: { readonly durationMs?: number },
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
      recoverable: readBoolean(failure.recoverable) ?? inferRecoverable(failureCode),
      details,
    }),
    details: {
      ...details,
      goal_name: name,
      ...(condition === null ? {} : { condition }),
    },
  });
}

function readReportedGoalResult(
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

function createSandboxTerminalResultSummary(
  job: CodeJob,
  result: RuntimeSandboxExecutionResult,
  options: { readonly durationMs?: number },
): TaskResultSummary {
  const failedStep = [...result.step_results].reverse().find((step) => step.status !== "ok");
  const errorRecord = "error" in result ? asRecord(result.error) : null;
  const stepErrorRecord = asRecord(failedStep?.error);
  const details = asRecord(errorRecord?.details) ?? asRecord(stepErrorRecord?.details);
  const targetProgress = asRecord(details?.target_progress);
  const failedParams = asRecord(failedStep?.params);
  const operation =
    readOptionalString(failedStep?.action) ??
    readOptionalString(errorRecord?.method) ??
    readOptionalString(details?.failure_stage) ??
    "code";
  const target =
    readOptionalString(failedParams?.itemName) ??
    readOptionalString(failedParams?.blockName) ??
    readOptionalString(targetProgress?.target) ??
    readOptionalString(details?.target_item_name) ??
    readOptionalString(details?.item_name) ??
    readOptionalString(details?.block_name);
  const requestedCount =
    readRequestedCount(failedParams) ??
    readNumber(targetProgress?.requested_count) ??
    readNumber(details?.target_count);
  const worldKey = readOptionalString(details?.world_key);
  const failure = createFailureSummary({
    code:
      readOptionalString(errorRecord?.error_code) ??
      readOptionalString(stepErrorRecord?.error_code) ??
      "facade_call_failed",
    stage: readOptionalString(details?.failure_stage) ?? operation,
    message:
      readOptionalString(errorRecord?.message) ??
      readOptionalString(stepErrorRecord?.message) ??
      "code terminal failure",
    recoverable:
      readBoolean(errorRecord?.recoverable) ?? readBoolean(stepErrorRecord?.recoverable) ?? null,
    details,
  });

  return createTaskResultSummary({
    task_type: job.type,
    operation,
    status: result.status === TaskHistoryStatus.Interrupted ? "interrupted" : "failed",
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    completed_count: readNumber(targetProgress?.completed_count) ?? 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...createDurationField(options),
    failure,
    details: {
      ...(details ?? {}),
      total_steps: result.summary.total_steps,
    },
  });
}

/** 从执行异常创建失败任务结果摘要。 */
export function createTaskFailureResultSummary(
  job: ExecJob,
  error: TaskFailedErrorSnapshot,
  options: { readonly durationMs?: number; readonly status?: "failed" | "interrupted" } = {},
): TaskResultSummary {
  const details = createFailureDetailsForJob(job, error.details ?? {});
  const failureCode = error.error_code ?? readFailureCodeFromMessage(error.message);
  const worldKey = readOptionalString(details.world_key);
  return createTaskResultSummary({
    task_type: job.type,
    operation: "code",
    status: options.status ?? "failed",
    completed_count: readTargetProgressCompletedCount(details) ?? 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...createDurationField(options),
    failure: createFailureSummary({
      code: failureCode,
      stage: readOptionalString(details.failure_stage) ?? "code",
      message: error.message,
      recoverable: readBoolean(details.recoverable) ?? inferRecoverable(failureCode),
      details,
    }),
    details,
  });
}

function createFailureDetailsForJob(
  job: ExecJob,
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  void job;
  return details;
}

function createInventoryDelta(
  itemName: string | null | undefined,
  count: number,
): readonly TaskResultInventoryDelta[] | undefined {
  if (itemName === undefined || itemName === null || count <= 0) {
    return undefined;
  }

  return Object.freeze([
    Object.freeze({
      item_name: itemName,
      count,
    }),
  ]);
}

function readInventoryDelta(value: unknown): readonly TaskResultInventoryDelta[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const deltas = value.flatMap((item): TaskResultInventoryDelta[] => {
    if (!isRecord(item)) {
      return [];
    }
    const itemName = readOptionalString(item.item_name);
    const count = readNumber(item.count);
    if (itemName === undefined || count === undefined || count <= 0) {
      return [];
    }

    return [{ item_name: itemName, count }];
  });

  return deltas.length === 0 ? undefined : Object.freeze(deltas);
}

function readConditionCount(
  condition: Readonly<Record<string, unknown>> | null,
): number | undefined {
  if (condition === null) {
    return undefined;
  }

  return readNumber(condition.count);
}

function readConditionTarget(
  condition: Readonly<Record<string, unknown>> | null,
): string | undefined {
  if (condition === null) {
    return undefined;
  }

  return (
    readOptionalString(condition.itemName) ??
    readOptionalString(condition.tagName) ??
    readOptionalString(condition.blockName)
  );
}

function createDurationField(options: { readonly durationMs?: number }): {
  readonly duration_ms?: number;
} {
  return options.durationMs === undefined ? {} : { duration_ms: options.durationMs };
}

function createFailureSummary(input: {
  readonly code: string;
  readonly stage: string;
  readonly message: string;
  readonly recoverable: boolean | null;
  readonly details?: Readonly<Record<string, unknown>> | null;
}): NonNullable<TaskResultSummary["failure"]> {
  const details = input.details ?? {};
  return Object.freeze({
    failure_code: input.code,
    failure_stage: input.stage,
    message: input.message,
    recoverable: input.recoverable,
    current_position: readPositionSummary(details.current_position) ?? null,
    inventory_summary: readNullableRecord(details.inventory_summary) ?? null,
    equipment_summary: readNullableRecord(details.equipment_summary) ?? null,
    target_progress: readTargetProgress(details.target_progress) ?? null,
  });
}

function readNullableRecord(value: unknown): Readonly<Record<string, unknown>> | null | undefined {
  if (value === null) {
    return null;
  }

  return asRecord(value) ?? undefined;
}

function readPositionSummary(
  value: unknown,
): NonNullable<TaskResultSummary["failure"]>["current_position"] {
  if (!isRecord(value)) {
    return value === null ? null : undefined;
  }

  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const z = readNumber(value.z);
  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }

  return Object.freeze({ x, y, z });
}

function readTargetProgress(
  value: unknown,
): NonNullable<TaskResultSummary["failure"]>["target_progress"] {
  if (!isRecord(value)) {
    return value === null ? null : undefined;
  }

  const action = readOptionalString(value.action);
  const target = readOptionalString(value.target);
  const requestedCount = readNullableNumber(value.requested_count);
  const completedCount = readNullableNumber(value.completed_count);
  const targetCount = readNullableNumber(value.target_count);

  return Object.freeze({
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    ...(completedCount === undefined ? {} : { completed_count: completedCount }),
    ...(targetCount === undefined ? {} : { target_count: targetCount }),
  });
}

function readTargetProgressCompletedCount(
  details: Readonly<Record<string, unknown>>,
): number | undefined {
  const targetProgress = asRecord(details.target_progress);
  return readNumber(targetProgress?.completed_count);
}

function readFailureCodeFromMessage(message: string): string {
  const separatorIndex = message.indexOf(":");
  return separatorIndex <= 0 ? "unknown_error" : message.slice(0, separatorIndex);
}

function inferRecoverable(code: string | undefined): boolean | null {
  if (code === undefined) {
    return null;
  }

  if (classifyFailureCode(code) === "recoverable" || code === "missing_item") {
    return true;
  }

  if (classifyFailureCode(code) === "implementation_blocker") {
    return false;
  }

  return null;
}

function readToolchainSuccessData(value: unknown): {
  readonly world_key: string | null;
  readonly completed_count: number;
  readonly item_name?: string;
  readonly block_name?: string;
} | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return null;
  }

  const data = value.data;
  return Object.freeze({
    world_key: typeof data.world_key === "string" ? data.world_key : null,
    completed_count: typeof data.completed_count === "number" ? data.completed_count : 1,
    ...(typeof data.item_name === "string" ? { item_name: data.item_name } : {}),
    ...(typeof data.block_name === "string" ? { block_name: data.block_name } : {}),
  });
}

function readSandboxSkillResult(value: unknown): TaskResultSummary | null {
  if (!isRecord(value) || typeof value.skill !== "string") {
    return null;
  }

  switch (value.skill) {
    case "mine": {
      const target = readOptionalString(value.block_name);
      const completedCount = readNumber(value.collected_count);
      const worldKey = readOptionalString(value.world_key);
      const inventoryDelta = createInventoryDelta(
        readOptionalString(value.collected_item_name),
        completedCount ?? 0,
      );
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: "mine",
        ...(target === undefined ? {} : { target }),
        ...(completedCount === undefined ? {} : { completed_count: completedCount }),
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        ...(worldKey === undefined ? {} : { world_key: worldKey }),
      });
    }
    case "collect": {
      const completedCount = readCollectedCount(value.collected);
      const worldKey = readOptionalString(value.world_key);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: "collect",
        target: readOptionalString(value.item_name) ?? "all_items",
        ...(completedCount === undefined ? {} : { completed_count: completedCount }),
        ...(worldKey === undefined ? {} : { world_key: worldKey }),
      });
    }
    case "equip": {
      const target = readOptionalString(value.item_name);
      const worldKey = readOptionalString(value.world_key);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: "equip",
        ...(target === undefined ? {} : { target }),
        completed_count: 1,
        ...(worldKey === undefined ? {} : { world_key: worldKey }),
      });
    }
    case "goTo": {
      const worldKey = readOptionalString(value.world_key);
      const diagnostics = readStringArray(value.diagnostics);
      const totalSteps = readNumber(value.total_steps);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.Code,
        operation: "goTo",
        completed_count: 1,
        ...(worldKey === undefined ? {} : { world_key: worldKey }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        details: {
          ...(totalSteps === undefined ? {} : { total_steps: totalSteps }),
        },
      });
    }
    default:
      return null;
  }
}

function readRequestedCount(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readNumber(value.count) ?? readNumber(value.requested_count);
}

function readCollectedCount(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.reduce((sum, item) => {
    if (!isRecord(item)) {
      return sum;
    }
    return sum + (readNumber(item.count) ?? 0);
  }, 0);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === 0 ? undefined : Object.freeze(strings);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return readNumber(value);
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}
