import { Worker, type WorkerOptions } from "bullmq";

import { createConversationReply } from "../../conversation/chat.js";
import type { ConversationCompositeTriage } from "../../conversation/contracts.js";
import type { ConversationGeneratedReply } from "../../conversation/llm.js";
import type { BotActorStateProjection } from "../../core-ports/runtime.js";
import { ExecPriority } from "../../core-ports/tasking.js";
import {
  type TaskMemorySearchResult,
  createMemoryContextFromTaskSummaries,
} from "../../data/contracts/task-history.js";
import type { RedisClientLike } from "../../db/index.js";
import { createBullmqPhysicalQueueName } from "../bullmq.js";
import { type ConversationWorkerTask, createConversationWorkerTask } from "../contracts.js";
import type { MessageQueueName } from "../queues.js";
import type { ConversationBullmqWorkerLike } from "./types.js";

const DEFAULT_WORKER_MEMORY_CONTEXT_LIMIT = 5;
const DEFAULT_WORKER_MEMORY_CONTEXT_CHAR_BUDGET = 800;

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

export function createDefaultTriage(): ConversationCompositeTriage {
  return Object.freeze({
    reply: Object.freeze({}),
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
 * 创建未启用技能的模板回复。
 *
 * T-046（任务四十六） 只允许 goTo（前往坐标） 与 collect（捡拾） 进入在线执行队列；其他技能必须明确拒绝。
 */
export function createSkillNotEnabledReply() {
  return createConversationReply({
    mode: "template",
    reply: "这个技能还没有通过单技能验收，当前只允许执行 goTo 前往坐标和 collect 捡拾喵~",
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

/** 将 BotActor（机器人执行代理） 状态投影收口为可注入闲聊的短摘要。 */
export function createConversationStateContextFromProjection(
  projection: BotActorStateProjection | null | undefined,
): string | undefined {
  const summary = projection?.summary.trim();

  if (summary === undefined || summary.length === 0) {
    return undefined;
  }

  return summary.length > 240 ? `${summary.slice(0, 240)}...` : summary;
}

/** ConversationWorker（对话工作线程） memory（记忆）上下文默认限制。 */
export const CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT = DEFAULT_WORKER_MEMORY_CONTEXT_LIMIT;

/** ConversationWorker（对话工作线程） memory（记忆）上下文默认字符预算。 */
export const CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET =
  DEFAULT_WORKER_MEMORY_CONTEXT_CHAR_BUDGET;

/** 复用 data（数据）层排序与预算语义构造 worker（工作线程） memory（记忆）上下文。 */
export function createConversationWorkerMemoryContext(input: {
  /** 检索结果。 */
  readonly results: readonly TaskMemorySearchResult[];
  /** 最大条数。 */
  readonly limit?: number;
  /** 最大字符预算。 */
  readonly char_budget?: number;
}): string | undefined {
  const context = createMemoryContextFromTaskSummaries({
    results: input.results,
    limit: input.limit ?? CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
    char_budget: input.char_budget ?? CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  }).trim();

  return context.length === 0 ? undefined : context;
}

/** 归一化 provider（提供器） 返回的 memory_context（记忆上下文），避免未限长文本进入 LLM（大语言模型）。 */
export function normalizeMemoryContext(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length > CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET) {
    return `${trimmed.slice(0, CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET - 1)}…`;
  }

  return trimmed;
}
