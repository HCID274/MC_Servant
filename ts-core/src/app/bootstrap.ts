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
import { BotStatus, type RuntimeScaffold, createRuntimeScaffold } from "../runtime/index.js";
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
  /** 运行时骨架。 */
  readonly scaffold: RuntimeScaffold;
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

/** 创建应用装配结果，用于把现有公开契约收口为单进程组合根。 */
export function createAppBootstrapContract<TBotId extends string>(
  input: AppBootstrapInput<TBotId>,
): AppBootstrapContract<TBotId> {
  assertNonEmptyString(input.botId, "botId");
  assertNonEmptyString(input.now, "now");

  const config = createDataConfig({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.botConfig === undefined ? {} : { botConfig: input.botConfig }),
  });
  const lifecycle = createAppLifecyclePlan();
  const runtimeScaffold = createRuntimeScaffold();

  if (runtimeScaffold.defaultStatus !== BotStatus.IDLE) {
    throw new Error("runtime scaffold must start from BotStatus.IDLE");
  }

  return Object.freeze({
    bot_id: input.botId,
    config,
    postgres: createPostgresConnectionDescriptor(config.postgres),
    redis: createRedisKeyCatalog(input.botId),
    workers: createWorkerQueueCatalog(input.botId),
    runtime: Object.freeze({
      initial_status: runtimeScaffold.defaultStatus,
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
