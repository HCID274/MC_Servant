import type {
  ConversationPlanDraft,
  ConversationPlanningTriage,
  ConversationRouteDecision,
  ConversationTriageOutput,
} from "../../conversation/contracts.js";
import type { ConversationInventoryDiffCache } from "../../conversation/inventory-diff-cache.js";
import type {
  ConversationGeneratedReply,
  ConversationLlmDiagnosticRecord,
  ConversationLlmSearchTool,
} from "../../conversation/llm.js";
import type { ConversationRecentContextStore } from "../../conversation/recent-context.js";
import type { MessageTriage } from "../../core-ports/foundation.js";
import type { EnvironmentSnapshot } from "../../core-ports/observation.js";
import type { BotActorStateProjection } from "../../core-ports/runtime.js";
import type { ExecPriority, TaskHistoryStatus } from "../../core-ports/tasking.js";
import type { ConversationBrainContext } from "../../data/contracts/index.js";
import type { RedisClientLike } from "../../db/index.js";
import type { BrainDiagnosticLogSink, ProductionMetricLogSink } from "../../diagnostics/index.js";
import type {
  BotWorkerTask,
  BrainWorkerTask,
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
      /** 分段性能指标。 */
      readonly metrics: ConversationLlmDiagnosticRecord["metrics"];
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
      readonly reason:
        | "planner_unavailable"
        | "planner_failed"
        | "skill_not_enabled"
        | "implementation_blocker"
        | "retry_guard_repeated";
    }
  | {
      /** 事件类型。 */
      readonly type: "task.accepted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 执行类型。 */
      readonly exec_type: "code";
      /** 执行队列优先级。 */
      readonly priority: ExecPriority;
    }
  | {
      /** 事件类型。 */
      readonly type: "brain.fact.enqueue_failed";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** fact（事实） 来源路由。 */
      readonly route_kind: "chat_reply" | "plan_exec";
      /** 失败摘要。 */
      readonly error_summary: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "brain.fact.diagnostic_failed";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** fact（事实） 来源路由。 */
      readonly route_kind: "chat_reply" | "plan_exec";
      /** 原始入队失败摘要。 */
      readonly enqueue_error_summary: string;
      /** 诊断写入失败摘要。 */
      readonly diagnostic_error_summary: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "conversation.context_provider_failed";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** provider（提供器） 所属路由。 */
      readonly route_kind: "plan_exec";
      /** 降级的 provider（提供器） 名称。 */
      readonly provider:
        | "recent"
        | "actor_state"
        | "memory"
        | "brain"
        | "resource"
        | "environment_snapshot";
      /** 失败摘要。 */
      readonly error_summary: string;
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

/** ConversationWorker（对话工作线程） 对话事实入 BrainWorker（大脑工作线程） 汇点。 */
export type ConversationEnqueueBrainFactSink = (input: {
  /** BrainWorker（大脑工作线程） 可消费的 conversation_fact（对话事实）任务。 */
  readonly task: BrainWorkerTask;
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
  /** A.5 + C(USER/MEMORY) 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
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
  /** 可选最近上下文时间线，已按 §7.6 渲染。 */
  readonly recent_context?: string;
  /** 可选 observation（观测） 快照上下文，已按当前路由模板渲染。 */
  readonly snapshot_context?: string;
  /** 可选 inventory diff（背包变化） 文本，用于诊断与测试。 */
  readonly inventory_change_context?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
  /** A.5 + C 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
  /** 可选 search() tool（工具）。 */
  readonly search_tool?: ConversationLlmSearchTool;
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

/** ConversationWorker（对话工作线程） prompt（提示词） 构建期环境快照 provider（提供器）。 */
export type ConversationEnvironmentSnapshotProvider = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
}) => EnvironmentSnapshot | null | undefined | Promise<EnvironmentSnapshot | null | undefined>;

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

/** ConversationWorker（对话工作线程） 常驻 Brain context（大脑上下文）读取输入。 */
export interface ConversationBrainContextProviderInput {
  readonly bot_id: string;
  readonly message_id: string;
  readonly include_skill: boolean;
}

/** ConversationWorker（对话工作线程） 可注入 Brain context（大脑上下文）provider（提供器）。 */
export type ConversationBrainContextProvider = (
  input: ConversationBrainContextProviderInput,
) =>
  | ConversationBrainContext
  | null
  | undefined
  | Promise<ConversationBrainContext | null | undefined>;

/** ConversationWorker（对话工作线程） 资源摘要读取输入。 */
export interface ConversationResourceContextProviderInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 主人原始消息文本。 */
  readonly message_content: string;
  /** 当前路由类型。 */
  readonly route_kind: ConversationRouteDecision["kind"];
}

/** ConversationWorker（对话工作线程） 可注入资源摘要 provider（提供器）。 */
export type ConversationResourceContextProvider = (
  input: ConversationResourceContextProviderInput,
) => string | null | undefined | Promise<string | null | undefined>;

