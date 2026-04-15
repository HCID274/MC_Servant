/**
 * Redis 键名管理与命名空间。
 *
 * 架构职责：
 * 1. 命名空间隔离：通过 `bot:{botId}:*` 前缀确保不同 Bot 之间的数据在 Redis 中物理隔离。
 * 2. 模式标准化：定义意图纪元（Intent Epoch）、状态（State）、观测快照（Snapshot）以及 BullMQ 队列键的统一命名模式。
 * 3. 键目录（Catalog）：提供聚合的 RedisKeyCatalog，方便业务层统一获取所有相关的 Redis 键名。
 */

import { assertNonEmptyString } from "../domain/invariants.js";
import {
  type BrainQueueName,
  type ExecQueueName,
  type MessageQueueName,
  type WorkerQueueName,
  createBrainQueueName,
  createExecQueueName,
  createMessageQueueName,
} from "../workers/queues.js";

/** `bot:{botId}:intent_epoch`（意图纪元） 键名。 */
export type IntentEpochRedisKey<TBotId extends string = string> = `bot:${TBotId}:intent_epoch`;

/** `bot:{botId}:state`（状态快照） 键名。 */
export type BotStateRedisKey<TBotId extends string = string> = `bot:${TBotId}:state`;

/** `bot:{botId}:snapshot`（观测快照） 键名。 */
export type BotSnapshotRedisKey<TBotId extends string = string> = `bot:${TBotId}:snapshot`;

/** `bull:{queue}:*`（BullMQ 键模式） 类型。 */
export type BullQueueKeyPattern<TQueue extends WorkerQueueName = WorkerQueueName> =
  `bull:${TQueue}:*`;

/** 单个 Bot 的 Redis（缓存） 键目录。 */
export interface RedisKeyCatalog<TBotId extends string = string> {
  /** 意图纪元键。 */
  readonly intentEpoch: IntentEpochRedisKey<TBotId>;
  /** 状态缓存键。 */
  readonly state: BotStateRedisKey<TBotId>;
  /** 观测快照键。 */
  readonly snapshot: BotSnapshotRedisKey<TBotId>;
  /** BullMQ 键模式集合。 */
  readonly queues: {
    /** ConversationWorker 队列键模式。 */
    readonly conversation: BullQueueKeyPattern<MessageQueueName<TBotId>>;
    /** BotWorker 队列键模式。 */
    readonly exec: BullQueueKeyPattern<ExecQueueName<TBotId>>;
    /** BrainWorker 队列键模式。 */
    readonly brain: BullQueueKeyPattern<BrainQueueName>;
  };
}

/**
 * 创建意图纪元键名。
 *
 * 架构意图：
 * 生成一个按 Bot 隔离的 Redis Key，用于存储当前的纪元计数。
 *
 * @param botId Bot 唯一标识
 * @returns 意图纪元键名
 */
export function createIntentEpochKey<TBotId extends string>(
  botId: TBotId,
): IntentEpochRedisKey<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:intent_epoch`;
}

/**
 * 创建状态缓存键名。
 *
 * 架构意图：
 * 生成一个按 Bot 隔离的 Redis Key，用于存储实时的 Bot 状态快照。
 *
 * @param botId Bot 唯一标识
 * @returns 状态缓存键名
 */
export function createBotStateKey<TBotId extends string>(botId: TBotId): BotStateRedisKey<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:state`;
}

/**
 * 创建观测快照键名。
 *
 * 架构意图：
 * 生成一个按 Bot 隔离的 Redis Key，用于存储最新的环境观测快照。
 *
 * @param botId Bot 唯一标识
 * @returns 观测快照键名
 */
export function createBotSnapshotKey<TBotId extends string>(
  botId: TBotId,
): BotSnapshotRedisKey<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:snapshot`;
}

/** 基于队列名创建 `bull:{queue}:*`（BullMQ） 键模式。 */
export function createBullQueueKeyPattern<TQueue extends WorkerQueueName>(
  queueName: TQueue,
): BullQueueKeyPattern<TQueue> {
  return `bull:${queueName}:*`;
}

/**
 * 创建按 Bot 视角收口的 Redis 键目录。
 *
 * 架构意图：
 * 作为一个聚合工厂，它将分散的 Key 生成逻辑整合在一起，
 * 为业务层提供一个一站式的“Key 导航表”，包括状态键、快照键以及各 Worker 队列的键模式。
 *
 * @param botId Bot 唯一标识
 * @returns 完整的 RedisKeyCatalog
 */
export function createRedisKeyCatalog<TBotId extends string>(
  botId: TBotId,
): RedisKeyCatalog<TBotId> {
  return Object.freeze({
    intentEpoch: createIntentEpochKey(botId),
    state: createBotStateKey(botId),
    snapshot: createBotSnapshotKey(botId),
    queues: Object.freeze({
      conversation: createBullQueueKeyPattern(createMessageQueueName(botId)),
      exec: createBullQueueKeyPattern(createExecQueueName(botId)),
      brain: createBullQueueKeyPattern(createBrainQueueName()),
    }),
  });
}
