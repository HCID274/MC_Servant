import { type DataConfig, type DataConfigEnvironment, createDataConfig } from "../data/index.js";
import {
  type DrizzleMigrationMetadata,
  type PostgresConnectionDescriptor,
  type RedisKeyCatalog,
  createDrizzleMigrationMetadata,
  createPostgresConnectionDescriptor,
  createRedisKeyCatalog,
} from "../db/index.js";
import { createDiagnosticsCatalog } from "../diagnostics/index.js";
import {
  API_ROUTE_DEFINITIONS,
  type HealthResponse,
  createHealthResponse,
} from "../interfaces/index.js";
import {
  BotStatus,
  type ExternalAuthEntrypoint,
  type ExternalAuthSecretBinding,
  type ExternalAuthState,
  type RuntimeScaffold,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createRuntimeScaffold,
} from "../runtime/index.js";
import {
  type SandboxExecutionResourceLimits,
  type SandboxFacadeContract,
  createSandboxFacadeContract,
  createSandboxResourceLimits,
} from "../sandbox/index.js";
import { type WorkerQueueCatalog, createWorkerQueueCatalog } from "../workers/index.js";
import {
  type AppLifecyclePlan,
  type AppReadinessDescriptor,
  createAppLifecyclePlan,
  createAppReadinessCatalog,
} from "./contracts.js";

/** 接口层装配结果，用于统一收口纯路由目录与健康检查基线。 */
export interface AppInterfacesContract {
  /** 纯路由定义目录。 */
  readonly routes: typeof API_ROUTE_DEFINITIONS;
  /** 健康检查输出基线。 */
  readonly health: HealthResponse;
}

/** 运行时装配结果，用于声明单 Bot（机器人） 的初始执行状态。 */
export interface AppRuntimeContract {
  /** 初始状态。 */
  readonly initial_status: BotStatus;
  /** 外部认证状态。 */
  readonly external_auth: ExternalAuthState;
  /** 运行时骨架。 */
  readonly scaffold: RuntimeScaffold;
}

/** 应用装配层暴露的外部认证结果。 */
export interface AppExternalAuthContract {
  /** 运行时可消费的统一认证状态。 */
  readonly state: ExternalAuthState;
  /** 当前受控入口。 */
  readonly entrypoint: ExternalAuthEntrypoint;
  /** 明文密钥是否已完成部署注入。 */
  readonly secret_injected: boolean;
}

/** 沙箱装配结果，用于声明无真实隔离实例时的可用契约。 */
export interface AppSandboxContract {
  /** Facade API（门面接口） 契约。 */
  readonly facade: SandboxFacadeContract;
  /** 默认资源限制。 */
  readonly resource_limits: Readonly<SandboxExecutionResourceLimits>;
}

/** 诊断装配结果，用于暴露 JSONL（结构化日志） 通道目录。 */
export interface AppDiagnosticsContract {
  /** 通道目录。 */
  readonly catalog: ReturnType<typeof createDiagnosticsCatalog>;
}

/** 应用装配输入，用于从纯配置构建单进程组合根。 */
export interface AppBootstrapInput<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly botId: TBotId;
  /** 生成健康检查基线时使用的时间戳。 */
  readonly now: string;
  /** 可选环境变量快照。 */
  readonly env?: DataConfigEnvironment;
  /** 可选 Bot 级覆盖配置。 */
  readonly botConfig?: unknown;
}

