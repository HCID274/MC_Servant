/**
 * 任务队列命名与并发目录。
 * 
 * 架构职责：
 * 1. 队列命名空间：定义 Conversation (msg:), Bot (bot::exec) 和 Brain (brain) 的物理队列命名规则。
 * 2. 并发策略模型：为不同类型的 Worker 指定并发模型（parallel - 消息处理、serial - 机器人动作执行、pooled - 摘要计算）。
 * 3. 目录工厂：提供一站式的 `createWorkerQueueCatalog`，方便基础设施层（如 BullMQ 初始化）统一获取 Bot 相关的队列配置。
 */

import { assertNonEmptyString } from "../domain/invariants.js";

/** Worker（工作线程） 类型清单。 */
export const WORKER_KINDS = ["conversation", "bot", "brain"] as const;

/** Worker（工作线程） 类型联合。 */
export type WorkerKind = (typeof WORKER_KINDS)[number];

/** `ConversationWorker`（对话工作线程） 消费的消息队列名。 */
export type MessageQueueName<TBotId extends string = string> = `msg:${TBotId}`;

/** `BotWorker`（机器人工作线程） 消费的执行队列名。 */
export type ExecQueueName<TBotId extends string = string> = `bot:${TBotId}:exec`;

/** `BrainWorker`（摘要工作线程） 消费的全局队列名。 */
export type BrainQueueName = "brain";

/** 所有 Worker（工作线程） 队列名联合。 */
export type WorkerQueueName = MessageQueueName | ExecQueueName | BrainQueueName;

/** Worker（工作线程） 队列并发模型清单。 */
export const WORKER_QUEUE_CONCURRENCIES = ["parallel", "serial", "pooled"] as const;

/** Worker（工作线程） 队列并发模型联合。 */
export type WorkerQueueConcurrency = (typeof WORKER_QUEUE_CONCURRENCIES)[number];

/** 单条队列绑定信息。 */
export interface WorkerQueueBinding {
  /** Worker 类型。 */
  readonly worker: WorkerKind;
  /** 队列名。 */
  readonly queue: WorkerQueueName;
  /** 并发模型。 */
  readonly concurrency: WorkerQueueConcurrency;
}

/** 按 Bot 视角展开的三队列目录。 */
export interface WorkerQueueCatalog<TBotId extends string = string> {
  /** 对话队列。 */
  readonly conversation: WorkerQueueBinding & {
    readonly worker: "conversation";
    readonly queue: MessageQueueName<TBotId>;
    readonly concurrency: "parallel";
  };
  /** 执行队列。 */
  readonly bot: WorkerQueueBinding & {
    readonly worker: "bot";
    readonly queue: ExecQueueName<TBotId>;
    readonly concurrency: "serial";
  };
  /** 摘要队列。 */
  readonly brain: WorkerQueueBinding & {
    readonly worker: "brain";
    readonly queue: BrainQueueName;
    readonly concurrency: "pooled";
  };
}

/**
 * 创建消息队列名称。
 * 
 * 架构意图：
 * 为对话工作线程（ConversationWorker）生成按 Bot 隔离的队列标识。
 * 
 * @param botId Bot 唯一标识
 * @returns 格式化后的队列名
 */
export function createMessageQueueName<TBotId extends string>(
  botId: TBotId,
): MessageQueueName<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `msg:${botId}`;
}

/**
 * 创建执行队列名称。
 * 
 * 架构意图：
 * 为机器人执行线程（BotWorker）生成按 Bot 隔离的队列标识，确保动作执行的串行性。
 * 
 * @param botId Bot 唯一标识
 * @returns 格式化后的队列名
 */
export function createExecQueueName<TBotId extends string>(botId: TBotId): ExecQueueName<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:exec`;
}

/** 创建全局 `brain`（摘要） 队列名称。 */
export function createBrainQueueName(): BrainQueueName {
  return "brain";
}

/**
 * 创建按 Bot 展开的任务队列目录。
 * 
 * 架构意图：
 * 作为一个聚合工厂，它一次性构建出 Bot 运行所需的所有队列绑定信息（Conversation, Bot, Brain），
 * 包括其名称、Worker 类型以及并发模型。这为上层基础设施提供了统一的配置视图。
 * 
 * @param botId Bot 唯一标识
 * @returns 完整的队列目录对象
 */
export function createWorkerQueueCatalog<TBotId extends string>(
  botId: TBotId,
): WorkerQueueCatalog<TBotId> {
  return Object.freeze({
    conversation: Object.freeze({
      worker: "conversation",
      queue: createMessageQueueName(botId),
      concurrency: "parallel",
    }),
    bot: Object.freeze({
      worker: "bot",
      queue: createExecQueueName(botId),
      concurrency: "serial",
    }),
    brain: Object.freeze({
      worker: "brain",
      queue: createBrainQueueName(),
      concurrency: "pooled",
    }),
  });
}
