/**
 * 沙箱执行管理与结果封装。
 *
 * 架构职责：
 * 1. 资源限制管理：定义并生成沙箱执行的配额约束（内存、超时、睡眠上限等）。
 * 2. 稳压校验：在执行请求（Request）和执行结果（Result）生成时，执行严格的运行时字段校验和路径引用校验（assertDiagnosticStorageRef）。
 * 3. 结果聚合：提供针对不同终态（Success, Failure, Interrupted）的结果对象工厂，聚合阶段性日志、单步结果和终态摘要。
 * 4. 错误转换：将原始的异常信息包装为符合契约的结构化 SandboxExecutionError。
 */

import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { assertDiagnosticStorageRef } from "../diagnostics/logs.js";
import { ExecutionTaskKind } from "../domain/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import { TaskHistoryStatus } from "../runtime/tasking.js";
import {
  type AbortError,
  SANDBOX_ERROR_NAMES,
  SANDBOX_STEP_ACTION_NAMES,
  type SandboxExecutionError,
  type SandboxExecutionFailure,
  type SandboxExecutionInterrupted,
  type SandboxExecutionRequest,
  type SandboxExecutionResourceLimits,
  type SandboxExecutionSuccess,
  type SandboxStepActionName,
  type SandboxStepResult,
} from "./contracts.js";

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

function isSandboxStepActionName(value: string): value is SandboxStepActionName {
  return (SANDBOX_STEP_ACTION_NAMES as readonly string[]).includes(value);
}

function assertSandboxError(error: SandboxExecutionError): void {
  if (!(SANDBOX_ERROR_NAMES as readonly string[]).includes(error.name)) {
    throw new Error(`Unsupported sandbox error: ${error.name}`);
  }

  assertNonEmptyString(error.message, "error.message");

  switch (error.name) {
    case "StaticCheckError":
      assertNonEmptyString(error.violation, "error.violation");
      break;
    case "TranspileError":
      if (error.diagnostics?.some((item) => item.trim().length === 0) === true) {
        throw new Error("error.diagnostics must not contain empty items");
      }
      break;
    case "SandboxTimeoutError":
      assertPositiveInteger(error.timeout_ms, "error.timeout_ms");
      break;
    case "SandboxOOMError":
      assertPositiveInteger(error.memory_limit_mb, "error.memory_limit_mb");
      break;
    case "FacadeCallError":
      if (!isSandboxStepActionName(error.method)) {
        throw new Error(`Unsupported sandbox action: ${error.method}`);
      }
      assertNonEmptyString(error.error_code, "error.error_code");
      break;
    case "AbortError":
      if (error.recoverable) {
        throw new Error("AbortError.recoverable must be false");
      }
      assertNonEmptyString(error.reason, "error.reason");
      break;
    case "UnhandledError":
      if (error.stack !== undefined) {
        assertNonEmptyString(error.stack, "error.stack");
      }
      break;
  }
}

function assertSandboxPhaseLogs(phaseLogs: readonly SandboxJsonlLine[]): void {
  if (phaseLogs.length === 0) {
    throw new Error("phase_logs must contain at least one entry");
  }
}

function assertSandboxResultRefs(input: {
  log_ref: string;
  code_ref?: string;
}): void {
  assertDiagnosticStorageRef({
    channel: "sandbox",
    refField: "log_ref",
    value: input.log_ref,
  });

  if (input.code_ref !== undefined) {
    assertDiagnosticStorageRef({
      channel: "sandbox",
      refField: "code_ref",
      value: input.code_ref,
    });
  }
}

/** 默认的 sandbox（沙箱执行） 资源限制。 */
export const DEFAULT_SANDBOX_RESOURCE_LIMITS = Object.freeze({
  memory_limit_mb: 128,
  timeout_ms: 120_000,
  script_timeout_ms: 115_000,
  max_sleep_ms: 10_000,
  abort_cleanup_timeout_ms: 500,
} as const satisfies SandboxExecutionResourceLimits);

/**
 * 创建沙箱资源限制对象。
 *
 * 架构意图：
 * 它是沙箱安全性的第一道防线。它负责合并默认配置与自定义配置，
 * 并校验关键约束（如 script_timeout 必须小于总 timeout），
 * 确保每个沙箱实例都在确定的资源范围内运行。
 *
 * @param input 可选的资源限制补丁
 * @returns 经过校验和冻结的资源限制对象
 */
