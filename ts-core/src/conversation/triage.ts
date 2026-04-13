import { ConversationPriority, type MessageTriage } from "../domain/contracts.js";
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

function isConversationIntent(value: string): value is MessageTriage["intent"] {
  return (CONVERSATION_INTENTS as readonly string[]).includes(value);
}

function isConversationPriority(value: string): value is ConversationPriority {
  return Object.values(ConversationPriority).includes(value as ConversationPriority);
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

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

/** 将原始 triage（分诊） 输出收口到安全回退值。 */
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

/** 将对话优先级映射为可入执行队列的优先级。 */
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

/** 根据 triage（分诊） 与当前执行态生成纯路由结果。 */
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
