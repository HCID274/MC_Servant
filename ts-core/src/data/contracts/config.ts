import {
  type BotConfigOverlay,
  type BotEmbeddingConfigOverlay,
  type BotLogsConfigOverlay,
  type ConfigEnvBinding,
  DATA_CONFIG_ENV_BINDINGS,
  type DataConfig,
  type DataConfigEnvironment,
  EMBEDDING_DIMENSIONS_ENV_BINDING,
  EVENT_LOG_RETENTION_ENV_BINDING,
  LLM_LOG_RETENTION_ENV_BINDING,
  LOGS_BASE_DIR_ENV_BINDING,
  type LogRetentionConfig,
  PG_DATABASE_ENV_BINDING,
  PG_HOST_ENV_BINDING,
  PG_PASSWORD_ENV_BINDING,
  PG_POOL_MAX_ENV_BINDING,
  PG_POOL_MIN_ENV_BINDING,
  PG_PORT_ENV_BINDING,
  PG_USER_ENV_BINDING,
  REDIS_URL_ENV_BINDING,
  SANDBOX_LOG_RETENTION_ENV_BINDING,
  TASK_LOG_RETENTION_ENV_BINDING,
} from "./config-types.js";

/**
 * 创建基础设施配置（DataConfig）。
 *
 * 配置组合（Configuration Composition）：作为配置加载的组合根，统一环境变量与 Bot 级覆盖。
 *
 * 声明式配置：从环境变量快照和 Bot 配置中加载配置，提供一致的 DataConfig 视图。
 *
 * @param input 包含环境变量和 Bot 级覆盖配置的可选输入
 * @returns 最终生效的 DataConfig
 */
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

/**
 * 解析并校验 Bot 级覆盖配置。
 *
 * 动态配置守门员（Dynamic Config Gatekeeper）：校验非结构化输入并清洗为强类型的覆盖对象。
 *
 * 安全边界：通过白名单机制清洗 Bot 配置，防止非法或未知的 Key 干扰系统关键路径。
 *
 * @param input 原始 Bot 配置对象
 * @returns 经过校验和清洗的覆盖对象
 */
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

/**
 * 将 Bot 级覆盖合并到基础配置。
 *
 * 1. 配置合并策略（Merge Strategy）：实现“环境配置为底，Bot 配置覆盖”的级联合并。
 * 2. 运行时不可变性：确保生成的最终配置（DataConfig）是完全冻结的，防止运行时状态污染。
 * 3. 合并逻辑：例如，日志根目录（baseDir）和各目录的保留期（retention）会优先使用 Overlay 中的值。
 *
 * @param baseConfig 基础配置
 * @param overlay 覆盖配置
 * @returns 合并后的 DataConfig
 */
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
/** 基于环境变量创建基础数据配置。 */

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
        sandboxLogDays: readPositiveInteger(env, SANDBOX_LOG_RETENTION_ENV_BINDING),
        llmLogDays: readPositiveInteger(env, LLM_LOG_RETENTION_ENV_BINDING),
      }),
    }),
    embedding: Object.freeze({
      dimensions: readPositiveInteger(env, EMBEDDING_DIMENSIONS_ENV_BINDING),
    }),
  });
}
/** 归一化机器人日志配置参数。 */

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
/** 归一化机器人向量模型配置参数。 */

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
/** 归一化日志保留时长配置。 */

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
/** 读取必填的字符串环境变量。 */

function readRequiredString(env: DataConfigEnvironment, binding: ConfigEnvBinding<string>): string {
  const value = readBindingValue(env, binding);

  if (typeof value !== "string") {
    throw new Error(`${binding.envVar} must resolve to a string value`);
  }

  return normalizeRequiredString(value, binding.envVar);
}
/** 读取可选的字符串环境变量。 */

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
/** 读取正整数类型的环境变量。 */

function readPositiveInteger(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding<number>,
): number {
  return normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);
}
/** 读取网络端口环境变量。 */

function readPort(env: DataConfigEnvironment, binding: ConfigEnvBinding<number>): number {
  const port = normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);

  if (port > 65_535) {
    throw new Error(`${binding.envVar} must be a valid TCP port`);
  }

  return port;
}
/** 读取环境绑定的泛型值。 */

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
/** 归一化并校验必填字符串。 */

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
/** 归一化并校验正整数。 */

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
/** 将输入值转换为只读对象类型。 */

function asPlainObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}
/** 断言对象是否只包含允许的键名。 */

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
