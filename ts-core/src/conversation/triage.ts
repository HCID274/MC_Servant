/**
 * 对话分诊与路由决策逻辑。
 *
 * 1. 意图清洗：将不稳定的 LLM 输出或外部输入清洗为类型安全的意图（Intent）和优先级（Priority）。
 * 2. 优先级映射：建立对话优先级（ConversationPriority）与执行引擎优先级（ExecPriority）之间的映射关系。
 * 3. 动态路由：根据分诊结果、当前系统执行状态（是否有活跃任务）决定对话的下一步走向（直接回复、取消中断、加入队列规划等）。
 */

import { ConversationPriority, type MessageTriage } from "../core-ports/foundation.js";
import { ExecPriority } from "../core-ports/tasking.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import { shouldSearchConversationMemory } from "./chat.js";
import type {
  ConversationCancelRouteDecision,
  ConversationChatRouteDecision,
  ConversationCompositeTriage,
  ConversationPlanRouteDecision,
  ConversationRouteDecision,
  ConversationTriageFor,
} from "./contracts.js";

const CONVERSATION_INTENTS = ["chat", "task", "cancel"] as const;
const COMPOSITE_CANCEL_PRIORITIES = ["interrupt", "queued"] as const;
const EXPLICIT_CANCEL_OR_MODIFY_PATTERNS = Object.freeze([
  /停下/u,
  /停止/u,
  /停掉/u,
  /停手/u,
  /暂停/u,
  /取消/u,
  /中止/u,
  /终止/u,
  /打断/u,
  /别做/u,
  /别去了/u,
  /不要做/u,
  /先别/u,
  /算了/u,
  /改成/u,
  /改为/u,
  /改去/u,
  /换成/u,
  /换去/u,
  /重新规划/u,
  /\bstop\b/iu,
  /\bcancel\b/iu,
  /\babort\b/iu,
] as const);

/**
 * 校验字符串是否为合法的对话意图。
 *
 * 类型守卫：在运行时确保外部输入的意图值符合系统的核心意图枚举。
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

/** 校验字符串是否为合法的复合 cancel（取消） 优先级。 */
function isCompositeCancelPriority(value: string): value is "interrupt" | "queued" {
  return (COMPOSITE_CANCEL_PRIORITIES as readonly string[]).includes(value);
}

/**
 * 将通用的 MessageTriage 投影为特定意图的分诊结构。
 *
 * 类型收敛：确保后续处理特定意图（如 task 或 chat）的逻辑能拿到准确的、经过类型收紧的分诊对象。
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
 * 稳压器作用：确保无论 LLM 或上游返回什么内容，最终都能得到一个合法的 MessageTriage 对象。
 *
 * 容错性保障：防止后续路由逻辑因为类型错误或非法枚举值而崩溃。
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
 * 创建复合分诊结构。
 *
 * `modify`（修改） 语义不再是独立 intent（意图），只能由 cancel（取消） + action（动作） 组合表达。
 */
export function createConversationCompositeTriage(input: {
  readonly cancel?: { readonly reason?: string; readonly priority?: string } | null;
  readonly chat?: Record<string, never> | null;
  readonly action?: {
    readonly intent?: string;
    readonly priority?: string;
    readonly reason?: string;
    readonly needs_memory_search?: boolean;
  } | null;
}): ConversationCompositeTriage {
  const cancel =
    input.cancel === undefined || input.cancel === null
      ? undefined
      : Object.freeze({
          reason: input.cancel.reason?.trim() || "composite_cancel",
          priority:
            input.cancel.priority && isCompositeCancelPriority(input.cancel.priority)
              ? input.cancel.priority
              : "interrupt",
        });
  const chat = createCompositeChat(input.chat);
  const action = createCompositeAction(input.action);

  if (cancel === undefined && chat === undefined && action === undefined) {
    return Object.freeze({
      chat: Object.freeze({}),
    });
  }

  return Object.freeze({
    ...(cancel === undefined ? {} : { cancel }),
    ...(chat === undefined ? {} : { chat }),
    ...(action === undefined ? {} : { action }),
  });
}

