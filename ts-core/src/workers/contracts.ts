import type {
  ConversationCancelRouteDecision,
  ConversationChatRouteDecision,
  ConversationLlmReply,
  ConversationModifyRouteDecision,
  ConversationPlanRouteDecision,
  ConversationReply,
  ConversationRouteDecision,
  ConversationTemplateReply,
} from "../conversation/contracts.js";
import type { InterruptSignal } from "../runtime/contracts.js";
import type { ExecJob, TaskHistoryStatus } from "../runtime/tasking.js";
import {
  type BrainQueueName,
  type ExecQueueName,
  type MessageQueueName,
  createBrainQueueName,
  createExecQueueName,
  createMessageQueueName,
} from "./queues.js";

/** 允许进入 BrainWorker（摘要工作线程） 的终态集合。 */
export type BrainTaskStatus =
  | TaskHistoryStatus.Completed
  | TaskHistoryStatus.Failed
  | TaskHistoryStatus.Interrupted;

/** ConversationWorker（对话工作线程） 的输入任务。 */
export interface ConversationWorkerTask {
  /** Worker 类型。 */
  readonly worker: "conversation";
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 消费队列。 */
  readonly queue: MessageQueueName;
  /** 当前消息上下文。 */
  readonly message: Readonly<{
    readonly bot_id: string;
    readonly message_id: string;
    readonly content: string;
    readonly intent_epoch: number;
    readonly snapshot_ts: number;
  }>;
}

/** BotWorker（机器人工作线程） 的输入任务。 */
export interface BotWorkerTask {
  /** Worker 类型。 */
  readonly worker: "bot";
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 消费队列。 */
  readonly queue: ExecQueueName;
  /** 可消费的执行任务。 */
  readonly exec_job: ExecJob;
}

/** BrainWorker（摘要工作线程） 的输入任务。 */
export interface BrainWorkerTask {
  /** Worker 类型。 */
  readonly worker: "brain";
  /** 消费队列。 */
  readonly queue: BrainQueueName;
  /** 摘要输入载荷。 */
  readonly payload: Readonly<{
    /** 目标 Bot 标识。 */
    readonly bot_id: string;
    /** 原始消息标识。 */
    readonly message_id: string;
    /** 意图纪元。 */
    readonly intent_epoch: number;
    /** 终态状态。 */
    readonly status: BrainTaskStatus;
  }>;
}

/** ConversationWorker（对话工作线程） 产出的广播动作。 */
export interface BroadcastReplyAction {
  /** 动作类型。 */
  readonly type: "broadcast_reply";
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 统一回复结构。 */
  readonly reply: ConversationReply;
}

/** ConversationWorker（对话工作线程） 产出的中断动作。 */
export interface InterruptRuntimeAction {
  /** 动作类型。 */
  readonly type: "interrupt_runtime";
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 运行时中断信号。 */
  readonly signal: InterruptSignal;
}

/** ConversationWorker（对话工作线程） 产出的入执行队列动作。 */
export interface EnqueueExecAction {
  /** 动作类型。 */
  readonly type: "enqueue_exec";
  /** 目标队列。 */
  readonly queue: ExecQueueName;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 运行时执行任务。 */
  readonly exec_job: ExecJob;
}

/** ConversationWorker（对话工作线程） 输出动作联合。 */
export type ConversationWorkerAction =
  | BroadcastReplyAction
  | InterruptRuntimeAction
  | EnqueueExecAction;

/** `chat`（闲聊） 路由对应的 Worker 动作输入。 */
export interface ConversationChatWorkerActionInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 已解析的闲聊路由。 */
  readonly route: ConversationChatRouteDecision;
  /** 当前意图纪元。 */
  readonly intent_epoch: number;
  /** 已构造好的回复。 */
  readonly reply: ConversationReply;
}

/** `cancel`（取消） 路由对应的 Worker 动作输入。 */
export interface ConversationCancelWorkerActionInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 已解析的取消路由。 */
  readonly route: ConversationCancelRouteDecision;
  /** 当前意图纪元。 */
  readonly intent_epoch: number;
  /** 已构造好的模板回复。 */
  readonly reply: ConversationTemplateReply;
}

/** `plan`（规划） / `modify`（修改） 路由对应的 Worker 动作输入。 */
export interface ConversationExecWorkerActionInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 已解析的规划类路由。 */
  readonly route: ConversationPlanRouteDecision | ConversationModifyRouteDecision;
  /** 当前意图纪元。 */
  readonly intent_epoch: number;
  /** 已构造好的开场回复。 */
  readonly reply: ConversationLlmReply;
  /** 已构造好的执行任务。 */
  readonly exec_job: ExecJob;
}

/** ConversationWorker（对话工作线程） 动作构造输入联合。 */
export type ConversationWorkerActionInput =
  | ConversationChatWorkerActionInput
  | ConversationCancelWorkerActionInput
  | ConversationExecWorkerActionInput;

/** BotWorker（机器人工作线程） 产出的终态事件动作。 */
export interface EmitTaskTerminalAction {
  /** 动作类型。 */
  readonly type: "emit_task_terminal";
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 终态状态。 */
  readonly status: BrainTaskStatus;
}

/** BotWorker（机器人工作线程） 产出的摘要入队动作。 */
export interface EnqueueBrainAction {
  /** 动作类型。 */
  readonly type: "enqueue_brain";
  /** BrainWorker 输入任务。 */
  readonly task: BrainWorkerTask;
}

/** BotWorker（机器人工作线程） 输出动作联合。 */
export type BotWorkerAction = EmitTaskTerminalAction | EnqueueBrainAction;