/** 应用装配结果，用于统一暴露 Phase 1（第一阶段） 的纯组合根。 */
export interface AppBootstrapContract<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 数据与基础设施配置。 */
  readonly config: DataConfig;
  /** 外部认证装配结果。 */
  readonly auth: AppExternalAuthContract;
  /** PostgreSQL（关系型数据库） 连接描述。 */
  readonly postgres: PostgresConnectionDescriptor;
  /** Redis（缓存） 键目录。 */
  readonly redis: RedisKeyCatalog<TBotId>;
  /** 三队列目录。 */
  readonly workers: WorkerQueueCatalog<TBotId>;
  /** 运行时装配结果。 */
  readonly runtime: AppRuntimeContract;
  /** 接口层装配结果。 */
  readonly interfaces: AppInterfacesContract;
  /** 沙箱装配结果。 */
  readonly sandbox: AppSandboxContract;
  /** 诊断装配结果。 */
  readonly diagnostics: AppDiagnosticsContract;
  /** Drizzle migration（迁移） 元信息。 */
  readonly migrations: DrizzleMigrationMetadata;
  /** 启动 / 关闭生命周期计划。 */
  readonly lifecycle: AppLifecyclePlan;
  /** 子系统依赖与就绪目录。 */
  readonly readiness: readonly AppReadinessDescriptor[];
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

/** 创建应用装配层的外部认证结果。 */
export function createAppExternalAuthContract(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): AppExternalAuthContract {
  const env = input.env ?? {};
  const botConfig = asOptionalPlainObject(input.botConfig, "botConfig");
  const authConfig = asOptionalPlainObject(botConfig?.auth, "botConfig.auth");
  const authRequired =
    readOptionalBoolean(env, "MC_EXTERNAL_AUTH_REQUIRED") ??
    readOptionalBooleanField(authConfig?.required, "botConfig.auth.required") ??
    false;

  if (!authRequired) {
    return Object.freeze({
      state: createExternalAuthState({ status: "not_required" }),
      entrypoint: "none",
      secret_injected: false,
    });
  }

  const entrypoint = resolveRequiredAuthEntrypoint(env, authConfig);
  const secretBinding = resolveExternalAuthSecretBinding(env, authConfig);

  if (secretBinding === undefined) {
    return Object.freeze({
      state: createExternalAuthState({
        status: "failed",
        failureReason: "missing_injected_secret",
        secretSource: inferSecretSource(authConfig),
        secretReference: inferSecretReference(authConfig),
      }),
      entrypoint,
      secret_injected: false,
    });
  }

  return Object.freeze({
    state: createExternalAuthState({
      status: "pending",
      secret: secretBinding,
    }),
    entrypoint,
    secret_injected: true,
  });
}

/** 创建应用装配结果，用于把现有公开契约收口为单进程组合根。 */
export function createAppBootstrapContract<TBotId extends string>(
  input: AppBootstrapInput<TBotId>,
): AppBootstrapContract<TBotId> {
  assertNonEmptyString(input.botId, "botId");
  assertNonEmptyString(input.now, "now");

  const externalAuth = createAppExternalAuthContract({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.botConfig === undefined ? {} : { botConfig: input.botConfig }),
  });
  const config = createDataConfig({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.botConfig === undefined ? {} : { botConfig: selectDataBotConfig(input.botConfig) }),
  });
  const lifecycle = createAppLifecyclePlan();
  const runtimeScaffold = createRuntimeScaffold({
    externalAuth: externalAuth.state,
  });

  if (runtimeScaffold.defaultStatus !== BotStatus.INITIALIZING) {
    throw new Error("runtime scaffold must start from BotStatus.INITIALIZING");
  }

  return Object.freeze({
    bot_id: input.botId,
    config,
    auth: externalAuth,
    postgres: createPostgresConnectionDescriptor(config.postgres),
    redis: createRedisKeyCatalog(input.botId),
    workers: createWorkerQueueCatalog(input.botId),
    runtime: Object.freeze({
      initial_status: runtimeScaffold.defaultStatus,
      external_auth: externalAuth.state,
      scaffold: runtimeScaffold,
    }),
    interfaces: Object.freeze({
      routes: API_ROUTE_DEFINITIONS,
      health: createHealthResponse(input.now),
    }),
    sandbox: Object.freeze({
      facade: createSandboxFacadeContract(),
      resource_limits: createSandboxResourceLimits(),
    }),
    diagnostics: Object.freeze({
      catalog: createDiagnosticsCatalog(),
    }),
    migrations: createDrizzleMigrationMetadata(),
    lifecycle,
    readiness: createAppReadinessCatalog(),
  });
}