/** 清理 LLM 把普通新任务误套成 cancel + action 的复合分诊噪声。 */
export function normalizeConversationCompositeTriageForMessage(input: {
  readonly triage: ConversationCompositeTriage;
  readonly message: string;
}): ConversationCompositeTriage {
  if (input.triage.cancel === undefined || input.triage.action === undefined) {
    return input.triage;
  }
  if (hasExplicitCancelOrModifyIntent(input.message)) {
    return input.triage;
  }

  return createConversationCompositeTriage({
    ...(input.triage.chat === undefined ? {} : { chat: {} }),
    action: input.triage.action,
  });
}

/** 从 JSON（结构化数据） 记录创建复合分诊结构。 */
export function createConversationCompositeTriageFromRecord(
  record: Record<string, unknown>,
): ConversationCompositeTriage {
  if (typeof record.intent === "string") {
    throw new Error("triage must use composite schema");
  }
  if ("reply" in record) {
    throw new Error("triage reply field is no longer supported; use chat empty object");
  }

  return createConversationCompositeTriage({
    ...(isRecord(record.cancel) ? { cancel: pickReasonPriority(record.cancel) } : {}),
    ...(hasOwn(record, "chat") ? { chat: createChatInput(record.chat) } : {}),
    ...(isRecord(record.action) ? { action: pickActionInput(record.action) } : {}),
  });
}

function createCompositeChat(
  value: Record<string, never> | null | undefined,
): ConversationCompositeTriage["chat"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Object.keys(value).length > 0) {
    throw new Error("triage chat must be an empty object");
  }

  return Object.freeze({});
}

function hasExplicitCancelOrModifyIntent(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return EXPLICIT_CANCEL_OR_MODIFY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function createCompositeAction(
  value:
    | {
        readonly intent?: string;
        readonly priority?: string;
        readonly reason?: string;
        readonly needs_memory_search?: boolean;
      }
    | null
    | undefined,
): ConversationCompositeTriage["action"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value.intent !== "task") {
    throw new Error("triage action intent must be task");
  }

  return Object.freeze({
    intent: "task",
    priority:
      value.priority && isConversationPriority(value.priority)
        ? value.priority
        : ConversationPriority.Normal,
    reason: value.reason?.trim() || "composite_action",
    ...(value.needs_memory_search === true ? { needs_memory_search: true } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function pickReasonPriority(record: Record<string, unknown>): {
  readonly reason?: string;
  readonly priority?: string;
} {
  return {
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.priority === "string" ? { priority: record.priority } : {}),
  };
}

function createChatInput(value: unknown): Record<string, never> {
  if (!isRecord(value)) {
    throw new Error("triage chat must be an empty object");
  }
  if (Object.keys(value).length > 0) {
    throw new Error("triage chat must be an empty object");
  }

  return {};
}

function pickActionInput(record: Record<string, unknown>): {
  readonly intent?: string;
  readonly priority?: string;
  readonly reason?: string;
  readonly needs_memory_search?: boolean;
} {
  return {
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    ...(typeof record.priority === "string" ? { priority: record.priority } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.needs_memory_search === "boolean"
      ? { needs_memory_search: record.needs_memory_search }
      : {}),
  };
}

/**
 * 将对话优先级映射为可入执行队列的优先级。
 *
 * 优先级桥接：建立起面向用户的对话感知优先级与面向引擎的任务调度权重之间的映射关系。
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
 * 1. 分光镜决策：接收分诊意图和系统活跃状态（has_active_task），产出具体的路由决策（RouteDecision）。
 * 2. 策略封装：将复杂的“什么时候该中断、什么时候该入队”的业务规则封装在纯函数中，便于单元测试。
 * 3. route（路由） 分支：
 *    - chat: 触发闲聊回复，并判断是否需要检索记忆。
 *    - cancel: 强制中断当前任务，触发取消模板回复。
 *    - task: 若优先级为 Interrupt 且有活跃任务，则走“中断并入队”流程，否则直接入队。
 *
 * @param input 包含分诊结果、原始消息和任务活跃状态的输入
 * @returns 路由决策
 */
export function createConversationRouteDecision(input: {
  triage: MessageTriage;
  message: string;
  has_active_task: boolean;
  needs_memory_search?: boolean;
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
        needs_memory_search: input.needs_memory_search === true,
      } satisfies ConversationPlanRouteDecision);
  }
}
