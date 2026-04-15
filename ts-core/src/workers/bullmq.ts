/**
 * BullMQ（任务队列） 运行时队列工厂。
 *
 * 架构职责：
 * 1. 基于共享 Redis（缓存） 连接创建三组真实 BullMQ Queue（任务队列） 实例。
 * 2. 收口 Conversation / Bot / Brain 三队列的运行时句柄与关闭边界。
 * 3. 提供依赖注入能力，允许测试在无真实 Redis（缓存） 的情况下验证创建与关闭时序。
 */

import { Queue, type QueueOptions } from "bullmq";

import type { RedisClientLike, RedisRuntimeResource } from "../db/index.js";
import type { BrainQueueName, ExecQueueName, MessageQueueName, WorkerQueueName } from "./queues.js";
import { type WorkerQueueCatalog, createWorkerQueueCatalog } from "./queues.js";

/** BullMQ（任务队列） 单条 Queue 的最小能力边界。 */
export interface BullmqQueueLike<TName extends WorkerQueueName = WorkerQueueName> {
  /** 当前队列名称。 */
  readonly name: TName;
  /** 关闭队列句柄。 */
  close(): Promise<unknown>;
}

/** 单条 BullMQ（任务队列） 运行时句柄。 */
export interface WorkerBullmqQueueRuntime<TName extends WorkerQueueName = WorkerQueueName> {
  /** 队列名称。 */
  readonly name: TName;
  /** 底层 BullMQ Queue（任务队列） 实例。 */
  readonly queue: BullmqQueueLike<TName>;
}

/** 三队列 BullMQ（任务队列） 运行时句柄。 */
export interface WorkerBullmqRuntime<TBotId extends string = string> {
  /** 资源类型。 */
  readonly kind: "bullmq";
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 队列目录快照。 */
  readonly catalog: WorkerQueueCatalog<TBotId>;
  /** 对话队列句柄。 */
  readonly conversation: WorkerBullmqQueueRuntime<MessageQueueName<TBotId>>;
  /** 执行队列句柄。 */
  readonly bot: WorkerBullmqQueueRuntime<ExecQueueName<TBotId>>;
  /** 摘要队列句柄。 */
  readonly brain: WorkerBullmqQueueRuntime<BrainQueueName>;
  /** 按约定顺序关闭全部队列。 */
  close(): Promise<void>;
}

/** BullMQ（任务队列） 运行时工厂可注入依赖。 */
export interface WorkerBullmqDependencies {
  /** 自定义 Queue（任务队列） 工厂。 */
  readonly createQueue?: <TName extends WorkerQueueName>(input: {
    name: TName;
    connection: RedisClientLike;
  }) => BullmqQueueLike<TName>;
  /** 自定义 Queue（任务队列） 关闭逻辑。 */
  readonly closeQueue?: (queue: BullmqQueueLike) => Promise<void>;
}

function createBullmqQueue<TName extends WorkerQueueName>(input: {
  name: TName;
  connection: RedisClientLike;
}): BullmqQueueLike<TName> {
  return new Queue(input.name, {
    connection: input.connection as QueueOptions["connection"],
  }) as unknown as BullmqQueueLike<TName>;
}

function createQueueRuntime<TName extends WorkerQueueName>(input: {
  name: TName;
  connection: RedisClientLike;
  dependencies: WorkerBullmqDependencies;
}): WorkerBullmqQueueRuntime<TName> {
  const queueFactory = input.dependencies.createQueue ?? createBullmqQueue;
  const queue = queueFactory({
    name: input.name,
    connection: input.connection,
  });

  return Object.freeze({
    name: input.name,
    queue,
  });
}

/**
 * 关闭 BullMQ（任务队列） 运行时句柄；即使前一步失败也继续清理剩余队列。
 *
 * @param input 运行时资源与可注入关闭依赖
 */
export async function closeWorkerBullmqRuntime<TBotId extends string>(input: {
  runtime: WorkerBullmqRuntime<TBotId>;
  dependencies?: WorkerBullmqDependencies;
}): Promise<void> {
  const closeQueue =
    input.dependencies?.closeQueue ??
    (async (queue: BullmqQueueLike) => {
      await queue.close();
    });
  const closeErrors: unknown[] = [];

  for (const queueRuntime of [input.runtime.brain, input.runtime.bot, input.runtime.conversation]) {
    try {
      await closeQueue(queueRuntime.queue);
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length > 0) {
    throw closeErrors[0];
  }
}

/**
 * 创建三队列 BullMQ（任务队列） 运行时句柄。
 *
 * @param input Bot 标识与共享 Redis（缓存） 连接
 * @param dependencies 可注入的 Queue（任务队列） 工厂依赖
 * @returns 已收口关闭边界的三队列运行时资源
 */
export function createWorkerBullmqRuntime<TBotId extends string>(
  input: {
    botId: TBotId;
    redis: Pick<RedisRuntimeResource, "client">;
  },
  dependencies: WorkerBullmqDependencies = {},
): WorkerBullmqRuntime<TBotId> {
  const catalog = createWorkerQueueCatalog(input.botId);
  const conversation = createQueueRuntime({
    name: catalog.conversation.queue,
    connection: input.redis.client,
    dependencies,
  });
  const bot = createQueueRuntime({
    name: catalog.bot.queue,
    connection: input.redis.client,
    dependencies,
  });
  const brain = createQueueRuntime({
    name: catalog.brain.queue,
    connection: input.redis.client,
    dependencies,
  });

  return Object.freeze({
    kind: "bullmq",
    bot_id: input.botId,
    catalog,
    conversation,
    bot,
    brain,
    async close(): Promise<void> {
      await closeWorkerBullmqRuntime({
        runtime: {
          kind: "bullmq",
          bot_id: input.botId,
          catalog,
          conversation,
          bot,
          brain,
          close: async () => undefined,
        },
        dependencies,
      });
    },
  });
}
