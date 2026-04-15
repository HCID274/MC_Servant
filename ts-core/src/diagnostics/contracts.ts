/**
 * 结构化日志契约与行工厂。
 *
 * 架构职责：
 * 1. 协议定义：定义 tasks, sandbox, llm 三个通道的 JSONL 行结构。使用短字段名（如 t, e, i, s）以优化存储和传输。
 * 2. 转换逻辑：提供核心工厂函数，将运行时的复杂事件（如 TaskLifecycleEvent）转换为紧凑的、持久化友好的日志行。
 * 3. 稳压处理：通过 freezeDiagnosticValue 确保日志数据的不可变性，并对其中的错误快照、参数等进行深层处理。
 */

import { TASK_PROGRESS_STATUSES, type TaskProgressStatus } from "../data/contracts.js";
import { JSONL_LOG_DIRECTORIES, type JsonlLogDirectory } from "../data/logs.js";
import type { ExecutionTaskKind } from "../domain/contracts.js";
import type { InterruptSource } from "../runtime/contracts.js";
import type {
  TaskFailedErrorSnapshot,
  TaskLifecycleEvent,
  TaskLifecycleEventPayloadByStatus,
  TaskLifecycleEventTypeByStatus,
} from "../runtime/events.js";
import { TaskHistoryStatus, type TaskTerminalStatus } from "../runtime/tasking.js";

/** diagnostics（诊断） 模块支持的 JSONL（结构化日志） 通道清单。 */
export const DIAGNOSTIC_LOG_CHANNELS = [...JSONL_LOG_DIRECTORIES] as const;

/** diagnostics（诊断） 模块支持的 JSONL（结构化日志） 通道联合类型。 */
export type DiagnosticLogChannel = JsonlLogDirectory;

/** JSONL（结构化日志） 内复用的错误快照结构。 */
export interface JsonlErrorSnapshot {
  /** 错误分类名。 */
  readonly name: string;
  /** 错误消息。 */
  readonly message: string;
  /** 可选错误码。 */
  readonly error_code?: string;
  /** 是否可恢复。 */
  readonly recoverable?: boolean;
}

/** tasks（任务执行） 通道允许的步骤状态。 */
export const TASK_LOG_STEP_STATUSES = TASK_PROGRESS_STATUSES;

/** tasks（任务执行） 通道步骤状态联合类型。 */
export type TaskLogStepStatus = TaskProgressStatus;

/** tasks（任务执行） 通道的开始事件结构。 */
export interface TaskStartedJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 事件类型。 */
  readonly e: "task.started";
  /** 任务标识。 */
  readonly job: string;
  /** 执行任务类型。 */
  readonly type: ExecutionTaskKind;
  /** 意图纪元。 */
  readonly epoch: number;
}

/** tasks（任务执行） 通道的步骤事件结构。 */
export interface TaskStepJsonlLine<
  TAction extends string = string,
  TParams = unknown,
  TResult = unknown,
> {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 事件类型。 */
  readonly e: "step";
  /** 步骤索引。 */
  readonly i: number;
  /** 动作名。 */
  readonly act: TAction;
  /** 步骤参数。 */
  readonly p?: Readonly<TParams>;
  /** 步骤状态。 */
  readonly s: TaskLogStepStatus;
  /** 步骤返回值。 */
  readonly r?: Readonly<TResult>;
  /** 步骤耗时。 */
  readonly ms?: number;
  /** 失败时的结构化错误。 */
  readonly err?: JsonlErrorSnapshot;
}

/** tasks（任务执行） 通道的完成事件结构。 */
export interface TaskCompletedJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 事件类型。 */
  readonly e: "task.completed";
  /** 任务标识。 */
  readonly job: string;
  /** 总步骤数。 */
  readonly steps: number;
  /** 总耗时。 */
  readonly ms: number;
}

/** tasks（任务执行） 通道的失败事件结构。 */
export interface TaskFailedJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 事件类型。 */
  readonly e: "task.failed";
  /** 任务标识。 */
  readonly job: string;
  /** 总步骤数。 */
  readonly steps: number;
  /** 总耗时。 */
  readonly ms: number;
  /** 失败错误快照。 */
  readonly err: JsonlErrorSnapshot;
}

