/**
 * 核心端口基础契约。
 *
 * 这些枚举与基础包结构会被 runtime、conversation、workers、data 与 interfaces 共同使用，
 * 因此放在 core-ports（核心端口层），避免业务模块为了共享基础类型互相依赖。
 */

/** 对话入口任务类型枚举，用于描述 ConversationWorker（对话工作线程） 的输入任务。 */
export enum ConversationTaskKind {
  Message = "conversation",
}

/** 对话优先级枚举，用于描述 ConversationWorker（对话工作线程） 的分诊结果。 */
export enum ConversationPriority {
  Interrupt = "interrupt",
  Urgent = "urgent",
  Normal = "normal",
  Background = "background",
}

/** 执行任务类型枚举，用于描述 BotActor（机器人执行代理） 可消费的 ExecJob（执行任务）。 */
export enum ExecutionTaskKind {
  Code = "code",
}

/** 消息来源枚举，用于统一描述外部输入通道。 */
export enum MessageSource {
  Web = "web",
  Game = "game",
  ServerBridge = "server_bridge",
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

/** 对话入口任务包结构，用于承载 ConversationWorker（对话工作线程） 的输入边界。 */
export type ConversationTaskEnvelope = TaskEnvelope<ConversationTaskKind>;

/** 执行任务包结构，用于承载 BotActor（机器人执行代理） 的输入边界。 */
export type ExecutionTaskEnvelope = TaskEnvelope<ExecutionTaskKind>;

/** 对话分诊结果结构，用于描述意图与紧迫度判断。 */
export interface MessageTriage {
  /** 意图分类。 */
  intent: "chat" | "task" | "cancel";
  /** 紧迫度分类。 */
  priority: ConversationPriority;
  /** 判断依据。 */
  reason: string;
}
