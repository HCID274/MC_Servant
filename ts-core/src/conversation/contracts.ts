/**
 * 对话模块契约定义。
 *
 * 1. 领域模型映射：定义对话历史、消息上下文、分诊结果、规划草案等核心领域对象。
 * 2. 状态机驱动：规定对话从“收到消息”到“分诊”、“决策路由”再到“执行规划”的状态演进契约。
 * 3. 路由策略：定义 ConversationWorker 如何根据意图（Intent）和优先级（Priority）决定是直接回复、加入队列还是中断当前任务。
 */

import {
  type ConversationPriority,
  ExecutionTaskKind,
  type MessageSource,
  type MessageTriage,
} from "../domain/contracts.js";
import type { BotStatus } from "../runtime/contracts.js";
import type { ExecPriority } from "../runtime/tasking.js";
import type { SandboxExecutionRequest } from "../sandbox/contracts.js";
import type { SkillName, SkillParamsByName } from "../skills/contracts.js";

/** 对话历史允许的角色清单。 */
export const CONVERSATION_HISTORY_ROLES = ["owner", "bot"] as const;

/** 对话历史角色联合类型。 */
export type ConversationHistoryRole = (typeof CONVERSATION_HISTORY_ROLES)[number];

/** 对话路由类型清单。 */
export const CONVERSATION_ROUTE_KINDS = [
  "chat_reply",
  "plan_exec",
  "cancel_interrupt",
  "modify_interrupt_then_plan",
] as const;

/** 对话路由类型联合。 */
export type ConversationRouteKind = (typeof CONVERSATION_ROUTE_KINDS)[number];

/** 队列侧行为类型清单。 */
export const CONVERSATION_QUEUE_BEHAVIORS = [
  "none",
  "enqueue_only",
  "interrupt_only",
  "interrupt_then_enqueue",
] as const;

/** 队列侧行为联合类型。 */
export type ConversationQueueBehavior = (typeof CONVERSATION_QUEUE_BEHAVIORS)[number];

/** 对话回复模式清单。 */
export const CONVERSATION_REPLY_MODES = ["llm", "template"] as const;

/** 对话回复模式联合类型。 */
export type ConversationReplyMode = (typeof CONVERSATION_REPLY_MODES)[number];

/** 可进入规划阶段的意图集合。 */
export const CONVERSATION_PLANNING_INTENTS = ["task", "modify"] as const;

/** 规划意图联合类型。 */
export type ConversationPlanningIntent = (typeof CONVERSATION_PLANNING_INTENTS)[number];

/** 规划产物类型清单。 */
export const CONVERSATION_PLAN_TYPES = [
  ExecutionTaskKind.SkillCall,
  ExecutionTaskKind.SandboxCode,
] as const;

/** 规划产物类型联合。 */
export type ConversationPlanType = (typeof CONVERSATION_PLAN_TYPES)[number];

/** 单条原始对话记录的最小结构。 */
export interface ConversationHistoryTurn {
  /** 对话角色。 */
  readonly role: ConversationHistoryRole;
  /** 原始文本。 */
  readonly content: string;
}

/** 进入 ConversationWorker（对话工作线程） 的消息上下文。 */
export interface ConversationMessageContext {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 当前消息标识。 */
  readonly message_id: string;
  /** 主人原始消息。 */
  readonly content: string;
  /** 消息来源。 */
  readonly source: MessageSource;
  /** 当前意图纪元。 */
  readonly intent_epoch: number;
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
  /** 当前 Bot 状态。 */
  readonly bot_status: BotStatus;
  /** 标准化时间。 */
  readonly created_at: string;
  /** 可选主人标识。 */
  readonly owner_id?: string;
  /** 可选会话标识。 */
  readonly session_id?: string;
  /** 当前活跃任务消息标识。 */
  readonly active_task_message_id?: string;
}

/** Stage 1（第一阶段） 分诊输入上下文。 */
export interface ConversationTriageContext {
  /** 当前消息。 */
  readonly message: ConversationMessageContext;
  /** 最近对话窗口。 */
  readonly history: readonly ConversationHistoryTurn[];
  /** 一行状态摘要。 */
  readonly bot_summary: string;
}

/** 按意图收紧后的分诊结构。 */
export interface ConversationTriageFor<TIntent extends MessageTriage["intent"]> {
  /** 当前意图。 */
  readonly intent: TIntent;
  /** 对话优先级。 */
  readonly priority: ConversationPriority;
  /** 分诊原因。 */
  readonly reason: string;
}

/** 可进入规划阶段的分诊结构。 */
export interface ConversationPlanningTriage
  extends ConversationTriageFor<ConversationPlanningIntent> {}

/** `modify`（修改） 路径注入的被中断任务摘要。 */
export interface InterruptedTaskSummary {
  /** 被中断的消息标识。 */
  readonly message_id: string;
  /** 被中断任务的意图概述。 */
  readonly intent_summary: string;
  /** 可选最后一步进度。 */
  readonly last_step?: string;
}