/** tasks（任务执行） 通道的中断事件结构。 */
export interface TaskInterruptedJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 事件类型。 */
  readonly e: "task.interrupted";
  /** 任务标识。 */
  readonly job: string;
  /** 总步骤数。 */
  readonly steps: number;
  /** 总耗时。 */
  readonly ms: number;
  /** 中断来源标识。 */
  readonly reason: string;
}

/** tasks（任务执行） 通道的日志行联合类型。 */
export type TaskJsonlLine<TAction extends string = string> =
  | TaskStartedJsonlLine
  | TaskStepJsonlLine<TAction>
  | TaskCompletedJsonlLine
  | TaskFailedJsonlLine
  | TaskInterruptedJsonlLine;

/** tasks（任务执行） 通道允许写入摘要的生命周期状态。 */
export type TaskLifecycleSummaryStatus = TaskHistoryStatus.Started | TaskTerminalStatus;

/** tasks（任务执行） 通道 started（已开始） 摘要结构。 */
export interface TaskStartedSummaryJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 诊断通道。 */
  readonly channel: "tasks";
  /** 生命周期状态。 */
  readonly status: TaskHistoryStatus.Started;
  /** 对齐 runtime（运行时） 的事件名。 */
  readonly e: TaskLifecycleEventTypeByStatus<TaskHistoryStatus.Started>;
  /** 任务标识。 */
  readonly job: string;
  /** 执行任务类型。 */
  readonly type: ExecutionTaskKind;
  /** 意图纪元。 */
  readonly epoch: number;
}

/** tasks（任务执行） 通道终态摘要公共结构。 */
export interface TaskTerminalSummaryJsonlLineBase<TStatus extends TaskTerminalStatus> {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 诊断通道。 */
  readonly channel: "tasks";
  /** 生命周期状态。 */
  readonly status: TStatus;
  /** 对齐 runtime（运行时） 的事件名。 */
  readonly e: TaskLifecycleEventTypeByStatus<TStatus>;
  /** 任务标识。 */
  readonly job: string;
  /** 执行任务类型。 */
  readonly type: ExecutionTaskKind;
  /** 意图纪元。 */
  readonly epoch: number;
  /** 总步骤数。 */
  readonly steps: number;
  /** 总耗时。 */
  readonly ms: number;
}

/** tasks（任务执行） 通道 completed（已完成） 摘要结构。 */
export interface TaskCompletedSummaryJsonlLine
  extends TaskTerminalSummaryJsonlLineBase<TaskHistoryStatus.Completed> {}

/** tasks（任务执行） 通道 failed（已失败） 摘要结构。 */
export interface TaskFailedSummaryJsonlLine
  extends TaskTerminalSummaryJsonlLineBase<TaskHistoryStatus.Failed> {
  /** 失败错误快照。 */
  readonly err: TaskFailedErrorSnapshot;
  /** 最后一个已知步骤名。 */
  readonly last_step?: string;
}

/** tasks（任务执行） 通道 interrupted（已中断） 摘要结构。 */
export interface TaskInterruptedSummaryJsonlLine
  extends TaskTerminalSummaryJsonlLineBase<TaskHistoryStatus.Interrupted> {
  /** 中断来源。 */
  readonly interrupt_source: InterruptSource;
  /** 中断原因。 */
  readonly reason: string;
}

/** tasks（任务执行） 通道生命周期摘要联合。 */
export type TaskLifecycleSummaryJsonlLine =
  | TaskStartedSummaryJsonlLine
  | TaskCompletedSummaryJsonlLine
  | TaskFailedSummaryJsonlLine
  | TaskInterruptedSummaryJsonlLine;

function freezeDiagnosticValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeDiagnosticValue(item))) as T;
  }
  if (value && typeof value === "object") {
    const clonedEntries = Object.entries(value as Record<string, unknown>).map(
      ([key, entryValue]) => [key, freezeDiagnosticValue(entryValue)],
    );

    return Object.freeze(Object.fromEntries(clonedEntries)) as T;
  }

  return value;
}

/**
 * 创建任务执行通道的生命周期摘要行。
 *
 * 架构意图：
 * 它是运行时生命周期事件到 JSONL 持久化行的“翻译官”。
 * 针对 Started, Completed, Failed, Interrupted 四种状态，分别映射为不同的日志载荷。
 * 尤其在 Failed 和 Interrupted 状态下，它会额外提取错误信息或中断来源。
 *
 * @param input 包含 Unix 时间戳和生命周期事件的输入
 * @returns 格式化后的 JSONL 摘要行
 */