function selectDataBotConfig(input: unknown): unknown {
  const botConfig = asOptionalPlainObject(input, "botConfig");

  if (botConfig === undefined) {
    return undefined;
  }

  const dataBotConfig: Record<string, unknown> = {};

  if (botConfig.logs !== undefined) {
    dataBotConfig.logs = botConfig.logs;
  }

  if (botConfig.embedding !== undefined) {
    dataBotConfig.embedding = botConfig.embedding;
  }

  return Object.keys(dataBotConfig).length === 0 ? undefined : dataBotConfig;
}

function resolveRequiredAuthEntrypoint(
  env: DataConfigEnvironment,
  authConfig: Readonly<Record<string, unknown>> | undefined,
): "game_chat_command" {
  const entrypointValue =
    readOptionalString(env, "MC_EXTERNAL_AUTH_ENTRYPOINT") ??
    readOptionalStringField(authConfig?.entrypoint, "botConfig.auth.entrypoint") ??
    "game_chat_command";

  if (entrypointValue !== "game_chat_command") {
    throw new Error("external auth entrypoint must be game_chat_command");
  }

  return entrypointValue;
}

function resolveExternalAuthSecretBinding(
  env: DataConfigEnvironment,
  authConfig: Readonly<Record<string, unknown>> | undefined,
): ExternalAuthSecretBinding | undefined {
  const directEnvSecret = readOptionalString(env, "MC_EXTERNAL_AUTH_SECRET");

  if (directEnvSecret !== undefined) {
    return createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: directEnvSecret,
    });
  }

  const secretEnvVar =
    readOptionalStringField(authConfig?.secretEnvVar, "botConfig.auth.secretEnvVar") ?? undefined;

  if (secretEnvVar !== undefined) {
    const envSecret = readOptionalString(env, secretEnvVar);

    if (envSecret !== undefined) {
      return createExternalAuthSecretBinding({
        source: "env",
        reference: secretEnvVar,
        secret: envSecret,
      });
    }
  }

  const botConfigSecret =
    readOptionalStringField(authConfig?.secret, "botConfig.auth.secret") ?? undefined;

  if (botConfigSecret !== undefined) {
    return createExternalAuthSecretBinding({
      source: "bot_config",
      reference: "botConfig.auth.secret",
      secret: botConfigSecret,
    });
  }

  return undefined;
}

function inferSecretSource(
  authConfig: Readonly<Record<string, unknown>> | undefined,
): "env" | "bot_config" | null {
  if (authConfig?.secretEnvVar !== undefined) {
    return "env";
  }

  if (authConfig?.secret !== undefined) {
    return "bot_config";
  }

  return "env";
}

function inferSecretReference(
  authConfig: Readonly<Record<string, unknown>> | undefined,
): string | null {
  const secretEnvVar =
    readOptionalStringField(authConfig?.secretEnvVar, "botConfig.auth.secretEnvVar") ?? undefined;

  if (secretEnvVar !== undefined) {
    return secretEnvVar;
  }

  if (authConfig?.secret !== undefined) {
    return "botConfig.auth.secret";
  }

  return "MC_EXTERNAL_AUTH_SECRET";
}

function asOptionalPlainObject(
  value: unknown,
  fieldName: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function readOptionalBoolean(env: DataConfigEnvironment, fieldName: string): boolean | undefined {
  const value = env[fieldName];

  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${fieldName} must be a boolean string`);
}

function readOptionalBooleanField(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

function readOptionalString(env: DataConfigEnvironment, fieldName: string): string | undefined {
  const value = env[fieldName];

  if (value === undefined) {
    return undefined;
  }

  assertNonEmptyString(value, fieldName);

  return value.trim();
}

function readOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  assertNonEmptyString(value, fieldName);

  return value.trim();
}