export function createSandboxResourceLimits(
  input: Partial<SandboxExecutionResourceLimits> = {},
): Readonly<SandboxExecutionResourceLimits> {
  const resourceLimits = {
    memory_limit_mb: input.memory_limit_mb ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.memory_limit_mb,
    timeout_ms: input.timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.timeout_ms,
    script_timeout_ms: input.script_timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.script_timeout_ms,
    max_sleep_ms: input.max_sleep_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.max_sleep_ms,
    abort_cleanup_timeout_ms:
      input.abort_cleanup_timeout_ms ?? DEFAULT_SANDBOX_RESOURCE_LIMITS.abort_cleanup_timeout_ms,
  };

  assertPositiveInteger(resourceLimits.memory_limit_mb, "memory_limit_mb");
  assertPositiveInteger(resourceLimits.timeout_ms, "timeout_ms");
  assertPositiveInteger(resourceLimits.script_timeout_ms, "script_timeout_ms");
  assertPositiveInteger(resourceLimits.max_sleep_ms, "max_sleep_ms");
  assertPositiveInteger(resourceLimits.abort_cleanup_timeout_ms, "abort_cleanup_timeout_ms");

  if (resourceLimits.script_timeout_ms >= resourceLimits.timeout_ms) {
    throw new Error("script_timeout_ms must be shorter than timeout_ms");
  }

  return Object.freeze(resourceLimits);
}

/**
 * 创建结构化的沙箱错误对象。
 *
 * 架构意图：
 * 作为一个“稳压工厂”，它在错误对象穿过沙箱边界进入主进程前对其进行严格校验（assertSandboxError）。
 * 它确保了错误类型是系统预定义的，且包含所有必要的上下文信息，从而保证了后续错误处理的一致性。
 *
 * @param input 原始错误对象
 * @returns 经过校验并克隆的只读错误对象
 */
export function createSandboxError<TError extends SandboxExecutionError>(input: TError): TError {
  assertSandboxError(input);

  return cloneReadonlyValue(input);
}

/**
 * 创建单步沙箱执行结果。
 *
 * 架构意图：
 * 专门用于记录沙箱代码中对 Facade 方法的每一次调用。
 * 它负责校验动作名是否合法、耗时是否有效，并强制要求非 OK 状态下必须携带错误信息。
 *
 * @param input 包含步骤索引、动作名、参数、状态及可选结果/错误的输入
 * @returns 经过校验并克隆的只读步骤结果
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
 * 架构意图：
 * 它是进入沙箱流水线的“通行证”。它聚合了源码、环境快照、任务元数据以及资源限制。
 * 关键在于它强制执行了 log_ref 和 code_ref 的路径引用校验，
 * 确保沙箱产生的日志会被写入正确且安全的物理位置。
 *
 * @param input 包含任务 ID, Bot ID, 纪元, 代码, 日志引用及可选限制的输入
 * @returns 经过校验和冻结的请求对象
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
    type: ExecutionTaskKind.SandboxCode,
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

/**
 * 创建成功完成的沙箱执行结果。
 *
 * 架构意图：
 * 负责聚合成功执行后的全部产物：包括任务元数据、各阶段日志（phase_logs）、
 * 具体的步骤详情（step_results）以及终态摘要。它校验摘要中的步数与实际结果长度的一致性。
 *
 * @param input 包含任务 ID, 日志, 步骤结果及摘要的输入
 * @returns 经过校验并克隆的成功结果对象
 */
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

/**
 * 创建失败结束的沙箱执行结果。
 *
 * 架构意图：
 * 与成功结果类似，但强制要求包含终态错误（error）。它在结果生成时再次执行 assertSandboxError，
 * 确保异常信息在传递出模块前是结构化且合规的。
 *
 * @param input 包含任务 ID, 日志, 步骤结果, 摘要及错误对象的输入
 * @returns 经过校验并克隆的失败结果对象
 */
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

/**
 * 创建被中断的沙箱执行结果。
 *
 * 架构意图：
 * 专门用于处理因外部原因（如用户取消、反射式中断）导致的沙箱终止。
 * 强制要求包含 AbortError 类型的错误对象，记录中断的具体原因。
 *
 * @param input 包含任务 ID, 日志, 步骤结果, 摘要及中断错误的输入
 * @returns 经过校验并克隆的中断结果对象
 */
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