export function createTaskLifecycleSummaryJsonlLine(input: {
  t: number;
  lifecycle: TaskLifecycleEvent<TaskHistoryStatus.Started>;
}): TaskStartedSummaryJsonlLine;

/** 创建 completed（已完成） 生命周期摘要行。 */
export function createTaskLifecycleSummaryJsonlLine(input: {
  t: number;
  lifecycle: TaskLifecycleEvent<TaskHistoryStatus.Completed>;
}): TaskCompletedSummaryJsonlLine;

/** 创建 failed（已失败） 生命周期摘要行。 */
export function createTaskLifecycleSummaryJsonlLine(input: {
  t: number;
  lifecycle: TaskLifecycleEvent<TaskHistoryStatus.Failed>;
}): TaskFailedSummaryJsonlLine;

/** 创建 interrupted（已中断） 生命周期摘要行。 */
export function createTaskLifecycleSummaryJsonlLine(input: {
  t: number;
  lifecycle: TaskLifecycleEvent<TaskHistoryStatus.Interrupted>;
}): TaskInterruptedSummaryJsonlLine;

/** 创建 tasks（任务执行） 通道的生命周期摘要行。 */
export function createTaskLifecycleSummaryJsonlLine(input: {
  t: number;
  lifecycle: TaskLifecycleEvent<TaskLifecycleSummaryStatus>;
}): TaskLifecycleSummaryJsonlLine {
  switch (input.lifecycle.status) {
    case TaskHistoryStatus.Started:
      return Object.freeze({
        t: input.t,
        channel: "tasks",
        status: TaskHistoryStatus.Started,
        e: "task.started",
        job: input.lifecycle.payload.job_id,
        type: input.lifecycle.payload.type,
        epoch: input.lifecycle.payload.epoch,
      });
    case TaskHistoryStatus.Completed: {
      const payload = input.lifecycle
        .payload as TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Completed>;
      return Object.freeze({
        t: input.t,
        channel: "tasks",
        status: TaskHistoryStatus.Completed,
        e: "task.completed",
        job: payload.job_id,
        type: payload.type,
        epoch: payload.epoch,
        steps: payload.total_steps,
        ms: payload.duration_ms,
      });
    }
    case TaskHistoryStatus.Failed: {
      const payload = input.lifecycle
        .payload as TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Failed>;
      return Object.freeze({
        t: input.t,
        channel: "tasks",
        status: TaskHistoryStatus.Failed,
        e: "task.failed",
        job: payload.job_id,
        type: payload.type,
        epoch: payload.epoch,
        steps: payload.total_steps,
        ms: payload.duration_ms,
        err: freezeDiagnosticValue(payload.error),
        ...(payload.last_step ? { last_step: payload.last_step } : {}),
      });
    }
    case TaskHistoryStatus.Interrupted: {
      const payload = input.lifecycle
        .payload as TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Interrupted>;
      return Object.freeze({
        t: input.t,
        channel: "tasks",
        status: TaskHistoryStatus.Interrupted,
        e: "task.interrupted",
        job: payload.job_id,
        type: payload.type,
        epoch: payload.epoch,
        steps: payload.total_steps,
        ms: payload.duration_ms,
        interrupt_source: freezeDiagnosticValue(payload.interrupt_source),
        reason: payload.reason,
      });
    }
  }

  throw new Error("Unhandled task lifecycle summary status");
}

/** sandbox（沙箱执行） 通道允许的阶段名。 */
export const SANDBOX_LOG_PHASES = [
  "precheck",
  "transpile",
  "isolate_create",
  "facade_call",
  "facade_result",
  "console",
  "sandbox_complete",
  "sandbox_done",
] as const;

/** sandbox（沙箱执行） 通道阶段名联合类型。 */
export type SandboxLogPhase = (typeof SANDBOX_LOG_PHASES)[number];

/** sandbox（沙箱执行） 通道的结束阶段名联合类型。 */
export type SandboxTerminalPhase = Extract<SandboxLogPhase, "sandbox_complete" | "sandbox_done">;

/** sandbox（沙箱执行） 通道的静态预检阶段结构。 */
export interface SandboxPrecheckJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "precheck";
  /** 是否通过。 */
  readonly ok: boolean;
  /** 命中的禁止模式。 */
  readonly violation?: string;
}

