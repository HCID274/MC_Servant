import type {
  ConversationPlanDraft,
  ConversationPlanningTriage,
  ConversationRouteDecision,
  ConversationTriageOutput,
} from "../../conversation/contracts.js";
import type {
  ConversationGeneratedReply,
  ConversationLlmDiagnosticRecord,
} from "../../conversation/llm.js";
import type { MessageTriage } from "../../core-ports/foundation.js";
import type { BotActorStateProjection } from "../../core-ports/runtime.js";
import type { SkillName } from "../../core-ports/skills.js";
import type { ExecPriority, TaskHistoryStatus } from "../../core-ports/tasking.js";
import type { RedisClientLike } from "../../db/index.js";
import type {
  BotWorkerTask,
  ConversationWorkerTask,
  InterruptRuntimeAction,
} from "../contracts.js";
import type { MessageQueueName } from "../queues.js";

export type ConversationWorkerRuntimeEvent =
  | {
      /** 事件类型。 */
      readonly type: "chat.reply";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 回复内容。 */
      readonly content: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "llm.chat.diagnostic";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 调用阶段。 */
      readonly stage: ConversationLlmDiagnosticRecord["stage"];
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 模型名。 */
      readonly model: string;
      /** 日志引用。 */
      readonly log_ref: string;
      /** 创建时间。 */
      readonly created_at: string;
      /** 是否成功。 */
      readonly ok: boolean;
      /** 失败摘要。 */
      readonly error_summary?: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "cancel.logged";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 取消原因。 */
      readonly reason: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "task.discarded";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 任务历史状态。 */
      readonly status: TaskHistoryStatus.Discarded;
      /** 丢弃原因。 */
      readonly reason: "planner_unavailable" | "planner_failed" | "skill_not_enabled";
    }
  | {
      /** 事件类型。 */
      readonly type: "task.accepted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 技能名。 */
      readonly skill: SkillName;
      /** 执行队列优先级。 */
      readonly priority: ExecPriority;
    };

/** ConversationWorker（对话工作线程） 广播回复汇点。 */
export type ConversationBroadcastReplySink = (input: {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 回复内容。 */
  readonly content: string;
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 执行任务入队汇点。 */
export type ConversationEnqueueExecTaskSink = (input: {
  /** BotWorker（机器人工作线程） 可消费任务。 */
  readonly task: BotWorkerTask;
  /** BullMQ（任务队列） 数值优先级。 */
  readonly priority: number;
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 运行时中断汇点。 */
export type ConversationInterruptRuntimeSink = (input: {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 运行时中断信号。 */
  readonly signal: InterruptRuntimeAction["signal"];
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 分诊依赖。 */
export type ConversationWorkerTriage = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
}) => ConversationTriageOutput | Promise<ConversationTriageOutput>;

/** ConversationWorker（对话工作线程） 回复生成依赖。 */
export type ConversationWorkerReplyGenerator = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已清洗的分诊结果。 */
  readonly triage: MessageTriage;
  /** 路由决策。 */
  readonly route: ConversationRouteDecision;
  /** 可选 BotActor（机器人执行代理） 当前状态短摘要。 */
  readonly state_context?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
}) => string | ConversationGeneratedReply | Promise<string | ConversationGeneratedReply>;

/** ConversationWorker（对话工作线程） 状态投影提供器。 */
export type ConversationActorStateProjectionProvider = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
}) =>
  | BotActorStateProjection
  | null
  | undefined
  | Promise<BotActorStateProjection | null | undefined>;

/** ConversationWorker（对话工作线程） memory（记忆）读取输入。 */
export interface ConversationMemoryContextProviderInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 主人原始消息文本。 */
  readonly message_content: string;
  /** 当前路由类型。 */
  readonly route_kind: ConversationRouteDecision["kind"];
  /** 查询原因。 */
  readonly query_reason: string;
  /** 建议最大条数。 */
  readonly limit: number;
  /** 建议字符预算。 */
  readonly char_budget: number;
}

/** ConversationWorker（对话工作线程） 可注入 memory（记忆）上下文提供器。 */
export type ConversationMemoryContextProvider = (
  input: ConversationMemoryContextProviderInput,
) => string | null | undefined | Promise<string | null | undefined>;

/** ConversationWorker（对话工作线程） 最小规划依赖。 */
export type ConversationWorkerPlanner = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已收紧到可规划意图的分诊结果。 */
  readonly triage: ConversationPlanningTriage;
  /** 已收紧到规划分支的路由。 */
  readonly route: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
}) => ConversationPlanDraft | Promise<ConversationPlanDraft>;

/** ConversationWorker（对话工作线程） BullMQ（任务队列） Worker 最小能力。 */
export interface ConversationBullmqWorkerLike {
  /** 关闭 Worker（工作线程）。 */
  close(): Promise<unknown>;
}

/** ConversationWorker（对话工作线程） 创建 Worker 的注入函数。 */
export type CreateConversationBullmqWorker = (input: {
  /** 队列名称。 */
  readonly queueName: MessageQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
  /** BullMQ（任务队列） job 处理器。 */
  readonly processor: (job: { readonly data: unknown }) => Promise<void>;
}) => ConversationBullmqWorkerLike;

/** ConversationWorker（对话工作线程） 依赖注入集合。 */
export interface ConversationWorkerRuntimeDependencies {
  /** 分诊函数，默认安全回退为 chat/normal。 */
  readonly triage?: ConversationWorkerTriage;
  /** 回复生成函数，默认生成模板闲聊回复。 */
  readonly replyGenerator?: ConversationWorkerReplyGenerator;
  /** BotActor（机器人执行代理） 只读状态投影提供器，仅 chat_reply（闲聊回复） 分支读取。 */
  readonly actorStateProjectionProvider?: ConversationActorStateProjectionProvider;
  /** memory（记忆）上下文提供器；仅按路由信号读取，失败时降级为空上下文。 */
  readonly memoryContextProvider?: ConversationMemoryContextProvider;
  /** 最小规划函数，成功时返回可执行规划草案。 */
  readonly planner?: ConversationWorkerPlanner;
  /** 广播回复汇点，真实路径指向 BotActor.broadcastReply。 */
  readonly broadcastReplySink: ConversationBroadcastReplySink;
  /** 运行时中断汇点，真实路径指向 BotActor 中断入口。 */
  readonly interruptRuntimeSink?: ConversationInterruptRuntimeSink;
  /** 执行任务入队汇点，真实路径指向 `bot:{botId}:exec`（执行队列）。 */
  readonly enqueueExecTaskSink?: ConversationEnqueueExecTaskSink;
  /** 当前是否已有活跃任务。 */
  readonly hasActiveTask?: () => boolean;
  /** 可注入 BullMQ（任务队列） Worker 工厂。 */
  readonly createWorker?: CreateConversationBullmqWorker;
}

/** ConversationWorker（对话工作线程） 运行时输入队列。 */
export interface ConversationWorkerRuntimeQueue {
  /** 队列名称。 */
  readonly name: MessageQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
}

/** ConversationWorker（对话工作线程） 运行时句柄。 */
export interface ConversationWorkerRuntime {
  /** 消费的队列名。 */
  readonly queue_name: MessageQueueName;
  /** 启动 BullMQ（任务队列） Worker。 */
  start(): Promise<void>;
  /** 关闭 BullMQ（任务队列） Worker。 */
  close(): Promise<void>;
  /** 获取处理过程事件快照。 */
  getEvents(): readonly ConversationWorkerRuntimeEvent[];
}
