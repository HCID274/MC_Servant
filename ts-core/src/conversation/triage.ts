/**
 * 对话分诊与路由决策逻辑。
 *
 * 架构职责：
 * 1. 意图清洗：将不稳定的 LLM 输出或外部输入清洗为类型安全的意图（Intent）和优先级（Priority）。
 * 2. 优先级映射：建立对话优先级（ConversationPriority）与执行引擎优先级（ExecPriority）之间的映射关系。
 * 3. 动态路由：根据分诊结果、当前系统执行状态（是否有活跃任务）决定对话的下一步走向（直接回复、取消中断、加入队列规划等）。
 */

import { ConversationPriority, type MessageTriage } from "../domain/contracts.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import { ExecPriority } from "../runtime/tasking.js";
import { shouldSearchConversationMemory } from "./chat.js";
import type {
  ConversationCancelRouteDecision,
  ConversationChatRouteDecision,
  ConversationModifyRouteDecision,
  ConversationPlanRouteDecision,
  ConversationRouteDecision,
  ConversationTriageFor,
} from "./contracts.js";

const CONVERSATION_INTENTS = ["chat", "task", "modify", "cancel"] as const;

/**
 * 校验字符串是否为合法的对话意图。
 *
 * 架构意图：
 * 1. 类型守卫：在运行时确保外部输入的意图值符合系统的核心意图枚举。
 */
function isConversationIntent(value: string): value is MessageTriage["intent"] {
  return (CONVERSATION_INTENTS as readonly string[]).includes(value);
}

/**
 * 校验字符串是否为合法的对话优先级。
 */
function isConversationPriority(value: string): value is ConversationPriority {
  return Object.values(ConversationPriority).includes(value as ConversationPriority);
}

/**
 * 将通用的 MessageTriage 投影为特定意图的分诊结构。
 *
 * 架构意图：
 * 1. 类型收敛：确保后续处理特定意图（如 task 或 chat）的逻辑能拿到准确的、经过类型收紧的分诊对象。
 */
function toConversationTriageFor<TIntent extends MessageTriage["intent"]>(
  triage: MessageTriage,
  intent: TIntent,
): ConversationTriageFor<TIntent> {
  if (triage.intent !== intent) {
    throw new Error(`Expected triage intent ${intent}, received ${triage.intent}`);
  }

  return Object.freeze({
    intent,
    priority: triage.priority,
    reason: triage.reason,
  });
}

/**
 * 将原始分诊输出收口到安全回退值。
 *
 * 架构职责：
 * 1. 稳压器作用：确保无论 LLM 或上游返回什么内容，最终都能得到一个合法的 MessageTriage 对象。
 *
 * 架构意图：
 * 1. 容错性保障：防止后续路由逻辑因为类型错误或非法枚举值而崩溃。
 *
 * @param input 包含意图、优先级和原因的可选输入
 * @returns 格式化后的分诊结果
 */
export function createMessageTriage(input: {
  intent?: string;
  priority?: string;
  reason?: string;
}): MessageTriage {
  const intent = input.intent && isConversationIntent(input.intent) ? input.intent : "chat";
  const priority =
    input.priority && isConversationPriority(input.priority)
      ? input.priority
      : ConversationPriority.Normal;
  const reason = input.reason?.trim() ? input.reason : "triage_fallback";

  return Object.freeze({
    intent,
    priority,
    reason,
  });
}

/**
 * 将对话优先级映射为可入执行队列的优先级。
 *
 * 架构意图：
 * 1. 优先级桥接：建立起面向用户的对话感知优先级与面向引擎的任务调度权重之间的映射关系。
 *
 * @param priority 对话优先级
 * @returns 执行引擎优先级
 */
export function toConversationExecPriority(priority: ConversationPriority): ExecPriority {
  switch (priority) {
    case ConversationPriority.Interrupt:
    case ConversationPriority.Urgent:
      return ExecPriority.Urgent;
    case ConversationPriority.Normal:
      return ExecPriority.Normal;
    case ConversationPriority.Background:
      return ExecPriority.Background;
  }
}

/**
 * 根据分诊结果与当前执行态生成纯路由决策。
 *
 * 架构职责：
 * 1. 分光镜决策：接收分诊意图和系统活跃状态（has_active_task），产出具体的路由决策（RouteDecision）。
 *
 * 架构意图：
 * 1. 策略封装：将复杂的“什么时候该中断、什么时候该入队”的业务规则封装在纯函数中，便于单元测试。
 * 2. 路由分支：
 *    - chat: 触发闲聊回复，并判断是否需要检索记忆。
 *    - cancel: 强制中断当前任务，触发取消模板回复。
 *    - task: 若优先级为 Interrupt 且有活跃任务，则走“中断并入队”流程，否则直接入队。
 *    - modify: 固定走“中断并重规划”流程。
 *
 * @param input 包含分诊结果、原始消息和任务活跃状态的输入
 * @returns 路由决策
 */
export function createConversationRouteDecision(input: {
  triage: MessageTriage;
  message: string;
  has_active_task: boolean;
}): ConversationRouteDecision {
  assertNonEmptyString(input.message, "message");

  switch (input.triage.intent) {
    case "chat":
      return Object.freeze({
        kind: "chat_reply",
        queue_behavior: "none",
        triage: toConversationTriageFor(input.triage, "chat"),
        requires_interrupt: false,
        requires_planning: false,
        needs_memory_search: shouldSearchConversationMemory({
          message: input.message,
          triage: input.triage,
        }),
      } satisfies ConversationChatRouteDecision);
    case "cancel":
      return Object.freeze({
        kind: "cancel_interrupt",
        queue_behavior: "interrupt_only",
        triage: toConversationTriageFor(input.triage, "cancel"),
        requires_interrupt: true,
        requires_planning: false,
        reply_mode: "template",
      } satisfies ConversationCancelRouteDecision);
    case "task":
      return Object.freeze({
        kind: "plan_exec",
        queue_behavior:
          input.triage.priority === ConversationPriority.Interrupt && input.has_active_task
            ? "interrupt_then_enqueue"
            : "enqueue_only",
        triage: toConversationTriageFor(input.triage, "task"),
        requires_interrupt:
          input.triage.priority === ConversationPriority.Interrupt && input.has_active_task,
        requires_planning: true,
        exec_priority: toConversationExecPriority(input.triage.priority),
        needs_memory_search: true,
      } satisfies ConversationPlanRouteDecision);
    case "modify":
      return Object.freeze({
        kind: "modify_interrupt_then_plan",
        queue_behavior: "interrupt_then_enqueue",
        triage: toConversationTriageFor(input.triage, "modify"),
        requires_interrupt: true,
        requires_planning: true,
        exec_priority: toConversationExecPriority(input.triage.priority),
        needs_memory_search: true,
      } satisfies ConversationModifyRouteDecision);
  }
}
