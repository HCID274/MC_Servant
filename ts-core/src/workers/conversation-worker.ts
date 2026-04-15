/**
 * ConversationWorker（对话工作线程） 真实运行时。
 *
 * 架构职责：
 * 1. 消费 `msg:{botId}` BullMQ（任务队列） 消息。
 * 2. 在无真实 LLM（大语言模型） 时使用安全分诊与模板回复兜底。
 * 3. 只通过注入的 BotActor（机器人执行代理） 单写者 sink（汇点）写入游戏聊天。
 */

import { Worker, type WorkerOptions } from "bullmq";

import { createConversationReply } from "../conversation/chat.js";
import type { ConversationRouteDecision } from "../conversation/contracts.js";
import { createConversationRouteDecision, createMessageTriage } from "../conversation/triage.js";
import type { RedisClientLike } from "../db/index.js";
import { ConversationPriority, type MessageTriage } from "../domain/contracts.js";
import { TaskHistoryStatus } from "../runtime/tasking.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import { type ConversationWorkerTask, createConversationWorkerTask } from "./contracts.js";
import type { MessageQueueName } from "./queues.js";

/** ConversationWorker（对话工作线程） 处理过程事件。 */
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
      readonly reason: "planner_unavailable";
    };

/** ConversationWorker（对话工作线程） 广播回复汇点。 */
export type ConversationBroadcastReplySink = (input: {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 回复内容。 */
  readonly content: string;
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 分诊依赖。 */
export type ConversationWorkerTriage = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
}) => MessageTriage | Promise<MessageTriage>;

/** ConversationWorker（对话工作线程） 回复生成依赖。 */
export type ConversationWorkerReplyGenerator = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已清洗的分诊结果。 */
  readonly triage: MessageTriage;
  /** 路由决策。 */
  readonly route: ConversationRouteDecision;
}) => string | Promise<string>;

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
  /** 广播回复汇点，真实路径指向 BotActor.broadcastReply。 */
  readonly broadcastReplySink: ConversationBroadcastReplySink;
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

function createDefaultConversationWorker(input: {
  queueName: MessageQueueName;
  connection: RedisClientLike;
  processor: (job: { readonly data: unknown }) => Promise<void>;
}): ConversationBullmqWorkerLike {
  return new Worker(createBullmqPhysicalQueueName(input.queueName), input.processor, {
    connection: input.connection as WorkerOptions["connection"],
  });
}

function createDefaultTriage(): MessageTriage {
  return createMessageTriage({
    intent: "chat",
    priority: ConversationPriority.Normal,
    reason: "conversation_worker_fallback",
  });
}

function cloneWorkerTask(data: unknown): ConversationWorkerTask {
  const candidate = data as ConversationWorkerTask;

  return createConversationWorkerTask({
    bot_id: candidate.bot_id,
    message: candidate.message,
  });
}

/** 创建 ConversationWorker（对话工作线程） 真实运行时。 */
export function createConversationWorkerRuntime(input: {
  /** 待消费的消息队列。 */
  readonly queue: ConversationWorkerRuntimeQueue;
  /** 运行时依赖注入。 */
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): ConversationWorkerRuntime {
  let worker: ConversationBullmqWorkerLike | null = null;
  const events: ConversationWorkerRuntimeEvent[] = [];
  const createWorker = input.dependencies.createWorker ?? createDefaultConversationWorker;

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    const task = cloneWorkerTask(job.data);
    const triage = await (input.dependencies.triage?.({ task }) ?? createDefaultTriage());
    const route = createConversationRouteDecision({
      triage,
      message: task.message.content,
      has_active_task: input.dependencies.hasActiveTask?.() ?? false,
    });

    switch (route.kind) {
      case "chat_reply": {
        const generatedReply =
          (await input.dependencies.replyGenerator?.({ task, triage, route })) ??
          `收到：${task.message.content}`;
        const reply = createConversationReply({
          mode: "template",
          reply: generatedReply,
        });

        await input.dependencies.broadcastReplySink({
          message_id: task.message.message_id,
          content: reply.reply,
        });
        events.push(
          Object.freeze({
            type: "chat.reply",
            bot_id: task.bot_id,
            message_id: task.message.message_id,
            content: reply.reply,
          }),
        );
        break;
      }
      case "cancel_interrupt":
        events.push(
          Object.freeze({
            type: "cancel.logged",
            bot_id: task.bot_id,
            message_id: task.message.message_id,
            reason: route.triage.reason,
          }),
        );
        break;
      case "plan_exec":
      case "modify_interrupt_then_plan":
        events.push(
          Object.freeze({
            type: "task.discarded",
            bot_id: task.bot_id,
            message_id: task.message.message_id,
            status: TaskHistoryStatus.Discarded,
            reason: "planner_unavailable",
          }),
        );
        break;
    }
  };

  return Object.freeze({
    queue_name: input.queue.name,
    async start(): Promise<void> {
      if (worker !== null) {
        return;
      }

      worker = createWorker({
        queueName: input.queue.name,
        connection: input.queue.connection,
        processor: processTask,
      });
    },
    async close(): Promise<void> {
      const currentWorker = worker;
      worker = null;
      await currentWorker?.close();
    },
    getEvents(): readonly ConversationWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}
