import { ExecutionTaskKind, MessageSource } from "../domain/contracts.js";
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventLogEntry,
  type RuntimeEventType,
} from "../runtime/events.js";
import { type ExecJob, type InterruptedTaskRecord, TaskHistoryStatus } from "../runtime/tasking.js";
import { DEFAULT_LOGS_BASE_DIR, EVENT_LOG_RETENTION_DAYS, JSONL_RETENTION_DAYS } from "./logs.js";

/** mc_servant 业务 schema 名称。 */
export const MC_SERVANT_SCHEMA_NAME = "mc_servant" as const;

/** mc_servant 持久化表名清单。 */
export const MC_SERVANT_TABLE_NAMES = [
  "owners",
  "bots",
  "owner_bots",
  "sessions",
  "chat_messages",
  "event_log",
  "task_history",
  "task_summaries",
  "session_summaries",
] as const;

/** 持久化层的表名联合类型。 */
export type McServantTableName = (typeof MC_SERVANT_TABLE_NAMES)[number];

/** chat_messages 表允许的角色值。 */
export const CHAT_MESSAGE_ROLES = ["user", "bot"] as const;

/** chat_messages 表角色联合类型。 */
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

/** 持久化层复用的消息来源清单。 */
export const PERSISTED_MESSAGE_SOURCES = [
  MessageSource.Web,
  MessageSource.Game,
  MessageSource.System,
] as const;

/** 持久化层消息来源联合类型。 */
export type PersistedMessageSource = (typeof PERSISTED_MESSAGE_SOURCES)[number];

/** event_log 表允许的事件类型清单。 */
export const PERSISTED_EVENT_TYPES = [...RUNTIME_EVENT_TYPES] as const;

/** event_log 表事件类型联合。 */
export type PersistedEventType = RuntimeEventType;

/** event_log 表 payload 结构。 */
export type PersistedEventPayload = RuntimeEventLogEntry["payload"];

/** task_history 表允许的任务类型清单。 */
export const TASK_HISTORY_TASK_TYPES = [
  ExecutionTaskKind.SkillCall,
  ExecutionTaskKind.SandboxCode,
] as const;

/** task_history 表任务类型联合。 */
export type PersistedTaskType = ExecJob["type"];

/** task_history 表允许的状态清单。 */
export const TASK_HISTORY_STATUS_VALUES = [
  TaskHistoryStatus.Accepted,
  TaskHistoryStatus.Started,
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
  TaskHistoryStatus.Discarded,
] as const;

/** task_history 表状态联合。 */
export type PersistedTaskStatus = TaskHistoryStatus;

/** task_summaries 表允许的终态清单。 */
export const TASK_SUMMARY_STATUS_VALUES = [
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
] as const;

/** task_summaries 表终态联合。 */
export type TaskSummaryStatus = (typeof TASK_SUMMARY_STATUS_VALUES)[number];

/** task_history.interrupt_source 的持久化类型。 */
export type PersistedInterruptSource = InterruptedTaskRecord["interrupt_source"];

/** Embedding（向量） 默认维度。 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024 as const;

/** 配置环境变量绑定定义。 */
export interface ConfigEnvBinding<
  TValue extends string | number | undefined = string | number | undefined,
> {
  /** 规范环境变量名。 */
  readonly envVar: string;
  /** 兼容读取的历史别名。 */
  readonly aliases: readonly string[];
  /** 省略时采用的默认值。 */
  readonly defaultValue: TValue;
}

/** PostgreSQL（关系型数据库） 连接池配置。 */
export interface PostgresPoolConfig {
  /** 最小连接数。 */
  readonly min: number;
  /** 最大连接数。 */
  readonly max: number;
}

/** PostgreSQL（关系型数据库） 连接参数。 */
export interface PostgresConfig {
  /** 主机名。 */
  readonly host: string;
  /** 端口。 */
  readonly port: number;
  /** 数据库名。 */
  readonly database: string;
  /** 用户名。 */
  readonly user: string;
  /** 密码。 */
  readonly password?: string;
  /** 连接池参数。 */
  readonly pool: PostgresPoolConfig;
}

