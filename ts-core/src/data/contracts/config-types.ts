import { DEFAULT_LOGS_BASE_DIR, EVENT_LOG_RETENTION_DAYS, JSONL_RETENTION_DAYS } from "../logs.js";
import { DEFAULT_EMBEDDING_DIMENSIONS } from "./tables.js";

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

/** `SANDBOX_LOG_RETENTION_DAYS` 配置绑定。 */
export const SANDBOX_LOG_RETENTION_ENV_BINDING = {
  envVar: "SANDBOX_LOG_RETENTION_DAYS",
  aliases: ["SANDBOX_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.sandbox,
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
  sandboxLogRetentionDays: SANDBOX_LOG_RETENTION_ENV_BINDING,
  llmLogRetentionDays: LLM_LOG_RETENTION_ENV_BINDING,
  embeddingDimensions: EMBEDDING_DIMENSIONS_ENV_BINDING,
});

/** 可注入的环境变量快照。 */
export type DataConfigEnvironment = Readonly<Record<string, string | undefined>>;
