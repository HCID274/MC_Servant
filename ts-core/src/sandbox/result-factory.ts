import { ExecutionTaskKind } from "../core-ports/foundation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import type {
  AbortError,
  SandboxExecutionError,
  SandboxExecutionFailure,
  SandboxExecutionInterrupted,
  SandboxExecutionRequest,
  SandboxExecutionResourceLimits,
  SandboxExecutionSuccess,
  SandboxStepActionName,
  SandboxStepParamsByAction,
  SandboxStepResult,
} from "./contracts.js";
import { createSandboxResourceLimits } from "./resource-limits.js";
import {
  assertPositiveInteger,
  assertPositiveNumber,
  assertSandboxError,
  assertSandboxPhaseLogs,
  assertSandboxResultRefs,
  isSandboxStepActionName,
} from "./validators.js";

/**
 * 创建单步沙箱执行结果。
 *
 * 只负责步骤结果契约校验与物化，不执行 Facade 调用。
 */
export function createSandboxStepResult<TAction extends SandboxStepActionName>(input: {
  step_index: number;
  action: TAction;
  params: SandboxStepResult<TAction>["params"];
  status: SandboxStepResult<TAction>["status"];
  duration_ms?: number;
  result?: Readonly<Record<string, unknown>>;
  error?: SandboxExecutionError;
}): SandboxStepResult<TAction> {
  assertPositiveInteger(input.step_index, "step_index");

  if (!isSandboxStepActionName(input.action)) {
    throw new Error(`Unsupported sandbox action: ${input.action}`);
  }

  if (input.duration_ms !== undefined) {
    assertPositiveNumber(input.duration_ms, "duration_ms");
  }

  if (input.status !== "ok" && input.error === undefined) {
    throw new Error("non-ok step result must include error");
  }

  if (input.error !== undefined) {
    assertSandboxError(input.error);
  }

  return cloneReadonlyValue({
    step_index: input.step_index,
    action: input.action,
    params: input.params,
    status: input.status,
    ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  }) as SandboxStepResult<TAction>;
}

/**
 * 创建沙箱执行请求对象。
 *
 * 请求工厂只保证 code 任务契约，不接受旧 skill_call / sandbox_code 双路径。
 */
export function createSandboxExecutionRequest(input: {
  job_id: string;
  bot_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  code: string;
  log_ref: string;
  code_ref?: string;
  resource_limits?: Partial<SandboxExecutionResourceLimits>;
}): SandboxExecutionRequest {
  assertNonEmptyString(input.job_id, "job_id");
  assertNonEmptyString(input.bot_id, "bot_id");
  assertPositiveInteger(input.intent_epoch, "intent_epoch");
  assertPositiveInteger(input.snapshot_ts, "snapshot_ts");
  assertNonEmptyString(input.code, "code");
  assertSandboxResultRefs({
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
  });

  return Object.freeze({
    type: ExecutionTaskKind.Code,
    job_id: input.job_id,
    bot_id: input.bot_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    code: input.code,
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
    resource_limits: createSandboxResourceLimits(input.resource_limits),
  });
}

/** 创建成功完成的沙箱执行结果。 */
export function createSandboxExecutionSuccess(input: {
  job_id: string;
  bot_id: string;
  intent_epoch: number;
  log_ref: string;
  code_ref?: string;
  phase_logs: readonly SandboxJsonlLine[];
  step_results: readonly SandboxStepResult[];
  summary: {
    total_steps: number;
    duration_ms: number;
  };
}): SandboxExecutionSuccess {
  assertNonEmptyString(input.job_id, "job_id");
  assertNonEmptyString(input.bot_id, "bot_id");
  assertPositiveInteger(input.intent_epoch, "intent_epoch");
  assertSandboxResultRefs({
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
  });
  assertSandboxPhaseLogs(input.phase_logs);
  assertPositiveInteger(input.summary.total_steps, "summary.total_steps");
  assertPositiveNumber(input.summary.duration_ms, "summary.duration_ms");

  if (input.summary.total_steps !== input.step_results.length) {
    throw new Error("summary.total_steps must equal step_results length");
  }

  return cloneReadonlyValue({
    status: TaskHistoryStatus.Completed,
    job_id: input.job_id,
    bot_id: input.bot_id,
    intent_epoch: input.intent_epoch,
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
    phase_logs: input.phase_logs,
    step_results: input.step_results,
    summary: {
      terminal_status: TaskHistoryStatus.Completed,
      total_steps: input.summary.total_steps,
      duration_ms: input.summary.duration_ms,
    },
  }) as SandboxExecutionSuccess;
}