/** Redis（缓存） 连接参数。 */
export interface RedisConfig {
  /** Redis URL。 */
  readonly url: string;
}

/** 日志保留期配置。 */
export interface LogRetentionConfig {
  /** PostgreSQL event_log 保留天数。 */
  readonly eventLogDays: number;
  /** tasks JSONL 保留天数。 */
  readonly taskLogDays: number;
  /** sandbox JSONL 保留天数。 */
  readonly sandboxLogDays: number;
  /** llm JSONL 保留天数。 */
  readonly llmLogDays: number;
}

/** JSONL（结构化日志） 根目录配置。 */
export interface LogsConfig {
  /** 日志根目录。 */
  readonly baseDir: string;
  /** 保留期配置。 */
  readonly retention: LogRetentionConfig;
}

/** Embedding（向量） 相关配置。 */
export interface EmbeddingConfig {
  /** 向量维度。 */
  readonly dimensions: number;
}

/** 运行时可消费的基础设施配置。 */
export interface DataConfig {
  /** PostgreSQL（关系型数据库） 配置。 */
  readonly postgres: PostgresConfig;
  /** Redis（缓存） 配置。 */
  readonly redis: RedisConfig;
  /** 日志配置。 */
  readonly logs: LogsConfig;
  /** Embedding（向量） 配置。 */
  readonly embedding: EmbeddingConfig;
}

/** Bot 级日志覆盖配置。 */
export interface BotLogsConfigOverlay {
  /** 可选日志根目录覆盖。 */
  readonly baseDir?: string;
  /** 可选日志保留期覆盖。 */
  readonly retention?: Partial<LogRetentionConfig>;
}

/** Bot 级 Embedding（向量） 覆盖配置。 */
export interface BotEmbeddingConfigOverlay {
  /** 可选维度覆盖。 */
  readonly dimensions?: number;
}

/** `bots.config`（机器人配置） 的强类型覆盖结构。 */
export interface BotConfigOverlay {
  /** 日志配置覆盖。 */
  readonly logs?: BotLogsConfigOverlay;
  /** Embedding（向量） 配置覆盖。 */
  readonly embedding?: BotEmbeddingConfigOverlay;
}

