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

/** 创建 `bot:{botId}:intent_epoch`（意图纪元） 键名。 */
export function createIntentEpochKey<TBotId extends string>(
  botId: TBotId,
): IntentEpochRedisKey<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:intent_epoch`;
}

/** 创建 `bot:{botId}:state`（状态快照） 键名。 */
export function createBotStateKey<TBotId extends string>(botId: TBotId): BotStateRedisKey<TBotId> {
  assertNonEmptyString(botId, "botId");

  return `bot:${botId}:state`;
}

/** 创建 `bot:{botId}:snapshot`（观测快照） 键名。 */
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

/** 创建按 Bot 视角收口的 Redis（缓存） 键目录。 */
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

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