/** 创建失败结束的沙箱执行结果。 */
export function createSandboxExecutionFailure(input: {
  job_id: string;
  bot_id: string;
  intent_epoch: number;
  log_ref: string;
  code_ref?: string;
  phase_logs: readonly SandboxJsonlLine[];
  step_results: readonly SandboxStepResult[];
  summary: {
    total_steps: number;
    duration_ms: number;
  };
  error: SandboxExecutionError;
}): SandboxExecutionFailure {
  assertNonEmptyString(input.job_id, "job_id");
  assertNonEmptyString(input.bot_id, "bot_id");
  assertPositiveInteger(input.intent_epoch, "intent_epoch");
  assertSandboxResultRefs({
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
  });
  assertSandboxPhaseLogs(input.phase_logs);
  assertPositiveInteger(input.summary.total_steps, "summary.total_steps");
  assertPositiveNumber(input.summary.duration_ms, "summary.duration_ms");
  assertSandboxError(input.error);

  return cloneReadonlyValue({
    status: TaskHistoryStatus.Failed,
    job_id: input.job_id,
    bot_id: input.bot_id,
    intent_epoch: input.intent_epoch,
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
    phase_logs: input.phase_logs,
    step_results: input.step_results,
    summary: {
      terminal_status: TaskHistoryStatus.Failed,
      total_steps: input.summary.total_steps,
      duration_ms: input.summary.duration_ms,
    },
    error: input.error,
  }) as SandboxExecutionFailure;
}

/** 创建被中断的沙箱执行结果。 */
export function createSandboxExecutionInterrupted(input: {
  job_id: string;
  bot_id: string;
  intent_epoch: number;
  log_ref: string;
  code_ref?: string;
  phase_logs: readonly SandboxJsonlLine[];
  step_results: readonly SandboxStepResult[];
  summary: {
    total_steps: number;
    duration_ms: number;
  };
  error: AbortError;
}): SandboxExecutionInterrupted {
  assertNonEmptyString(input.job_id, "job_id");
  assertNonEmptyString(input.bot_id, "bot_id");
  assertPositiveInteger(input.intent_epoch, "intent_epoch");
  assertSandboxResultRefs({
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
  });
  assertSandboxPhaseLogs(input.phase_logs);
  assertPositiveInteger(input.summary.total_steps, "summary.total_steps");
  assertPositiveNumber(input.summary.duration_ms, "summary.duration_ms");
  assertSandboxError(input.error);

  return cloneReadonlyValue({
    status: TaskHistoryStatus.Interrupted,
    job_id: input.job_id,
    bot_id: input.bot_id,
    intent_epoch: input.intent_epoch,
    log_ref: input.log_ref,
    ...(input.code_ref !== undefined ? { code_ref: input.code_ref } : {}),
    phase_logs: input.phase_logs,
    step_results: input.step_results,
    summary: {
      terminal_status: TaskHistoryStatus.Interrupted,
      total_steps: input.summary.total_steps,
      duration_ms: input.summary.duration_ms,
    },
    error: input.error,
  }) as SandboxExecutionInterrupted;
}

export type NormalizedSandboxCallParams = Readonly<
  SandboxStepParamsByAction[SandboxStepActionName]
>;