/** `PG_HOST` 配置绑定。 */
export const PG_HOST_ENV_BINDING = {
  envVar: "PG_HOST",
  aliases: [],
  defaultValue: "localhost",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_PORT` 配置绑定。 */
export const PG_PORT_ENV_BINDING = {
  envVar: "PG_PORT",
  aliases: [],
  defaultValue: 5432,
} as const satisfies ConfigEnvBinding<number>;

/** `PG_DATABASE` 配置绑定。 */
export const PG_DATABASE_ENV_BINDING = {
  envVar: "PG_DATABASE",
  aliases: [],
  defaultValue: "ts_core",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_USER` 配置绑定。 */
export const PG_USER_ENV_BINDING = {
  envVar: "PG_USER",
  aliases: [],
  defaultValue: "ts_core",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_PASSWORD` 配置绑定。 */
export const PG_PASSWORD_ENV_BINDING = {
  envVar: "PG_PASSWORD",
  aliases: [],
  defaultValue: undefined,
} as const satisfies ConfigEnvBinding<string | undefined>;

/** `PG_POOL_MIN` 配置绑定。 */
export const PG_POOL_MIN_ENV_BINDING = {
  envVar: "PG_POOL_MIN",
  aliases: [],
  defaultValue: 2,
} as const satisfies ConfigEnvBinding<number>;

/** `PG_POOL_MAX` 配置绑定。 */
export const PG_POOL_MAX_ENV_BINDING = {
  envVar: "PG_POOL_MAX",
  aliases: [],
  defaultValue: 10,
} as const satisfies ConfigEnvBinding<number>;

/** `REDIS_URL` 配置绑定。 */
export const REDIS_URL_ENV_BINDING = {
  envVar: "REDIS_URL",
  aliases: [],
  defaultValue: "redis://localhost:6379",
} as const satisfies ConfigEnvBinding<string>;

/** `LOGS_BASE_DIR` 配置绑定。 */
export const LOGS_BASE_DIR_ENV_BINDING = {
  envVar: "LOGS_BASE_DIR",
  aliases: ["LOGS_DIR"],
  defaultValue: DEFAULT_LOGS_BASE_DIR,
} as const satisfies ConfigEnvBinding<string>;

/** `EVENT_LOG_RETENTION_DAYS` 配置绑定。 */
export const EVENT_LOG_RETENTION_ENV_BINDING = {
  envVar: "EVENT_LOG_RETENTION_DAYS",
  aliases: ["EVENT_RETENTION"],
  defaultValue: EVENT_LOG_RETENTION_DAYS,
} as const satisfies ConfigEnvBinding<number>;

/** `TASK_LOG_RETENTION_DAYS` 配置绑定。 */
export const TASK_LOG_RETENTION_ENV_BINDING = {
  envVar: "TASK_LOG_RETENTION_DAYS",
  aliases: ["TASK_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.tasks,
} as const satisfies ConfigEnvBinding<number>;

/** `LLM_LOG_RETENTION_DAYS` 配置绑定。 */
export const LLM_LOG_RETENTION_ENV_BINDING = {
  envVar: "LLM_LOG_RETENTION_DAYS",
  aliases: ["LLM_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.llm,
} as const satisfies ConfigEnvBinding<number>;

/** `EMBEDDING_DIMENSIONS` 配置绑定。 */
export const EMBEDDING_DIMENSIONS_ENV_BINDING = {
  envVar: "EMBEDDING_DIMENSIONS",
  aliases: ["EMBED_DIM"],
  defaultValue: DEFAULT_EMBEDDING_DIMENSIONS,
} as const satisfies ConfigEnvBinding<number>;

/** 基础设施配置环境变量目录。 */
export const DATA_CONFIG_ENV_BINDINGS = Object.freeze({
  postgresHost: PG_HOST_ENV_BINDING,
  postgresPort: PG_PORT_ENV_BINDING,
  postgresDatabase: PG_DATABASE_ENV_BINDING,
  postgresUser: PG_USER_ENV_BINDING,
  postgresPassword: PG_PASSWORD_ENV_BINDING,
  postgresPoolMin: PG_POOL_MIN_ENV_BINDING,
  postgresPoolMax: PG_POOL_MAX_ENV_BINDING,
  redisUrl: REDIS_URL_ENV_BINDING,
  logsBaseDir: LOGS_BASE_DIR_ENV_BINDING,
  eventLogRetentionDays: EVENT_LOG_RETENTION_ENV_BINDING,
  taskLogRetentionDays: TASK_LOG_RETENTION_ENV_BINDING,
  llmLogRetentionDays: LLM_LOG_RETENTION_ENV_BINDING,
  embeddingDimensions: EMBEDDING_DIMENSIONS_ENV_BINDING,
});

/** 可注入的环境变量快照。 */
export type DataConfigEnvironment = Readonly<Record<string, string | undefined>>;

/** 基于环境变量与可选 Bot 覆盖创建基础设施配置。 */
export function createDataConfig(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): DataConfig {
  const baseConfig = createBaseDataConfig(input.env ?? {});
  const botConfig = createBotConfigOverlay(input.botConfig);

  return applyBotConfigOverlay(baseConfig, botConfig);
}

/** 解析 `bots.config`（机器人配置） 为强类型覆盖对象。 */
export function createBotConfigOverlay(input: unknown): BotConfigOverlay {
  if (input === undefined) {
    return Object.freeze({});
  }

  const overlay = asPlainObject(input, "botConfig");
  assertAllowedKeys(overlay, ["logs", "embedding"], "botConfig");

  const logsValue = overlay.logs;
  const embeddingValue = overlay.embedding;

  const normalizedLogs = logsValue === undefined ? undefined : normalizeBotLogsConfig(logsValue);
  const normalizedEmbedding =
    embeddingValue === undefined ? undefined : normalizeBotEmbeddingConfig(embeddingValue);

  return Object.freeze({
    ...(normalizedLogs === undefined ? {} : { logs: normalizedLogs }),
    ...(normalizedEmbedding === undefined ? {} : { embedding: normalizedEmbedding }),
  });
}

/** 将 Bot 级覆盖合并到基础设施配置。 */
export function applyBotConfigOverlay(
  baseConfig: DataConfig,
  overlay: BotConfigOverlay,
): DataConfig {
  const mergedRetention = Object.freeze({
    eventLogDays: overlay.logs?.retention?.eventLogDays ?? baseConfig.logs.retention.eventLogDays,
    taskLogDays: overlay.logs?.retention?.taskLogDays ?? baseConfig.logs.retention.taskLogDays,
    sandboxLogDays:
      overlay.logs?.retention?.sandboxLogDays ?? baseConfig.logs.retention.sandboxLogDays,
    llmLogDays: overlay.logs?.retention?.llmLogDays ?? baseConfig.logs.retention.llmLogDays,
  });

  return Object.freeze({
    postgres: Object.freeze({
      host: baseConfig.postgres.host,
      port: baseConfig.postgres.port,
      database: baseConfig.postgres.database,
      user: baseConfig.postgres.user,
      ...(baseConfig.postgres.password === undefined
        ? {}
        : {
            password: baseConfig.postgres.password,
          }),
      pool: Object.freeze({
        min: baseConfig.postgres.pool.min,
        max: baseConfig.postgres.pool.max,
      }),
    }),
    redis: Object.freeze({
      url: baseConfig.redis.url,
    }),
    logs: Object.freeze({
      baseDir: overlay.logs?.baseDir ?? baseConfig.logs.baseDir,
      retention: mergedRetention,
    }),
    embedding: Object.freeze({
      dimensions: overlay.embedding?.dimensions ?? baseConfig.embedding.dimensions,
    }),
  });
}

function createBaseDataConfig(env: DataConfigEnvironment): DataConfig {
  const poolMin = readPositiveInteger(env, PG_POOL_MIN_ENV_BINDING);
  const poolMax = readPositiveInteger(env, PG_POOL_MAX_ENV_BINDING);
  const password = readOptionalString(env, PG_PASSWORD_ENV_BINDING);

  if (poolMin > poolMax) {
    throw new Error("PG_POOL_MIN must be less than or equal to PG_POOL_MAX");
  }

  return Object.freeze({
    postgres: Object.freeze({
      host: readRequiredString(env, PG_HOST_ENV_BINDING),
      port: readPort(env, PG_PORT_ENV_BINDING),
      database: readRequiredString(env, PG_DATABASE_ENV_BINDING),
      user: readRequiredString(env, PG_USER_ENV_BINDING),
      ...(password === undefined
        ? {}
        : {
            password,
          }),
      pool: Object.freeze({
        min: poolMin,
        max: poolMax,
      }),
    }),
    redis: Object.freeze({
      url: readRequiredString(env, REDIS_URL_ENV_BINDING),
    }),
    logs: Object.freeze({
      baseDir: readRequiredString(env, LOGS_BASE_DIR_ENV_BINDING),
      retention: Object.freeze({
        eventLogDays: readPositiveInteger(env, EVENT_LOG_RETENTION_ENV_BINDING),
        taskLogDays: readPositiveInteger(env, TASK_LOG_RETENTION_ENV_BINDING),
        sandboxLogDays: readPositiveInteger(env, TASK_LOG_RETENTION_ENV_BINDING),
        llmLogDays: readPositiveInteger(env, LLM_LOG_RETENTION_ENV_BINDING),
      }),
    }),
    embedding: Object.freeze({
      dimensions: readPositiveInteger(env, EMBEDDING_DIMENSIONS_ENV_BINDING),
    }),
  });
}

function normalizeBotLogsConfig(input: unknown): BotLogsConfigOverlay {
  const logsConfig = asPlainObject(input, "botConfig.logs");
  assertAllowedKeys(logsConfig, ["baseDir", "retention"], "botConfig.logs");

  const retentionValue = logsConfig.retention;
  const normalizedRetention =
    retentionValue === undefined ? undefined : normalizeRetentionOverlay(retentionValue);
  const baseDir =
    logsConfig.baseDir === undefined
      ? undefined
      : normalizeRequiredString(logsConfig.baseDir, "botConfig.logs.baseDir");

  return Object.freeze({
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(normalizedRetention === undefined ? {} : { retention: normalizedRetention }),
  });
}

function normalizeBotEmbeddingConfig(input: unknown): BotEmbeddingConfigOverlay {
  const embeddingConfig = asPlainObject(input, "botConfig.embedding");
  assertAllowedKeys(embeddingConfig, ["dimensions"], "botConfig.embedding");

  if (embeddingConfig.dimensions === undefined) {
    return Object.freeze({});
  }

  return Object.freeze({
    dimensions: normalizePositiveInteger(
      embeddingConfig.dimensions,
      "botConfig.embedding.dimensions",
    ),
  });
}

function normalizeRetentionOverlay(input: unknown): Partial<LogRetentionConfig> | undefined {
  const retention = asPlainObject(input, "botConfig.logs.retention");
  assertAllowedKeys(
    retention,
    ["eventLogDays", "taskLogDays", "sandboxLogDays", "llmLogDays"],
    "botConfig.logs.retention",
  );

  if (Object.keys(retention).length === 0) {
    return undefined;
  }

  return Object.freeze({
    ...(retention.eventLogDays === undefined
      ? {}
      : {
          eventLogDays: normalizePositiveInteger(
            retention.eventLogDays,
            "botConfig.logs.retention.eventLogDays",
          ),
        }),
    ...(retention.taskLogDays === undefined
      ? {}
      : {
          taskLogDays: normalizePositiveInteger(
            retention.taskLogDays,
            "botConfig.logs.retention.taskLogDays",
          ),
        }),
    ...(retention.sandboxLogDays === undefined
      ? {}
      : {
          sandboxLogDays: normalizePositiveInteger(
            retention.sandboxLogDays,
            "botConfig.logs.retention.sandboxLogDays",
          ),
        }),
    ...(retention.llmLogDays === undefined
      ? {}
      : {
          llmLogDays: normalizePositiveInteger(
            retention.llmLogDays,
            "botConfig.logs.retention.llmLogDays",
          ),
        }),
  });
}

function readRequiredString(env: DataConfigEnvironment, binding: ConfigEnvBinding<string>): string {
  const value = readBindingValue(env, binding);

  if (typeof value !== "string") {
    throw new Error(`${binding.envVar} must resolve to a string value`);
  }

  return normalizeRequiredString(value, binding.envVar);
}

function readOptionalString(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding<string | undefined>,
): string | undefined {
  const value = readBindingValue(env, binding);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${binding.envVar} must resolve to a string value`);
  }

  return normalizeRequiredString(value, binding.envVar);
}

function readPositiveInteger(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding<number>,
): number {
  return normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);
}

function readPort(env: DataConfigEnvironment, binding: ConfigEnvBinding<number>): number {
  const port = normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);

  if (port > 65_535) {
    throw new Error(`${binding.envVar} must be a valid TCP port`);
  }

  return port;
}

function readBindingValue(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding,
): string | number | undefined {
  const lookupKeys = [binding.envVar, ...binding.aliases];

  for (const key of lookupKeys) {
    const value = env[key];

    if (value !== undefined) {
      return value;
    }
  }

  return binding.defaultValue;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return normalizedValue;
}

function normalizePositiveInteger(value: unknown, fieldName: string): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value.trim())
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return numericValue;
}

function asPlainObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  fieldName: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unsupported ${fieldName} key: ${key}`);
    }
  }
}
