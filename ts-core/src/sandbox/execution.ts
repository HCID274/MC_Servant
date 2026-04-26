/**
 * 沙箱执行管理与结果封装。
 *
 * 1. 资源限制管理：定义并生成沙箱执行的配额约束（内存、超时、睡眠上限等）。
 * 2. 稳压校验：在执行请求（Request）和执行结果（Result）生成时，执行严格的运行时字段校验和路径引用校验（assertDiagnosticStorageRef）。
 * 3. 结果聚合：提供针对不同终态（Success, Failure, Interrupted）的结果对象工厂，聚合阶段性日志、单步结果和终态摘要。
 * 4. 错误转换：将原始的异常信息包装为符合契约的结构化 SandboxExecutionError。
 */

import { transform } from "esbuild";
import ivm from "isolated-vm";

import { ExecutionTaskKind } from "../core-ports/foundation.js";
import type {
  SandboxFacadeCallControl,
  SandboxFacadeExecutionAdapter,
} from "../core-ports/sandbox.js";
import type { SkillName, SkillParamsByName } from "../core-ports/skills.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { assertDiagnosticStorageRef, createSandboxLogLine } from "../diagnostics/logs.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import {
  type AbortError,
  type FacadeCallError,
  SANDBOX_ERROR_NAMES,
  SANDBOX_STEP_ACTION_NAMES,
  type SandboxExecutionError,
  type SandboxExecutionFailure,
  type SandboxExecutionInterrupted,
  type SandboxExecutionRequest,
  type SandboxExecutionResourceLimits,
  type SandboxExecutionResult,
  type SandboxExecutionSuccess,
  type SandboxStepActionName,
  type SandboxStepParamsByAction,
  type SandboxStepResult,
  type StaticCheckError,
  type TranspileError,
  type UnhandledError,
} from "./contracts.js";

export type { SandboxFacadeCallControl, SandboxFacadeExecutionAdapter };

/** 沙箱执行时暴露给只读 task（任务） 分区的上下文。 */
export interface SandboxExecutionTaskContext {
  /** 任务标识。 */
  readonly id: string;
  /** 用户原始消息。 */
  readonly userMessage: string;
  /** 任务意图。 */
  readonly intent: string;
}

type SandboxHostCallResult = Readonly<Record<string, unknown>>;

interface SandboxExecutionControlState {
  readonly abortController: AbortController;
  readonly activeFacadeCalls: Set<Promise<void>>;
  readonly deadlineMs: number;
  terminalError: SandboxExecutionError | null;
}

