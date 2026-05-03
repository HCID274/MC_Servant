import { assertNonEmptyString } from "../domain/invariants.js";
import type { RedisClientLike } from "./connection.js";
import { createIntentEpochKey } from "./keys.js";

/** intent_epoch（意图纪元） 的单调读写端口。 */
export interface IntentEpochStore {
  /** 推进指定 Bot（机器人） 的意图纪元并返回新值。 */
  next(botId: string): Promise<number>;
  /** 读取指定 Bot（机器人） 当前意图纪元；未初始化时为 0。 */
  read(botId: string): Promise<number>;
}

/** 创建基于 Redis INCR（缓存自增命令） 的 intent_epoch（意图纪元） 存储。 */
export function createRedisIntentEpochStore(input: {
  readonly client: RedisClientLike;
}): IntentEpochStore {
  return Object.freeze({
    async next(botId: string) {
      assertNonEmptyString(botId, "botId");
      if (typeof input.client.incr !== "function") {
        throw new Error("Redis client does not support incr for intent_epoch");
      }

      const value = await input.client.incr(createIntentEpochKey(botId));
      assertIntentEpoch(value, "intent_epoch");

      return value;
    },
    async read(botId: string) {
      assertNonEmptyString(botId, "botId");
      if (typeof input.client.get !== "function") {
        throw new Error("Redis client does not support get for intent_epoch");
      }

      const raw = await input.client.get(createIntentEpochKey(botId));
      if (raw === null) {
        return 0;
      }

      const value = Number(raw);
      assertIntentEpoch(value, "intent_epoch");

      return value;
    },
  });
}

function assertIntentEpoch(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}
