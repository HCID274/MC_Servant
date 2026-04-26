import { Worker, type WorkerOptions } from "bullmq";

import { createConversationReply } from "../../conversation/chat.js";
import type { ConversationGeneratedReply } from "../../conversation/llm.js";
import { createMessageTriage } from "../../conversation/triage.js";
import { ConversationPriority } from "../../core-ports/foundation.js";
import type { MessageTriage } from "../../core-ports/foundation.js";
import { ExecPriority } from "../../core-ports/tasking.js";
import type { RedisClientLike } from "../../db/index.js";
import { createBullmqPhysicalQueueName } from "../bullmq.js";
import { type ConversationWorkerTask, createConversationWorkerTask } from "../contracts.js";
import type { MessageQueueName } from "../queues.js";
import type { ConversationBullmqWorkerLike } from "./types.js";

export function createDefaultConversationWorker(input: {
  queueName: MessageQueueName;
  connection: RedisClientLike;
  processor: (job: { readonly data: unknown }) => Promise<void>;
}): ConversationBullmqWorkerLike {
  return new Worker(createBullmqPhysicalQueueName(input.queueName), input.processor, {
    connection: input.connection as WorkerOptions["connection"],
  });
}
/** 生成默认的对话意图分诊结果。 */

export function createDefaultTriage(): MessageTriage {
  return createMessageTriage({
    intent: "chat",
    priority: ConversationPriority.Normal,
    reason: "conversation_worker_fallback",
  });
}
/** 克隆并校验对话任务数据。 */

export function cloneWorkerTask(data: unknown): ConversationWorkerTask {
  const candidate = data as ConversationWorkerTask;

  return createConversationWorkerTask({
    bot_id: candidate.bot_id,
    message: candidate.message,
  });
}
/** 将系统执行优先级映射到队列数值。 */

export function toBullmqPriority(priority: ExecPriority): number {
  switch (priority) {
    case ExecPriority.Urgent:
      return 1;
    case ExecPriority.Normal:
      return 5;
    case ExecPriority.Background:
      return 10;
  }
}

/**
 * 创建任务规划失败的模板回复。
 *
 * 当前阶段不把规划失败伪装成闲聊；统一返回明确失败回执。
 */
export function createPlanningFailureReply() {
  return createConversationReply({
    mode: "template",
    reply: "抱歉，这次我还没能规划出可执行的技能任务喵~",
  });
}

/**
 * 归一化回复生成结果。
 *
 * @param result 回复生成器返回值
 * @returns 统一后的回复结构
 */
export function normalizeGeneratedReply(
  result: string | ConversationGeneratedReply,
): ConversationGeneratedReply {
  if (typeof result === "string") {
    return Object.freeze({
      mode: "template",
      reply: result,
    });
  }

  return Object.freeze({
    ...result,
    ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
  });
}