/** sandbox（沙箱执行） 通道的转译阶段结构。 */
export interface SandboxTranspileJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "transpile";
  /** 是否通过。 */
  readonly ok: boolean;
  /** 转译耗时。 */
  readonly ms?: number;
  /** 转译错误快照。 */
  readonly err?: JsonlErrorSnapshot;
}

/** sandbox（沙箱执行） 通道的隔离实例创建阶段结构。 */
export interface SandboxIsolateCreateJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "isolate_create";
  /** 内存上限。 */
  readonly mem_mb: number;
}

/** sandbox（沙箱执行） 通道的 Facade 调用阶段结构。 */
export interface SandboxFacadeCallJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "facade_call";
  /** Facade 方法名。 */
  readonly m: string;
  /** 调用参数。 */
  readonly p?: Readonly<Record<string, unknown>>;
}

/** sandbox（沙箱执行） 通道的 Facade 返回阶段结构。 */
export interface SandboxFacadeResultJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "facade_result";
  /** Facade 方法名。 */
  readonly m: string;
  /** 调用状态。 */
  readonly s: "ok" | "err" | "abort";
  /** 调用结果。 */
  readonly r?: Readonly<Record<string, unknown>>;
  /** 调用耗时。 */
  readonly ms?: number;
  /** 失败或中断错误。 */
  readonly err?: JsonlErrorSnapshot;
}

/** sandbox（沙箱执行） 通道的 console（控制台） 阶段结构。 */
export interface SandboxConsoleJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: "console";
  /** 控制台级别。 */
  readonly lvl: "log" | "warn" | "error";
  /** 输出参数。 */
  readonly args: readonly unknown[];
}

/** sandbox（沙箱执行） 通道的结束阶段结构。 */
export interface SandboxTerminalJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 阶段名。 */
  readonly phase: SandboxTerminalPhase;
  /** 总步骤数。 */
  readonly steps: number;
  /** 总耗时。 */
  readonly ms: number;
}

/** sandbox（沙箱执行） 通道的日志行联合类型。 */
export type SandboxJsonlLine =
  | SandboxPrecheckJsonlLine
  | SandboxTranspileJsonlLine
  | SandboxIsolateCreateJsonlLine
  | SandboxFacadeCallJsonlLine
  | SandboxFacadeResultJsonlLine
  | SandboxConsoleJsonlLine
  | SandboxTerminalJsonlLine;

/** llm（大语言模型） 通道当前声明的调用阶段。 */
export const LLM_LOG_STAGES = ["triage", "chat", "plan"] as const;

/** llm（大语言模型） 通道调用阶段联合类型。 */
export type LlmLogStage = (typeof LLM_LOG_STAGES)[number];

/** llm（大语言模型） transcript（原始对话记录） 允许的角色。 */
export const LLM_TRANSCRIPT_ROLES = ["system", "user", "assistant"] as const;

/** llm（大语言模型） transcript（原始对话记录） 角色联合类型。 */
export type LlmTranscriptRole = (typeof LLM_TRANSCRIPT_ROLES)[number];

/** llm（大语言模型） 通道的调用头行结构。 */
export interface LlmInvocationJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 调用阶段。 */
  readonly stage: LlmLogStage;
  /** 模型名。 */
  readonly model: string;
  /** 原始消息标识。 */
  readonly msg_id: string;
}

/** llm（大语言模型） 通道的 transcript（原始对话记录） 行结构。 */
export interface LlmTranscriptJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 对话角色。 */
  readonly role: LlmTranscriptRole;
  /** 原始文本。 */
  readonly content: string;
}

/** llm（大语言模型） 通道的元信息行结构。 */
export interface LlmMetaJsonlLine {
  /** Unix 时间戳（秒）。 */
  readonly t: number;
  /** 调用元信息。 */
  readonly meta: Readonly<{
    /** 输入 token（令牌） 数。 */
    input_tokens: number;
    /** 输出 token（令牌） 数。 */
    output_tokens: number;
    /** 调用耗时。 */
    ms: number;
    /** 调用是否成功。 */
    ok: boolean;
  }>;
}

/** llm（大语言模型） 通道的日志行联合类型。 */
export type LlmJsonlLine = LlmInvocationJsonlLine | LlmTranscriptJsonlLine | LlmMetaJsonlLine;

/** diagnostics（诊断） 模块统一的日志行联合类型。 */
export type DiagnosticsJsonlLine<TAction extends string = string> =
  | TaskJsonlLine<TAction>
  | SandboxJsonlLine
  | LlmJsonlLine;