/** ConversationWorker（对话工作线程） 最小规划依赖。 */
export type ConversationWorkerPlanner = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已收紧到可规划意图的分诊结果。 */
  readonly triage: ConversationPlanningTriage;
  /** 已收紧到规划分支的路由。 */
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
  /** A.5 + C 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
  /** 可选 search() tool（工具）。 */
  readonly search_tool?: ConversationLlmSearchTool;
  /** 可选资源摘要。 */
  readonly resource_context?: string;
  /** 可选最近上下文时间线，已按 §7.6 渲染。 */
  readonly recent_context?: string;
  /** 可选 observation（观测） 快照上下文，已按当前路由模板渲染。 */
  readonly snapshot_context?: string;
  /** 可选 inventory diff（背包变化） 文本，用于诊断与测试。 */
  readonly inventory_change_context?: string;
}) =>
  | (ConversationPlanDraft & { readonly diagnostics?: ConversationLlmDiagnosticRecord })
  | Promise<ConversationPlanDraft & { readonly diagnostics?: ConversationLlmDiagnosticRecord }>;

/** 对话回复本地诊断日志输入。 */
export interface ConversationReplyLogInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 日志创建时间。 */
  readonly created_at: string;
  /** 主人原始输入。 */
  readonly owner_message: string;
  /** 触发回复的 route（路由） 类型。 */
  readonly route_kind: ConversationRouteDecision["kind"] | "composite_chat";
  /** 回复模式。 */
  readonly reply_mode: ConversationGeneratedReply["mode"] | "llm" | "template";
  /** 最终广播给主人的回复。 */
  readonly reply: string;
  /** 分诊与路由摘要。 */
  readonly triage?: MessageTriage | ConversationPlanningTriage;
  /** 注入回复生成链路的上下文。 */
  readonly contexts?: {
    readonly state_context?: string;
    readonly memory_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
    readonly inventory_change_context?: string;
    readonly brain_context?: string;
  };
  /** LLM（大语言模型） 诊断记录，包含实际发送的 messages（消息）。 */
  readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
}

/** 对话回复本地诊断日志 sink（汇点）。 */
export type ConversationReplyLogSink = (input: ConversationReplyLogInput) => Promise<unknown>;

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
  /** Brain context（大脑上下文）提供器；Triage / Chat / Plan 三阶段只读消费。 */
  readonly brainContextProvider?: ConversationBrainContextProvider | undefined;
  /** Stage 2-Chat / Stage 2-Plan 暴露给 LLM（大语言模型） 的 search() tool（工具）。 */
  readonly brainSearchTool?: ConversationLlmSearchTool | undefined;
  /** ResourceService（世界感知资源服务） 摘要提供器；仅规划路径读取，失败时降级为空上下文。 */
  readonly resourceContextProvider?: ConversationResourceContextProvider;
  /** 最小规划函数，成功时返回可执行规划草案。 */
  readonly planner?: ConversationWorkerPlanner;
  /** 本地 conversation（对话） JSONL（结构化日志） 写入汇点。 */
  readonly conversationReplyLogSink?: ConversationReplyLogSink;
  /** ConversationWorker（对话工作线程） 单写侧最近上下文 store（存储）。 */
  readonly recentContextStore?: ConversationRecentContextStore;
  /** ConversationWorker（对话工作线程） 侧 inventory diff cache（背包差异缓存）。 */
  readonly inventoryDiffCache?: ConversationInventoryDiffCache;
  /** prompt（提示词） 构建期环境快照 provider（提供器）。 */
  readonly environmentSnapshotProvider?: ConversationEnvironmentSnapshotProvider;
  /** 广播回复汇点，真实路径指向 BotActor.broadcastReply。 */
  readonly broadcastReplySink: ConversationBroadcastReplySink;
  /** 运行时中断汇点，真实路径指向 BotActor 中断入口。 */
  readonly interruptRuntimeSink?: ConversationInterruptRuntimeSink;
  /** 执行任务入队汇点，真实路径指向 `bot:{botId}:exec`（执行队列）。 */
  readonly enqueueExecTaskSink?: ConversationEnqueueExecTaskSink;
  /** 对话事实候选入队汇点，真实路径指向 `brain`（大脑） 队列。 */
  readonly enqueueBrainFactSink?: ConversationEnqueueBrainFactSink;
  /** Brain fact（大脑事实） 旁路失败诊断汇点。 */
  readonly brainDiagnosticSink?: BrainDiagnosticLogSink;
  /** 生产指标事件本地 JSONL 汇点。 */
  readonly productionMetricSink?: ProductionMetricLogSink;
  /** 当前是否已有活跃任务。 */
  readonly hasActiveTask?: () => boolean;
  /** 主人消息活跃心跳；BrainWorker（大脑工作线程） 会话静默检测只读消费。 */
  readonly ownerMessageActivitySink?: (input: {
    readonly bot_id: string;
    readonly message_id: string;
    readonly at: Date;
  }) => void | Promise<void>;
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