/** BrainWorker（摘要工作线程） 产出的摘要持久化动作。 */
export interface PersistTaskSummaryAction {
  /** 动作类型。 */
  readonly type: "persist_task_summary";
  /** 原始摘要输入载荷。 */
  readonly payload: BrainWorkerTask["payload"];
}

/** BrainWorker（摘要工作线程） 输出动作联合。 */
export type BrainWorkerAction = PersistTaskSummaryAction;

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

/** 创建 ConversationWorker（对话工作线程） 输入任务。 */
export function createConversationWorkerTask(input: {
  bot_id: string;
  message: ConversationWorkerTask["message"];
}): ConversationWorkerTask {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message.bot_id, "message.bot_id");
  assertNonEmptyString(input.message.message_id, "message.message_id");
  assertNonEmptyString(input.message.content, "message.content");
  if (input.bot_id !== input.message.bot_id) {
    throw new Error("bot_id must match message.bot_id");
  }

  return Object.freeze({
    worker: "conversation",
    bot_id: input.bot_id,
    queue: createMessageQueueName(input.bot_id),
    message: Object.freeze({
      ...input.message,
    }),
  });
}

/** 创建 BotWorker（机器人工作线程） 输入任务。 */
export function createBotWorkerTask(input: {
  bot_id: string;
  exec_job: ExecJob;
}): BotWorkerTask {
  assertNonEmptyString(input.bot_id, "bot_id");

  return Object.freeze({
    worker: "bot",
    bot_id: input.bot_id,
    queue: createExecQueueName(input.bot_id),
    exec_job: input.exec_job,
  });
}

/** 创建 BrainWorker（摘要工作线程） 输入任务。 */
export function createBrainWorkerTask(input: {
  bot_id: string;
  message_id: string;
  intent_epoch: number;
  status: BrainTaskStatus;
}): BrainWorkerTask {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message_id, "message_id");

  return Object.freeze({
    worker: "brain",
    queue: createBrainQueueName(),
    payload: Object.freeze({
      bot_id: input.bot_id,
      message_id: input.message_id,
      intent_epoch: input.intent_epoch,
      status: input.status,
    }),
  });
}

/** 将 cancel / modify / 抢占式 task（任务） 路由桥接为运行时中断信号。 */
export function createInterruptSignalFromRoute(input: {
  route: ConversationRouteDecision;
  intent_epoch: number;
}): InterruptSignal {
  if (!input.route.requires_interrupt) {
    throw new Error(`Route ${input.route.kind} does not require interrupt`);
  }

  const reason =
    input.route.kind === "cancel_interrupt"
      ? "cancel"
      : input.route.kind === "modify_interrupt_then_plan"
        ? "modify"
        : input.route.kind === "plan_exec"
          ? input.route.triage.reason
          : "interrupt";

  return Object.freeze({
    source: {
      type: "triage" as const,
      intent_epoch: input.intent_epoch,
    },
    reason,
  });
}

/** 根据 ConversationWorker（对话工作线程） 路由结果生成输出动作集合。 */
export function createConversationWorkerActions(
  input: ConversationWorkerActionInput,
): readonly ConversationWorkerAction[] {
  const actions: ConversationWorkerAction[] = [];

  if (input.route.requires_interrupt) {
    actions.push(
      Object.freeze({
        type: "interrupt_runtime",
        bot_id: input.bot_id,
        signal: createInterruptSignalFromRoute({
          route: input.route,
          intent_epoch: input.intent_epoch,
        }),
      }),
    );
  }

  switch (input.route.kind) {
    case "chat_reply":
      actions.push(
        Object.freeze({
          type: "broadcast_reply",
          bot_id: input.bot_id,
          reply: input.reply,
        }),
      );
      break;
    case "cancel_interrupt":
      if (input.reply.mode !== "template") {
        throw new Error("cancel_interrupt requires a template reply");
      }

      actions.push(
        Object.freeze({
          type: "broadcast_reply",
          bot_id: input.bot_id,
          reply: input.reply,
        }),
      );
      break;
    case "plan_exec":
    case "modify_interrupt_then_plan":
      if (!("exec_job" in input)) {
        throw new Error("planning route requires exec_job");
      }
      if (input.reply.mode !== "llm") {
        throw new Error(`${input.route.kind} requires an llm reply`);
      }

      actions.push(
        Object.freeze({
          type: "broadcast_reply",
          bot_id: input.bot_id,
          reply: input.reply,
        }),
      );
      actions.push(
        Object.freeze({
          type: "enqueue_exec",
          bot_id: input.bot_id,
          queue: createExecQueueName(input.bot_id),
          exec_job: input.exec_job,
        }),
      );
      break;
  }

  return Object.freeze(actions);
}

/** 根据 BotWorker（机器人工作线程） 的终态结果生成输出动作集合。 */
export function createBotWorkerActions(input: {
  task: BotWorkerTask;
  status: BrainTaskStatus;
}): readonly BotWorkerAction[] {
  return Object.freeze([
    Object.freeze({
      type: "emit_task_terminal",
      bot_id: input.task.bot_id,
      message_id: input.task.exec_job.message_id,
      status: input.status,
    }),
    Object.freeze({
      type: "enqueue_brain",
      task: createBrainWorkerTask({
        bot_id: input.task.bot_id,
        message_id: input.task.exec_job.message_id,
        intent_epoch: input.task.exec_job.intent_epoch,
        status: input.status,
      }),
    }),
  ]);
}

/** 根据 BrainWorker（摘要工作线程） 输入生成最小持久化动作。 */
export function createBrainWorkerActions(input: {
  task: BrainWorkerTask;
}): readonly BrainWorkerAction[] {
  return Object.freeze([
    Object.freeze({
      type: "persist_task_summary",
      payload: input.task.payload,
    }),
  ]);
}
