/** TS Core 内的顶层模块名集合。 */
export const CORE_MODULE_NAMES = [
  "runtime",
  "skills",
  "observation",
  "world-model",
  "diagnostics",
  "domain",
  "data",
] as const;

/** TS Core 内的顶层模块名联合类型。 */
export type CoreModuleName = (typeof CORE_MODULE_NAMES)[number];

/** 对话入口任务类型枚举，用于描述 ConversationWorker 的输入任务。 */
export enum ConversationTaskKind {
  Message = "conversation",
}

/** 对话优先级枚举，用于描述 ConversationWorker 的分诊结果。 */
export enum ConversationPriority {
  Interrupt = "interrupt",
  Urgent = "urgent",
  Normal = "normal",
  Background = "background",
}

/** 执行任务类型枚举，用于描述 BotActor 可消费的 ExecJob 类型。 */
export enum ExecutionTaskKind {
  SkillCall = "skill_call",
  SandboxCode = "sandbox_code",
}

/** 消息来源枚举，用于统一描述外部输入通道。 */
export enum MessageSource {
  Web = "web",
  Game = "game",
  System = "system",
}

/** 事件日志级别枚举。 */
export enum EventLogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

/** 事件日志基础结构。 */
export interface EventLogEntry<TEventType extends string = string> {
  /** 事件唯一标识。 */
  eventId: string;
  /** 事件类型标识。 */
  type: TEventType;
  /** 事件日志级别。 */
  level: EventLogLevel;
  /** 事件来源通道。 */
  source: MessageSource;
  /** 事件产生时间。 */
  timestamp: string;
  /** 关联的任务标识。 */
  taskId?: string;
  /** 关联的 Bot 标识。 */
  botId?: string;
  /** 事件扩展载荷。 */
  payload?: Readonly<Record<string, unknown>>;
}

/** 通用任务包结构，用于后续不同工作线程之间传递任务。 */
export interface TaskEnvelope<TKind extends string> {
  /** 任务唯一标识。 */
  taskId: string;
  /** 任务分类。 */
  kind: TKind;
  /** 任务来源通道。 */
  source: MessageSource;
  /** 任务创建时间。 */
  createdAt: string;
  /** 任务载荷。 */
  payload: Readonly<Record<string, unknown>>;
}

/** 对话入口任务包结构，用于承载 ConversationWorker 的输入边界。 */
export type ConversationTaskEnvelope = TaskEnvelope<ConversationTaskKind>;

/** 执行任务包结构，用于承载 BotActor 的输入边界。 */
export type ExecutionTaskEnvelope = TaskEnvelope<ExecutionTaskKind>;

/** 对话分诊结果结构，用于描述意图与紧迫度判断。 */
export interface MessageTriage {
  /** 意图分类。 */
  intent: "chat" | "task" | "modify" | "cancel";
  /** 紧迫度分类。 */
  priority: ConversationPriority;
  /** 判断依据。 */
  reason: string;
}

/** 模块边界描述结构，用于工程骨架阶段声明职责范围。 */
export interface ModuleBoundary {
  /** 模块名。 */
  moduleName: CoreModuleName;
  /** 模块职责列表。 */
  responsibilities: readonly string[];
  /** 当前阶段仅提供的占位导出清单。 */
  placeholderExports: readonly string[];
}