const FORBIDDEN_SANDBOX_PATTERNS = Object.freeze([
  { name: "import", pattern: /\bimport(?:\s|\()/ },
  { name: "require", pattern: /\brequire\s*\(/ },
  { name: "process", pattern: /\bprocess\b/ },
  { name: "globalThis", pattern: /\bglobalThis\b/ },
  { name: "eval", pattern: /\beval\s*\(/ },
  { name: "Function", pattern: /\bFunction\s*\(/ },
  { name: "filesystem", pattern: /\b(?:fs|node:fs)\b/ },
  {
    name: "network",
    pattern: /\b(?:net|node:net|http|node:http|https|node:https|fetch|WebSocket)\b/,
  },
] as const);

/** 断言数值是否为正整数。 */
function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

/** 断言数值是否为正数。 */
function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

/** 判断字符串是否为合法的沙箱步骤动作名。 */
function isSandboxStepActionName(value: string): value is SandboxStepActionName {
  return (SANDBOX_STEP_ACTION_NAMES as readonly string[]).includes(value);
}

/** 校验沙箱错误对象的合法性与完整性。 */
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

/** 校验沙箱阶段性日志是否非空。 */
function assertSandboxPhaseLogs(phaseLogs: readonly SandboxJsonlLine[]): void {
  if (phaseLogs.length === 0) {
    throw new Error("phase_logs must contain at least one entry");
  }
}

/** 校验沙箱结果中的日志与代码引用是否符合存储安全契约。 */
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
 * 1. 资源边界设定：合并默认配置与自定义补丁，为沙箱实例划定明确的 CPU 时间、内存及睡眠配额。
 * 2. 约束校验：强制执行安全性约束（如 script_timeout 必须短于总 timeout），作为沙箱安全运行的第一道防线。
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
 * 1. 稳压校验：在错误穿过沙箱边界进入主进程前进行严格审计，确保错误类型属于系统预定义集合。
 * 2. 契约保证：确保所有抛出的沙箱异常均包含必要的上下文信息，保证后续诊断逻辑的一致性。
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
 * 1. 行为审计：专门记录沙箱代码对 Facade 方法的每一次原子调用，是实现沙箱可观测性的基础。
 * 2. 状态联锁：校验动作名的合法性、耗时有效性，并强制要求非 OK 状态必须携带结构化错误信息。
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
 * 1. 准入封装：作为进入沙箱流水线的“通行证”，聚合源码、环境快照及资源限制。
 * 2. 存储安全绑定：强制执行日志与代码引用的安全校验，确保沙箱产出的持久化数据位于正确的物理隔离位置。
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
 * 1. 结果物化：聚合执行后的全部产物，包括阶段性日志、单步详情及终态摘要。
 * 2. 完整性校验：强制校验摘要步数与实际执行结果长度的一致性，确保持久化数据的逻辑严密。
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
 * 1. 故障现场捕获：聚合执行失败时的日志与步骤详情，并强制要求包含终态结构化错误对象。
 * 2. 边界一致性：在输出前再次执行错误校验，确保异常信息符合系统定义的分类契约。
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
 * 1. 中断追溯：专门处理因外部信号（如用户取消、反射式中断）导致的沙箱终止。
 * 2. 原因固定：强制要求包含 AbortError，确保系统能明确记录中断的物理来源与逻辑原因。
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

/**
 * 对沙箱源码执行静态预检。
 *
 * 该检查只作为进入 isolated-vm（隔离虚拟机） 前的第一道硬边界，真正能力仍由 Facade API（门面接口） 注入控制。
 *
 * @param code 待执行源码
 * @returns 通过时返回 null，否则返回结构化静态检查错误
 */
export function checkSandboxSourceStaticPolicy(code: string): StaticCheckError | null {
  assertNonEmptyString(code, "code");

  for (const forbidden of FORBIDDEN_SANDBOX_PATTERNS) {
    if (forbidden.pattern.test(code)) {
      return createSandboxError({
        name: "StaticCheckError",
        message: `Forbidden sandbox capability detected: ${forbidden.name}`,
        recoverable: false,
        violation: forbidden.name,
      });
    }
  }

  return null;
}

/**
 * 在 isolated-vm（隔离虚拟机） 内执行 sandbox_code（沙箱代码）。
 *
 * @param input 沙箱请求、Facade 适配器与只读任务上下文
 * @returns 标准化沙箱执行结果
 */
export async function executeSandboxCodeRequest(input: {
  request: SandboxExecutionRequest;
  facade: SandboxFacadeExecutionAdapter;
  task?: Partial<SandboxExecutionTaskContext>;
  now?: () => number;
}): Promise<SandboxExecutionResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const phaseLogs: SandboxJsonlLine[] = [];
  const stepResults: SandboxStepResult[] = [];
  let lastFacadeError: FacadeCallError | null = null;
  const controlState: SandboxExecutionControlState = {
    abortController: new AbortController(),
    activeFacadeCalls: new Set<Promise<void>>(),
    deadlineMs: startedAt + input.request.resource_limits.timeout_ms,
    terminalError: null,
  };

  const pushPhaseLog = <TLine extends SandboxJsonlLine>(line: TLine): void => {
    phaseLogs.push(createSandboxLogLine(line));
  };

  const finishFailure = (error: SandboxExecutionError): SandboxExecutionFailure =>
    createSandboxExecutionFailure({
      job_id: input.request.job_id,
      bot_id: input.request.bot_id,
      intent_epoch: input.request.intent_epoch,
      log_ref: input.request.log_ref,
      ...(input.request.code_ref !== undefined ? { code_ref: input.request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: stepResults.length,
        duration_ms: Math.max(0, now() - startedAt),
      },
      error,
    });

  const staticCheckError = checkSandboxSourceStaticPolicy(input.request.code);
  pushPhaseLog({
    t: now(),
    phase: "precheck",
    ok: staticCheckError === null,
    ...(staticCheckError !== null ? { violation: staticCheckError.violation } : {}),
  });
  if (staticCheckError !== null) {
    return finishFailure(staticCheckError);
  }

  const transpileStartedAt = now();
  const transpiled = await transpileSandboxCode(input.request.code).catch((error: unknown) => {
    const transpileError = createTranspileError(error);
    pushPhaseLog({
      t: now(),
      phase: "transpile",
      ok: false,
      ms: Math.max(0, now() - transpileStartedAt),
      err: toJsonlErrorSnapshot(transpileError),
    });

    return transpileError;
  });

  if (isSandboxExecutionError(transpiled)) {
    return finishFailure(transpiled);
  }

  pushPhaseLog({
    t: now(),
    phase: "transpile",
    ok: true,
    ms: Math.max(0, now() - transpileStartedAt),
  });

  let isolate: ivm.Isolate | undefined;

  try {
    isolate = new ivm.Isolate({
      memoryLimit: input.request.resource_limits.memory_limit_mb,
    });
    pushPhaseLog({
      t: now(),
      phase: "isolate_create",
      mem_mb: input.request.resource_limits.memory_limit_mb,
    });

    const context = await isolate.createContext();
    await context.global.set(
      "__sandboxHostCall",
      new ivm.Reference(async (method: string, args: readonly unknown[]) =>
        handleSandboxHostCall({
          method,
          args,
          facade: input.facade,
          phaseLogs,
          stepResults,
          controlState,
          resourceLimits: input.request.resource_limits,
          setLastFacadeError: (error) => {
            lastFacadeError = error;
          },
          now,
        }),
      ),
    );

    const taskContext = {
      id: input.task?.id ?? input.request.job_id,
      userMessage: input.task?.userMessage ?? "",
      intent: input.task?.intent ?? "sandbox_code",
    };

    await context.eval(createSandboxBootstrapScript(taskContext), {
      timeout: input.request.resource_limits.script_timeout_ms,
    });

    const script = await isolate.compileScript(transpiled);
    await runSandboxScriptWithTimeout(
      script.run(context, {
        promise: true,
        copy: true,
        timeout: input.request.resource_limits.script_timeout_ms,
      }),
      input.request.resource_limits,
      controlState,
    );

    const terminalFacadeError = lastFacadeError ?? findFacadeStepError(stepResults);
    if (terminalFacadeError !== null) {
      markSandboxTerminalError(controlState, terminalFacadeError);
      pushPhaseLog({
        t: now(),
        phase: "sandbox_done",
        steps: stepResults.length,
        ms: Math.max(0, now() - startedAt),
      });

      return finishFailure(terminalFacadeError);
    }

    pushPhaseLog({
      t: now(),
      phase: "sandbox_complete",
      steps: stepResults.length,
      ms: Math.max(0, now() - startedAt),
    });

    return createSandboxExecutionSuccess({
      job_id: input.request.job_id,
      bot_id: input.request.bot_id,
      intent_epoch: input.request.intent_epoch,
      log_ref: input.request.log_ref,
      ...(input.request.code_ref !== undefined ? { code_ref: input.request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: stepResults.length,
        duration_ms: Math.max(0, now() - startedAt),
      },
    });
  } catch (error) {
    const sandboxError =
      lastFacadeError ??
      controlState.terminalError ??
      (isSandboxExecutionError(error)
        ? error
        : createRuntimeSandboxError(error, input.request.resource_limits));
    markSandboxTerminalError(controlState, sandboxError);
    await waitForActiveFacadeCalls(
      controlState,
      input.request.resource_limits.abort_cleanup_timeout_ms,
    );
    pushPhaseLog({
      t: now(),
      phase: "sandbox_done",
      steps: stepResults.length,
      ms: Math.max(0, now() - startedAt),
    });

    return finishFailure(sandboxError);
  } finally {
    isolate?.dispose();
  }
}

async function transpileSandboxCode(code: string): Promise<string> {
  const wrappedCode = `(async () => {\n${code}\n})()`;
  const output = await transform(wrappedCode, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcemap: false,
  });

  return output.code;
}

function createSandboxBootstrapScript(task: SandboxExecutionTaskContext): string {
  const taskJson = JSON.stringify(task);

  return `
    const __sandboxHostCallRef = __sandboxHostCall;
    delete globalThis.__sandboxHostCall;
    const __sandboxCall = (method, args) =>
      __sandboxHostCallRef.apply(undefined, [method, args], {
        arguments: { copy: true },
        result: { promise: true, copy: true }
      });
    globalThis.api = Object.freeze({
      bot: Object.freeze({
        goTo: (...args) => __sandboxCall("bot.goTo", args),
        mine: (...args) => __sandboxCall("bot.mine", args),
        collect: (...args) => __sandboxCall("bot.collect", args),
        equip: (...args) => __sandboxCall("bot.equip", args),
        cutTree: (...args) => __sandboxCall("bot.cutTree", args)
      }),
      chat: Object.freeze({
        say: (...args) => __sandboxCall("chat.say", args),
        report: (...args) => __sandboxCall("chat.report", args)
      }),
      task: Object.freeze(${taskJson})
    });
  `;
}

async function handleSandboxHostCall(input: {
  method: string;
  args: readonly unknown[];
  facade: SandboxFacadeExecutionAdapter;
  phaseLogs: SandboxJsonlLine[];
  stepResults: SandboxStepResult[];
  controlState: SandboxExecutionControlState;
  resourceLimits: SandboxExecutionResourceLimits;
  setLastFacadeError: (error: FacadeCallError) => void;
  now: () => number;
}): Promise<SandboxHostCallResult> {
  const action = toSandboxStepActionName(input.method);
  const params = normalizeSandboxCallParams(action, input.args);
  const startedAt = input.now();

  assertSandboxFacadeCallAllowed(input.controlState, input.resourceLimits, input.now());

  input.phaseLogs.push(
    createSandboxLogLine({
      t: input.now(),
      phase: "facade_call",
      m: action,
      p: params,
    }),
  );

  try {
    const control = createSandboxFacadeCallControl(input.controlState);
    const result =
      action === "say" || action === "report"
        ? await trackSandboxFacadeCall(
            input.controlState,
            input.facade.writeChat(action, params as SandboxStepParamsByAction["say"], control),
          )
        : await trackSandboxFacadeCall(
            input.controlState,
            executeSandboxBotFacadeCall(input.facade, action, params, control),
          );

    if (input.controlState.terminalError !== null) {
      throw input.controlState.terminalError;
    }

    const durationMs = Math.max(0, input.now() - startedAt);
    const step = createSandboxStepResult({
      step_index: input.stepResults.length,
      action,
      params,
      status: "ok",
      duration_ms: durationMs,
      result,
    });
    input.stepResults.push(step);
    input.phaseLogs.push(
      createSandboxLogLine({
        t: input.now(),
        phase: "facade_result",
        m: action,
        s: "ok",
        r: result,
        ms: durationMs,
      }),
    );

    return result;
  } catch (error) {
    if (
      input.controlState.terminalError !== null &&
      input.controlState.terminalError.name !== "FacadeCallError"
    ) {
      const terminalError = input.controlState.terminalError;
      const durationMs = Math.max(0, input.now() - startedAt);
      input.stepResults.push(
        createSandboxStepResult({
          step_index: input.stepResults.length,
          action,
          params,
          status: "err",
          duration_ms: durationMs,
          error: terminalError,
        }),
      );
      input.phaseLogs.push(
        createSandboxLogLine({
          t: input.now(),
          phase: "facade_result",
          m: action,
          s: "err",
          err: toJsonlErrorSnapshot(terminalError),
          ms: durationMs,
        }),
      );

      throw new Error(terminalError.message);
    }

    const facadeError = createFacadeCallError(action, params, error);
    input.setLastFacadeError(facadeError);
    markSandboxTerminalError(input.controlState, facadeError);
    const durationMs = Math.max(0, input.now() - startedAt);
    input.stepResults.push(
      createSandboxStepResult({
        step_index: input.stepResults.length,
        action,
        params,
        status: "err",
        duration_ms: durationMs,
        error: facadeError,
      }),
    );
    input.phaseLogs.push(
      createSandboxLogLine({
        t: input.now(),
        phase: "facade_result",
        m: action,
        s: "err",
        err: toJsonlErrorSnapshot(facadeError),
        ms: durationMs,
      }),
    );

    throw new Error(facadeError.message);
  }
}

function toSandboxStepActionName(method: string): SandboxStepActionName {
  const action =
    method.startsWith("bot.") || method.startsWith("chat.")
      ? method.slice(method.indexOf(".") + 1)
      : method;

  if (!isSandboxStepActionName(action)) {
    throw new Error(`Unsupported Facade method: ${method}`);
  }

  return action;
}

function normalizeSandboxCallParams(
  action: SandboxStepActionName,
  args: readonly unknown[],
): SandboxStepResult["params"] {
  const first = args[0];

  if (action === "goTo") {
    if (args.length === 3) {
      return { x: Number(args[0]), y: Number(args[1]), z: Number(args[2]) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["goTo"];
  }

  if (action === "mine") {
    if (typeof first === "string") {
      return { blockName: first, count: Number(args[1] ?? 1) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["mine"];
  }

  if (action === "collect") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(args[1] !== undefined ? { radius: Number(args[1]) } : {}),
      };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["collect"];
  }

  if (action === "equip") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(typeof args[1] === "string" ? { destination: args[1] } : {}),
      } as SandboxStepParamsByAction["equip"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["equip"];
  }

  if (action === "cutTree") {
    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["cutTree"];
  }

  if (typeof first !== "string" || first.trim().length === 0) {
    return { message: "" };
  }

  return { message: first };
}

async function executeSandboxBotFacadeCall(
  facade: SandboxFacadeExecutionAdapter,
  action: Exclude<SandboxStepActionName, "say" | "report">,
  params: SandboxStepResult["params"],
  control: SandboxFacadeCallControl,
): Promise<Readonly<Record<string, unknown>>> {
  if (action === "cutTree") {
    throw new Error("cutTree is not executable in the current runtime sandbox");
  }

  return facade.executeBotSkill(action, params as SkillParamsByName[typeof action], control);
}

function createSandboxFacadeCallControl(
  state: SandboxExecutionControlState,
): SandboxFacadeCallControl {
  return Object.freeze({
    signal: state.abortController.signal,
    deadline_ms: state.deadlineMs,
  });
}

function assertSandboxFacadeCallAllowed(
  state: SandboxExecutionControlState,
  limits: SandboxExecutionResourceLimits,
  now: number,
): void {
  if (state.terminalError !== null) {
    throw new Error(state.terminalError.message);
  }

  if (state.abortController.signal.aborted || now >= state.deadlineMs) {
    const timeoutError = createSandboxTimeoutError(limits);
    markSandboxTerminalError(state, timeoutError);
    abortSandboxFacadeCalls(state, timeoutError);
    throw new Error(timeoutError.message);
  }
}

function markSandboxTerminalError(
  state: SandboxExecutionControlState,
  error: SandboxExecutionError,
): void {
  if (state.terminalError === null) {
    state.terminalError = error;
    abortSandboxFacadeCalls(state, error);
  }
}

function abortSandboxFacadeCalls(
  state: SandboxExecutionControlState,
  error: SandboxExecutionError,
): void {
  if (!state.abortController.signal.aborted) {
    state.abortController.abort(error);
  }
}

async function trackSandboxFacadeCall<TValue>(
  state: SandboxExecutionControlState,
  call: Promise<TValue>,
): Promise<TValue> {
  const trackedCall = call.then(
    () => undefined,
    () => undefined,
  );
  state.activeFacadeCalls.add(trackedCall);

  try {
    return await call;
  } finally {
    state.activeFacadeCalls.delete(trackedCall);
  }
}

async function waitForActiveFacadeCalls(
  state: SandboxExecutionControlState,
  cleanupTimeoutMs: number,
): Promise<void> {
  const activeCalls = [...state.activeFacadeCalls];

  if (activeCalls.length === 0) {
    return;
  }

  await Promise.race([
    Promise.allSettled(activeCalls),
    new Promise<void>((resolve) => {
      setTimeout(resolve, cleanupTimeoutMs);
    }),
  ]);
}

function findFacadeStepError(stepResults: readonly SandboxStepResult[]): FacadeCallError | null {
  for (const stepResult of stepResults) {
    if (stepResult.status === "err" && stepResult.error?.name === "FacadeCallError") {
      return stepResult.error;
    }
  }

  return null;
}

function createFacadeCallError(
  action: SandboxStepActionName,
  params: SandboxStepResult["params"],
  error: unknown,
): FacadeCallError {
  return createSandboxError({
    name: "FacadeCallError",
    message: error instanceof Error ? error.message : String(error),
    recoverable: true,
    method: action,
    params: params as Readonly<Record<string, unknown>>,
    error_code: "facade_call_failed",
  });
}

function createTranspileError(error: unknown): TranspileError {
  return createSandboxError({
    name: "TranspileError",
    message: "Sandbox TypeScript transpile failed",
    recoverable: false,
    diagnostics: [error instanceof Error ? error.message : String(error)],
  });
}

function createRuntimeSandboxError(
  error: unknown,
  limits: SandboxExecutionResourceLimits,
): SandboxExecutionError {
  if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
    return createSandboxTimeoutError(limits);
  }

  if (error instanceof Error && error.message.includes("Array buffer allocation failed")) {
    return createSandboxError({
      name: "SandboxOOMError",
      message: error.message,
      recoverable: false,
      memory_limit_mb: limits.memory_limit_mb,
    });
  }

  const unhandledError: UnhandledError = {
    name: "UnhandledError",
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };

  return createSandboxError(unhandledError);
}

function createSandboxTimeoutError(limits: SandboxExecutionResourceLimits): SandboxExecutionError {
  return createSandboxError({
    name: "SandboxTimeoutError",
    message: "Sandbox execution timed out",
    recoverable: false,
    timeout_ms: limits.timeout_ms,
  });
}

function isSandboxExecutionError(value: unknown): value is SandboxExecutionError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (SANDBOX_ERROR_NAMES as readonly string[]).includes(String(value.name))
  );
}

function toJsonlErrorSnapshot(error: SandboxExecutionError): {
  readonly name: string;
  readonly message: string;
  readonly error_code?: string;
  readonly recoverable?: boolean;
} {
  return Object.freeze({
    name: error.name,
    message: error.message,
    ...("error_code" in error ? { error_code: error.error_code } : {}),
    recoverable: error.recoverable,
  });
}

function runSandboxScriptWithTimeout<TValue>(
  execution: Promise<TValue>,
  limits: SandboxExecutionResourceLimits,
  state: SandboxExecutionControlState,
): Promise<TValue> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = createSandboxTimeoutError(limits);
      markSandboxTerminalError(state, timeoutError);
      abortSandboxFacadeCalls(state, timeoutError);
      reject(timeoutError);
    }, limits.timeout_ms);
  });

  return Promise.race([execution, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}
