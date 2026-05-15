import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { createSandboxLogLine } from "../diagnostics/logs.js";
import { cloneReadonlyValue } from "../domain/invariants.js";
import type {
  SandboxGoalResult,
  SandboxStepParamsByAction,
  SandboxStepResult,
} from "./contracts.js";
import { createSandboxStepResult } from "./result-factory.js";
import { isRecord } from "./validators.js";

interface SandboxGoalReportRuntime {
  readonly phaseLogs: SandboxJsonlLine[];
  readonly stepResults: SandboxStepResult[];
  readonly now: () => number;
}

/** 校验 report(task) 的目标事实输入；不生成最终用户话术。 */
export function normalizeSandboxGoalResult(value: unknown): SandboxGoalResult {
  if (!isRecord(value) || value.kind !== "goal_result" || typeof value.ok !== "boolean") {
    throw new Error("report(task) requires a GoalResult returned by runGoal");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error("GoalResult.name must be non-empty");
  }
  if (typeof value.duration_ms !== "number" || !Number.isFinite(value.duration_ms)) {
    throw new Error("GoalResult.duration_ms must be finite");
  }
  if (value.ok === true) {
    if (!isRecord(value.summary)) {
      throw new Error("GoalResult.summary must be an object");
    }
    assertGoalSuccessSummary(value.summary);

    return cloneReadonlyValue(value) as SandboxGoalResult;
  }
  if (!isRecord(value.failure)) {
    throw new Error("GoalResult.failure must be an object");
  }
  const failure = value.failure;
  if (
    typeof failure.failure_code !== "string" ||
    failure.failure_code.trim().length === 0 ||
    typeof failure.failure_stage !== "string" ||
    failure.failure_stage.trim().length === 0 ||
    typeof failure.message !== "string" ||
    failure.message.trim().length === 0
  ) {
    throw new Error("GoalResult.failure must include code, stage and message");
  }

  return cloneReadonlyValue(value) as SandboxGoalResult;
}

function assertGoalSuccessSummary(summary: Readonly<Record<string, unknown>>): void {
  if (!Number.isFinite(summary.completed_count)) {
    throw new Error("GoalResult.summary.completed_count must be finite");
  }
  if (Number(summary.completed_count) < 0) {
    throw new Error("GoalResult.summary.completed_count must be non-negative");
  }
  if (summary.target !== undefined && !isNonEmptyStringOrNull(summary.target)) {
    throw new Error("GoalResult.summary.target must be non-empty when present");
  }
  if (
    summary.requested_count !== undefined &&
    (!Number.isFinite(summary.requested_count) || Number(summary.requested_count) <= 0)
  ) {
    throw new Error("GoalResult.summary.requested_count must be positive when present");
  }
  if (summary.world_key !== undefined && !isNonEmptyStringOrNull(summary.world_key)) {
    throw new Error("GoalResult.summary.world_key must be non-empty or null when present");
  }
  assertInventoryDelta(summary.inventory_delta);
  assertActionResults(summary.action_results);
}

function assertInventoryDelta(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("GoalResult.summary.inventory_delta must be an array when present");
  }
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.item_name !== "string" ||
      item.item_name.trim().length === 0 ||
      typeof item.count !== "number" ||
      !Number.isFinite(item.count) ||
      item.count <= 0
    ) {
      throw new Error(
        "GoalResult.summary.inventory_delta entries must include item_name and positive count",
      );
    }
  }
}

function assertActionResults(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("GoalResult.summary.action_results must be an array when present");
  }
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.completed_count !== "number" ||
      !Number.isFinite(item.completed_count)
    ) {
      throw new Error(
        "GoalResult.summary.action_results entries must include finite completed_count",
      );
    }
  }
}

function isNonEmptyStringOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

/** 记录 report(task) 的结构化事实步骤；最终自然语言汇报由上层 reporter 处理。 */
export function recordSandboxGoalReport(input: {
  readonly args: readonly unknown[];
  readonly runtime: SandboxGoalReportRuntime;
}): Readonly<Record<string, unknown>> {
  const goalResult = normalizeSandboxGoalResult(input.args[0]);
  const params: SandboxStepParamsByAction["report"] = Object.freeze({
    message: "",
    goal_result: goalResult,
  });
  const result = Object.freeze({
    reported: true,
    goal_result: goalResult,
  });

  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_call",
      m: "report",
      p: params,
    }),
  );
  input.runtime.stepResults.push(
    createSandboxStepResult({
      step_index: input.runtime.stepResults.length,
      action: "report",
      params,
      status: "ok",
      duration_ms: 0,
      result,
    }),
  );
  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_result",
      m: "report",
      s: "ok",
      r: result,
      ms: 0,
    }),
  );

  return result;
}