/** Stage 2（第二阶段） 规划上下文结构。 */
export interface ConversationPlanningContext {
  /** 当前消息。 */
  readonly message: ConversationMessageContext;
  /** 规划分诊结果。 */
  readonly triage: ConversationPlanningTriage;
  /** 压缩后的环境快照。 */
  readonly snapshot_context: string;
  /** 可选任务历史索引。 */
  readonly task_history_context?: string;
  /** 可选记忆检索结果。 */
  readonly memory_context?: string;
  /** `modify`（修改） 时的被中断任务摘要。 */
  readonly interrupted_task?: InterruptedTaskSummary;
}

/** `llm`（大语言模型） 生成的对话回复结构。 */
export interface ConversationLlmReply {
  /** 回复模式。 */
  readonly mode: "llm";
  /** 已完成尾缀兜底的回复文本。 */
  readonly reply: string;
}

/** `template`（模板） 生成的对话回复结构。 */
export interface ConversationTemplateReply {
  /** 回复模式。 */
  readonly mode: "template";
  /** 已完成尾缀兜底的回复文本。 */
  readonly reply: string;
}

/** 对话回复结构联合。 */
export type ConversationReply = ConversationLlmReply | ConversationTemplateReply;

/** `skill_call`（技能调用） 路径的规划产物。 */
export type ConversationSkillCallPlanDraft = {
  readonly [TName in SkillName]: {
    /** 固定为 `skill_call`（技能调用）。 */
    readonly type: ExecutionTaskKind.SkillCall;
    /** 给主人的开场回复。 */
    readonly reply: string;
    /** 与技能目录严格对齐的技能名。 */
    readonly skill: TName;
    /** 与技能名一一对齐的参数。 */
    readonly params: Readonly<SkillParamsByName[TName]>;
  };
}[SkillName];

/** `sandbox_code`（沙箱代码） 路径的规划产物。 */
export interface ConversationSandboxCodePlanDraft {
  /** 固定为 `sandbox_code`（沙箱代码）。 */
  readonly type: ExecutionTaskKind.SandboxCode;
  /** 给主人的开场回复。 */
  readonly reply: string;
  /** 复用沙箱执行请求中的源码字段。 */
  readonly code: SandboxExecutionRequest["code"];
}

/** Stage 2（第二阶段） 规划产物联合。 */
export type ConversationPlanDraft =
  | ConversationSkillCallPlanDraft
  | ConversationSandboxCodePlanDraft;

/** 闲聊回复路由结构。 */
export interface ConversationChatRouteDecision {
  /** 路由类型。 */
  readonly kind: "chat_reply";
  /** 队列侧行为。 */
  readonly queue_behavior: "none";
  /** 当前分诊结果。 */
  readonly triage: ConversationTriageFor<"chat">;
  /** 是否需要先中断。 */
  readonly requires_interrupt: false;
  /** 是否需要进入规划。 */
  readonly requires_planning: false;
  /** 是否建议做记忆检索。 */
  readonly needs_memory_search: boolean;
}

/** 直接取消路由结构。 */
export interface ConversationCancelRouteDecision {
  /** 路由类型。 */
  readonly kind: "cancel_interrupt";
  /** 队列侧行为。 */
  readonly queue_behavior: "interrupt_only";
  /** 当前分诊结果。 */
  readonly triage: ConversationTriageFor<"cancel">;
  /** 是否需要先中断。 */
  readonly requires_interrupt: true;
  /** 是否需要进入规划。 */
  readonly requires_planning: false;
  /** cancel（取消） 使用模板回复。 */
  readonly reply_mode: "template";
}

/** 直接规划路由结构。 */
export interface ConversationPlanRouteDecision {
  /** 路由类型。 */
  readonly kind: "plan_exec";
  /** 队列侧行为。 */
  readonly queue_behavior: "enqueue_only" | "interrupt_then_enqueue";
  /** 当前分诊结果。 */
  readonly triage: ConversationTriageFor<"task">;
  /** 是否需要先中断。 */
  readonly requires_interrupt: boolean;
  /** 是否需要进入规划。 */
  readonly requires_planning: true;
  /** 进入执行队列时使用的优先级。 */
  readonly exec_priority: ExecPriority;
  /** 任务规划固定做记忆检索。 */
  readonly needs_memory_search: true;
}

/** 修改后重规划路由结构。 */
export interface ConversationModifyRouteDecision {
  /** 路由类型。 */
  readonly kind: "modify_interrupt_then_plan";
  /** 队列侧行为。 */
  readonly queue_behavior: "interrupt_then_enqueue";
  /** 当前分诊结果。 */
  readonly triage: ConversationTriageFor<"modify">;
  /** 是否需要先中断。 */
  readonly requires_interrupt: true;
  /** 是否需要进入规划。 */
  readonly requires_planning: true;
  /** 进入执行队列时使用的优先级。 */
  readonly exec_priority: ExecPriority;
  /** `modify`（修改） 固定做记忆检索。 */
  readonly needs_memory_search: true;
}

/** ConversationWorker（对话工作线程） 的纯路由结果联合。 */
export type ConversationRouteDecision =
  | ConversationChatRouteDecision
  | ConversationCancelRouteDecision
  | ConversationPlanRouteDecision
  | ConversationModifyRouteDecision;
