import {
  MC_SERVANT_SCHEMA_NAME,
  MC_SERVANT_TABLE_NAMES,
  type McServantTableName,
} from "../data/contracts.js";
import type { ExecutionTaskKind } from "../domain/contracts.js";
import type { BotStatus } from "../runtime/contracts.js";

/** PostgreSQL（关系型数据库） 业务 schema 元信息。 */
export interface PostgresSchemaContract {
  /** 主业务 schema 名称。 */
  readonly businessSchema: typeof MC_SERVANT_SCHEMA_NAME;
  /** 只读依赖 schema 名称。 */
  readonly readonlySchemas: readonly string[];
  /** 纳入业务持久化的表名。 */
  readonly tables: readonly McServantTableName[];
}

/** PostgreSQL（关系型数据库） 扩展元信息。 */
export interface PostgresExtensionContract {
  /** 扩展名。 */
  readonly name: string;
  /** 安装 SQL。 */
  readonly installSql: string;
  /** 主要用途。 */
  readonly purpose: string;
}

/** Redis（缓存） 当前支持的状态缓存类型。 */
export const REDIS_STATE_CACHE_TYPES = ["bot_state"] as const;

/** Redis（缓存） 状态缓存类型联合。 */
export type RedisStateCacheType = (typeof REDIS_STATE_CACHE_TYPES)[number];

/** Redis（缓存） 状态快照中的当前任务结构。 */
export interface BotStateCacheTask {
  /** 任务标识。 */
  readonly job_id: string;
  /** 任务类型。 */
  readonly type: ExecutionTaskKind;
  /** 意图摘要。 */
  readonly intent: string;
  /** 任务开始时间戳（秒）。 */
  readonly started_at: number;
}

/** Redis（缓存） 内的 Bot 状态快照。 */
export interface BotStateCache {
  /** 缓存结构类型。 */
  readonly cache_type: RedisStateCacheType;
  /** Bot 当前状态。 */
  readonly state: BotStatus;
  /** 当前执行任务。 */
  readonly current_task?: BotStateCacheTask;
  /** 最近更新时间戳（秒）。 */
  readonly last_updated: number;
}

/** PostgreSQL（关系型数据库） schema 目录元信息。 */
export const POSTGRES_SCHEMA_CONTRACT = Object.freeze({
  businessSchema: MC_SERVANT_SCHEMA_NAME,
  readonlySchemas: [],
  tables: MC_SERVANT_TABLE_NAMES,
} satisfies PostgresSchemaContract);

/** PostgreSQL（关系型数据库） 扩展目录。 */
export const POSTGRES_EXTENSION_CONTRACTS = Object.freeze([
  Object.freeze({
    name: "vector",
    installSql: "CREATE EXTENSION IF NOT EXISTS vector;",
    purpose: "pgvector 向量检索",
  }),
  Object.freeze({
    name: "pg_trgm",
    installSql: "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    purpose: "模糊搜索与三元组索引",
  }),
] as const satisfies readonly PostgresExtensionContract[]);

/** 创建 Bot 状态缓存快照。 */
export function createBotStateCache(input: {
  state: BotStatus;
  current_task?: BotStateCacheTask;
  last_updated: number;
}): BotStateCache {
  if (!Number.isInteger(input.last_updated) || input.last_updated <= 0) {
    throw new Error("last_updated must be a positive integer");
  }

  const currentTask = input.current_task;

  if (currentTask !== undefined) {
    assertNonEmptyString(currentTask.job_id, "current_task.job_id");
    assertNonEmptyString(currentTask.intent, "current_task.intent");

    if (!Number.isInteger(currentTask.started_at) || currentTask.started_at <= 0) {
      throw new Error("current_task.started_at must be a positive integer");
    }
  }

  return Object.freeze({
    cache_type: "bot_state",
    state: input.state,
    ...(currentTask === undefined
      ? {}
      : {
          current_task: Object.freeze({
            job_id: currentTask.job_id,
            type: currentTask.type,
            intent: currentTask.intent,
            started_at: currentTask.started_at,
          }),
        }),
    last_updated: input.last_updated,
  });
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
