import { JSONL_LOG_DIRECTORIES, type JsonlLogDirectory } from "../data/logs.js";
import type { ExecutionTaskKind } from "../domain/contracts.js";

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
export const TASK_LOG_STEP_STATUSES = ["ok", "err", "abort"] as const;

/** tasks（任务执行） 通道步骤状态联合类型。 */
export type TaskLogStepStatus = (typeof TASK_LOG_STEP_STATUSES)[number];

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
