/**
 * 应用引导与装配层。
 *
 * 架构职责：
 * 1. 组合根（Composition Root）：将各个子系统（数据、数据库、诊断、运行时、沙箱等）的契约装配成一个完整的引导对象。
 * 2. 依赖管理：定义并管理基础设施资源（PostgreSQL, Redis）的生命周期与初始化顺序。
 * 3. 环境适配：负责从环境变量和机器人配置中解析并注入必要的认证、配置等外部依赖。
 * 4. 契约暴露：为上层应用提供统一的引导接口，确保系统各部分在启动前已正确就绪。
 */

import { type DataConfig, type DataConfigEnvironment, createDataConfig } from "../data/index.js";
import {
  type DrizzleMigrationMetadata,
  type PostgresConnectionDescriptor,
  type PostgresRuntimeDependencies,
  type PostgresRuntimeResource,
  type RedisConnectionDescriptor,
  type RedisKeyCatalog,
  type RedisRuntimeDependencies,
  type RedisRuntimeResource,
  createDrizzleMigrationMetadata,
  createPostgresConnectionDescriptor,
  createPostgresRuntimeResource,
  createRedisConnectionDescriptor,
  createRedisKeyCatalog,
  createRedisRuntimeResource,
} from "../db/index.js";
import { createDiagnosticsCatalog } from "../diagnostics/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import {
  API_ROUTE_DEFINITIONS,
  type HealthResponse,
  type InterfaceBotStatusSnapshot,
  type InterfaceServerDependencies,
  type InterfaceServerListenOptions,
  type InterfaceServerRuntime,
  createHealthResponse,
  createInterfaceBotStatusSnapshot,
  createInterfaceServerRuntime,
} from "../interfaces/index.js";
import {
  BotStatus,
  type ExternalAuthActionSummary,
  type ExternalAuthEntrypoint,
  type ExternalAuthPublicState,
  type ExternalAuthSecretBinding,
  type ExternalAuthState,
  type RuntimeReadyGate,
  type RuntimeScaffold,
  createExternalAuthPublicState,
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
import {
  type WorkerBullmqDependencies,
  type WorkerBullmqRuntime,
  type WorkerQueueCatalog,
  createWorkerBullmqRuntime,
  createWorkerQueueCatalog,
} from "../workers/index.js";
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
  readonly external_auth: ExternalAuthPublicState;
  /** 运行时骨架公开视图。 */
  readonly scaffold: AppRuntimeScaffoldContract;
  /** 初始 ready（就绪） 门控结果。 */
  readonly ready_gate: RuntimeReadyGate;
}

/** 应用装配层暴露的外部认证计划公开视图。 */
export type AppExternalAuthPlanContract =
  | {
      /** 对应的认证状态。 */
      readonly status: "not_required";
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: true;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "pending";
      /** 对外脱敏摘要。 */
      readonly action_summary: ExternalAuthActionSummary;
      /** 是否允许重试。 */
      readonly retry_allowed: true;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: false;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "authenticated";
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: true;
    }
  | {
      /** 对应的认证状态。 */
      readonly status: "failed";
      /** 对外脱敏摘要。 */
      readonly action_summary: null;
      /** 是否允许重试。 */
      readonly retry_allowed: false;
      /** 是否已满足认证前置。 */
      readonly ready_for_idle: false;
      /** 失败原因。 */
      readonly failure_reason: "missing_injected_secret";
      /** 期望的密钥来源。 */
      readonly secret_source: "env" | "bot_config" | null;
      /** 期望的密钥引用。 */
      readonly secret_reference: string | null;
    };

/** 应用装配层暴露的运行时骨架公开视图。 */
export interface AppRuntimeScaffoldContract {
  /** 默认启动状态。 */
  readonly defaultStatus: RuntimeScaffold["defaultStatus"];
  /** 外部认证状态公开视图。 */
  readonly externalAuth: ExternalAuthPublicState;
  /** 外部认证执行计划公开视图。 */
  readonly externalAuthPlan: AppExternalAuthPlanContract;
  /** 初始就绪门控结果。 */
  readonly readyGate: RuntimeScaffold["readyGate"];
  /** 当前阶段声明支持的执行任务类型。 */
  readonly supportedTaskKinds: RuntimeScaffold["supportedTaskKinds"];
  /** 当前阶段提供的中断信号模板。 */
  readonly interruptTemplate: RuntimeScaffold["interruptTemplate"];
}

/** 应用装配层暴露的外部认证结果。 */
export interface AppExternalAuthContract {
  /** 对外暴露的脱敏认证状态。 */
  readonly state: ExternalAuthPublicState;
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

/** 基础设施真实 I/O（输入输出） 资源名称清单。 */
export const APP_RUNTIME_RESOURCE_NAMES = ["postgres", "redis"] as const;

/** 真实 I/O（输入输出） 资源名称联合类型。 */
export type AppRuntimeResourceName = (typeof APP_RUNTIME_RESOURCE_NAMES)[number];

/** 应用装配层暴露的真实资源目录。 */
export interface AppResourceDirectory<TBotId extends string = string> {
  /** 创建顺序。 */
  readonly create_order: readonly AppRuntimeResourceName[];
  /** 关闭顺序。 */
  readonly close_order: readonly AppRuntimeResourceName[];
  /** 失败回滚顺序，按“已创建资源的逆序”生效。 */
  readonly cleanup_on_failure: readonly AppRuntimeResourceName[];
  /** PostgreSQL（关系型数据库） 资源目录。 */
  readonly postgres: {
    /** 连接描述符。 */
    readonly descriptor: PostgresConnectionDescriptor;
    /** 迁移入口元信息。 */
    readonly migrations: DrizzleMigrationMetadata;
  };
  /** Redis（缓存） 资源目录。 */
  readonly redis: {
    /** 连接描述符。 */
    readonly descriptor: RedisConnectionDescriptor;
    /** 键目录。 */
    readonly keys: RedisKeyCatalog<TBotId>;
    /** 与后续 BullMQ（任务队列） 复用的意图说明。 */
    readonly reuse_for: "bullmq_shared_connection";
  };
}

/** 应用装配层创建出的真实资源句柄。 */
export interface AppRuntimeResources<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 资源目录快照。 */
  readonly directory: AppResourceDirectory<TBotId>;
  /** PostgreSQL（关系型数据库） 运行时资源。 */
  readonly postgres: PostgresRuntimeResource;
  /** Redis（缓存） 运行时资源。 */
  readonly redis: RedisRuntimeResource;
  /** 按约定顺序关闭已创建资源。 */
  close(): Promise<void>;
}

/** 真实资源工厂的可注入依赖。 */
export interface AppRuntimeResourceDependencies {
  /** PostgreSQL（关系型数据库） 工厂注入。 */
  readonly postgres?: PostgresRuntimeDependencies;
  /** Redis（缓存） 工厂注入。 */
  readonly redis?: RedisRuntimeDependencies;
}

/** 服务层真实资源名称清单。 */
export const APP_SERVICE_RESOURCE_NAMES = ["workers", "http"] as const;

/** 服务层真实资源名称联合类型。 */
export type AppServiceResourceName = (typeof APP_SERVICE_RESOURCE_NAMES)[number];

/** 应用装配层暴露的服务资源目录。 */
export interface AppServiceDirectory<TBotId extends string = string> {
  /** 创建顺序。 */
  readonly create_order: readonly AppServiceResourceName[];
  /** 关闭顺序。 */
  readonly close_order: readonly AppServiceResourceName[];
  /** 失败回滚顺序。 */
  readonly cleanup_on_failure: readonly AppServiceResourceName[];
  /** BullMQ（任务队列） 三队列资源目录。 */
  readonly workers: {
    /** 三队列目录。 */
    readonly catalog: WorkerQueueCatalog<TBotId>;
    /** 共享 Redis（缓存） 客户端复用说明。 */
    readonly redis_reuse: "shared_client";
  };
  /** Fastify（接口网关） 资源目录。 */
  readonly http: {
    /** 最小路由目录。 */
    readonly routes: typeof API_ROUTE_DEFINITIONS;
    /** 默认监听参数。 */
    readonly listen: InterfaceServerListenOptions;
  };
}

/** 服务层真实资源工厂依赖。 */
export interface AppRuntimeServiceDependencies {
  /** BullMQ（任务队列） 依赖注入。 */
  readonly workers?: WorkerBullmqDependencies;
  /** Fastify（接口网关） 依赖注入。 */
  readonly http?: InterfaceServerDependencies;
}

/** 应用装配层创建出的服务运行时句柄。 */
export interface AppRuntimeServices<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 基础设施资源句柄。 */
  readonly infrastructure: AppRuntimeResources<TBotId>;
  /** 服务资源目录。 */
  readonly directory: AppServiceDirectory<TBotId>;
  /** BullMQ（任务队列） 三队列运行时句柄。 */
  readonly workers: WorkerBullmqRuntime<TBotId>;
  /** Fastify（接口网关） 运行时句柄。 */
  readonly http: InterfaceServerRuntime<TBotId>;
  /** 按约定顺序关闭服务层资源。 */
  close(): Promise<void>;
}

/** 应用进程组合资源。 */
export interface AppProcessRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 基础设施资源句柄。 */
  readonly infrastructure: AppRuntimeResources<TBotId>;
  /** 服务层资源句柄。 */
  readonly services: AppRuntimeServices<TBotId>;
  /** 关闭完整进程资源。 */
  close(): Promise<void>;
}

/** 应用进程组合资源工厂依赖。 */
export interface AppProcessRuntimeDependencies {
  /** 基础设施资源依赖。 */
  readonly infrastructure?: AppRuntimeResourceDependencies;
  /** 服务层资源依赖。 */
  readonly services?: AppRuntimeServiceDependencies;
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
  /** 真实资源目录。 */
  readonly resources: AppResourceDirectory<TBotId>;
  /** 服务层资源目录。 */
  readonly services: AppServiceDirectory<TBotId>;
  /** 启动 / 关闭生命周期计划。 */
  readonly lifecycle: AppLifecyclePlan;
  /** 子系统依赖与就绪目录。 */
  readonly readiness: readonly AppReadinessDescriptor[];
}

/** 创建应用装配层的外部认证结果。 */
export function createAppExternalAuthContract(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): AppExternalAuthContract {
  const runtimeState = resolveAppExternalAuthResolution(input).state;

  return createAppExternalAuthContractFromRuntimeState(runtimeState);
}

/**
 * 创建应用装配结果，用于把现有公开契约收口为单进程组合根。
 *
 * 架构设计：
 * 该函数是整个应用的“大脑装配点”，它负责：
 * 1. 验证基础输入的合法性（Bot ID, 时间戳）。
 * 2. 依次初始化配置、生命周期计划、数据库描述、运行时骨架和诊断目录。
 * 3. 将分散的子系统对象聚合成一个不可变的 AppBootstrapContract，供启动流程使用。
 *
 * @param input 应用引导输入
 * @returns 完整的引导契约对象
 */
export function createAppBootstrapContract<TBotId extends string>(
  input: AppBootstrapInput<TBotId>,
): AppBootstrapContract<TBotId> {
  assertNonEmptyString(input.botId, "botId");
  assertNonEmptyString(input.now, "now");

  const runtimeExternalAuthResolution = resolveAppExternalAuthResolution({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.botConfig === undefined ? {} : { botConfig: input.botConfig }),
  });
  const externalAuth = createAppExternalAuthContractFromRuntimeState(
    runtimeExternalAuthResolution.state,
  );
  const config = createDataConfig({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.botConfig === undefined ? {} : { botConfig: selectDataBotConfig(input.botConfig) }),
  });
  const lifecycle = createAppLifecyclePlan();
  const postgres = createPostgresConnectionDescriptor(config.postgres);
  const redisKeys = createRedisKeyCatalog(input.botId);
  const redisConnection = createRedisConnectionDescriptor(config.redis);
  const migrations = createDrizzleMigrationMetadata({ postgres });
  const workersCatalog = createWorkerQueueCatalog(input.botId);
  const runtimeScaffold = createRuntimeScaffold({
    externalAuth: runtimeExternalAuthResolution.state,
    ...(runtimeExternalAuthResolution.secret === undefined
      ? {}
      : { externalAuthSecret: runtimeExternalAuthResolution.secret }),
  });

  if (runtimeScaffold.defaultStatus !== BotStatus.INITIALIZING) {
    throw new Error("runtime scaffold must start from BotStatus.INITIALIZING");
  }

  return Object.freeze({
    bot_id: input.botId,
    config,
    auth: externalAuth,
    postgres,
    redis: redisKeys,
    workers: workersCatalog,
    runtime: Object.freeze({
      initial_status: runtimeScaffold.defaultStatus,
      external_auth: externalAuth.state,
      scaffold: createAppRuntimeScaffoldContract(runtimeScaffold),
      ready_gate: runtimeScaffold.readyGate,
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
    migrations,
    resources: createAppResourceDirectory({
      postgres,
      migrations,
      redisKeys,
      redisConnection,
    }),
    services: createAppServiceDirectory({
      workers: workersCatalog,
      httpListen: createAppHttpListenOptions(),
    }),
    lifecycle,
    readiness: createAppReadinessCatalog(),
  });
}

/**
 * 基于应用装配结果创建真实 PostgreSQL（关系型数据库） / Redis（缓存） 资源。
 *
 * 架构设计：
 * 该函数负责物理资源的实例化，包括：
 * 1. 按照 create_order 指定的顺序（通常是 Postgres -> Redis）建立连接。
 * 2. 封装资源关闭逻辑，确保在发生故障或系统停机时能正确回收资源。
 * 3. 提供异常回滚机制，若中间某个资源创建失败，会尝试逆序清理已创建的资源。
 *
 * @param bootstrap 引导契约
 * @param dependencies 可注入的资源依赖（用于 Mock 或自定义连接）
 * @returns 运行时资源句柄
 */
export async function createAppRuntimeResources<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppRuntimeResourceDependencies = {},
): Promise<AppRuntimeResources<TBotId>> {
  const created: Partial<{
    postgres: PostgresRuntimeResource;
    redis: RedisRuntimeResource;
  }> = {};

  try {
    created.postgres = await createPostgresRuntimeResource(
      bootstrap.resources.postgres.descriptor,
      dependencies.postgres,
    );
    created.redis = await createRedisRuntimeResource(
      bootstrap.resources.redis.descriptor,
      dependencies.redis,
    );
    const postgres = created.postgres;
    const redis = created.redis;

    if (postgres === undefined || redis === undefined) {
      throw new Error("app runtime resources require postgres and redis");
    }

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      directory: bootstrap.resources,
      postgres,
      redis,
      async close(): Promise<void> {
        await closeAppRuntimeResources({
          directory: bootstrap.resources,
          postgres,
          redis,
        });
      },
    });
  } catch (error) {
    await closeAppRuntimeResources({
      directory: bootstrap.resources,
      ...(created.postgres === undefined ? {} : { postgres: created.postgres }),
      ...(created.redis === undefined ? {} : { redis: created.redis }),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 按应用约定顺序关闭真实资源；即使前一步失败也会继续清理后续资源。
 *
 * 架构设计：
 * 遵循 close_order（通常与创建顺序相反），采用“尽力而为”的清理策略，
 * 捕获并汇总所有关闭过程中的错误，确保基础设施连接被安全释放。
 *
 * @param input 包含资源实例和目录信息的输入
 */
export async function closeAppRuntimeResources<TBotId extends string>(input: {
  directory: AppResourceDirectory<TBotId>;
  postgres?: PostgresRuntimeResource;
  redis?: RedisRuntimeResource;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const resourceName of input.directory.close_order) {
    try {
      if (resourceName === "redis" && input.redis !== undefined) {
        await input.redis.close();
      }

      if (resourceName === "postgres" && input.postgres !== undefined) {
        await input.postgres.close();
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length === 0) {
    return;
  }

  throw closeErrors[0];
}

/**
 * 创建服务层运行时资源。
 *
 * @param bootstrap 引导契约
 * @param infrastructure 已创建的基础设施资源
 * @param dependencies 可注入的服务层依赖
 * @returns BullMQ（任务队列） 与 Fastify（接口网关） 组合运行时
 */
export async function createAppRuntimeServices<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  infrastructure: AppRuntimeResources<TBotId>,
  dependencies: AppRuntimeServiceDependencies = {},
): Promise<AppRuntimeServices<TBotId>> {
  const created: Partial<{
    workers: WorkerBullmqRuntime<TBotId>;
    http: InterfaceServerRuntime<TBotId>;
  }> = {};

  try {
    created.workers = createWorkerBullmqRuntime(
      {
        botId: bootstrap.bot_id,
        redis: infrastructure.redis,
      },
      dependencies.workers,
    );
    created.http = createInterfaceServerRuntime(
      {
        bot_id: bootstrap.bot_id,
        health: bootstrap.interfaces.health,
        default_status: createAppDefaultInterfaceStatusSnapshot(bootstrap),
        listen: bootstrap.services.http.listen,
      },
      dependencies.http,
    );
    const workers = created.workers;
    const http = created.http;

    if (workers === undefined || http === undefined) {
      throw new Error("app runtime services require workers and http");
    }

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      infrastructure,
      directory: bootstrap.services,
      workers,
      http,
      async close(): Promise<void> {
        await closeAppRuntimeServices({
          directory: bootstrap.services,
          workers,
          http,
        });
      },
    });
  } catch (error) {
    await closeAppRuntimeServices({
      directory: bootstrap.services,
      ...(created.workers === undefined ? {} : { workers: created.workers }),
      ...(created.http === undefined ? {} : { http: created.http }),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * 按服务层约定顺序关闭 Fastify（接口网关） 与 BullMQ（任务队列）。
 *
 * @param input 服务资源与目录信息
 */
export async function closeAppRuntimeServices<TBotId extends string>(input: {
  directory: AppServiceDirectory<TBotId>;
  workers?: WorkerBullmqRuntime<TBotId>;
  http?: InterfaceServerRuntime<TBotId>;
}): Promise<void> {
  const closeErrors: unknown[] = [];

  for (const resourceName of input.directory.close_order) {
    try {
      if (resourceName === "http" && input.http !== undefined) {
        await input.http.close();
      }

      if (resourceName === "workers" && input.workers !== undefined) {
        await input.workers.close();
      }
    } catch (error) {
      closeErrors.push(error);
    }
  }

  if (closeErrors.length > 0) {
    throw closeErrors[0];
  }
}

/**
 * 创建完整应用进程资源。
 *
 * @param bootstrap 引导契约
 * @param dependencies 基础设施与服务层依赖
 * @returns 可统一关闭的完整进程资源
 */
export async function createAppProcessRuntime<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  dependencies: AppProcessRuntimeDependencies = {},
): Promise<AppProcessRuntime<TBotId>> {
  let infrastructure: AppRuntimeResources<TBotId> | undefined;
  let services: AppRuntimeServices<TBotId> | undefined;

  try {
    infrastructure = await createAppRuntimeResources(bootstrap, dependencies.infrastructure);
    services = await createAppRuntimeServices(bootstrap, infrastructure, dependencies.services);
    const createdInfrastructure = infrastructure;
    const createdServices = services;

    return Object.freeze({
      bot_id: bootstrap.bot_id,
      infrastructure: createdInfrastructure,
      services: createdServices,
      async close(): Promise<void> {
        const closeErrors: unknown[] = [];

        try {
          await createdServices.close();
        } catch (error) {
          closeErrors.push(error);
        }

        try {
          await createdInfrastructure.close();
        } catch (error) {
          closeErrors.push(error);
        }

        if (closeErrors.length > 0) {
          throw closeErrors[0];
        }
      },
    });
  } catch (error) {
    if (services !== undefined) {
      await services.close().catch(() => undefined);
    }

    if (infrastructure !== undefined) {
      await infrastructure.close().catch(() => undefined);
    }

    throw error;
  }
}

/**
 * 解析应用外部认证决策。
 *
 * 架构意图：
 * 1. 策略分发：根据环境变量或 Bot 配置判断是否需要认证。
 * 2. 秘密绑定：尝试从环境变量或配置中解析并绑定明文密钥。
 * 3. 失败预测：若配置要求认证但未找到有效密钥，立即宣告状态为失败，避免进入后续复杂的认证流程。
 */
function resolveAppExternalAuthResolution(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): {
  readonly state: ExternalAuthState;
  readonly secret?: ExternalAuthSecretBinding;
} {
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
    });
  }

  if (entrypoint !== "game_chat_command") {
    throw new Error("external auth entrypoint must be game_chat_command");
  }

  return Object.freeze({
    state: createExternalAuthState({
      status: "pending",
      secret: secretBinding,
    }),
    secret: secretBinding,
  });
}

function createAppExternalAuthContractFromRuntimeState(
  runtimeState: ExternalAuthState,
): AppExternalAuthContract {
  return Object.freeze({
    state: createExternalAuthPublicState(runtimeState),
    entrypoint: runtimeState.entrypoint,
    secret_injected: runtimeState.status === "pending" || runtimeState.status === "authenticated",
  });
}

function createAppRuntimeScaffoldContract(scaffold: RuntimeScaffold): AppRuntimeScaffoldContract {
  return Object.freeze({
    defaultStatus: scaffold.defaultStatus,
    externalAuth: createExternalAuthPublicState(scaffold.externalAuth),
    externalAuthPlan: createAppExternalAuthPlanContract(scaffold.externalAuthPlan),
    readyGate: scaffold.readyGate,
    supportedTaskKinds: scaffold.supportedTaskKinds,
    interruptTemplate: scaffold.interruptTemplate,
  });
}

/**
 * 创建应用资源目录。
 *
 * 架构意图：
 * 1. 声明式时序：显式定义资源的创建、关闭和回滚顺序。
 * 2. 映射关系：将抽象的资源名（如 'postgres'）与具体的描述符和元信息关联。
 *
 * @param input 包含连接描述符和元信息的输入
 */
function createAppResourceDirectory<TBotId extends string>(input: {
  postgres: PostgresConnectionDescriptor;
  migrations: DrizzleMigrationMetadata;
  redisKeys: RedisKeyCatalog<TBotId>;
  redisConnection: RedisConnectionDescriptor;
}): AppResourceDirectory<TBotId> {
  return Object.freeze({
    create_order: Object.freeze(["postgres", "redis"] as const),
    close_order: Object.freeze(["redis", "postgres"] as const),
    cleanup_on_failure: Object.freeze(["redis", "postgres"] as const),
    postgres: Object.freeze({
      descriptor: input.postgres,
      migrations: input.migrations,
    }),
    redis: Object.freeze({
      descriptor: input.redisConnection,
      keys: input.redisKeys,
      reuse_for: "bullmq_shared_connection",
    }),
  });
}

function createAppHttpListenOptions(): InterfaceServerListenOptions {
  return Object.freeze({
    host: "0.0.0.0",
    port: 3000,
  });
}

function createAppServiceDirectory<TBotId extends string>(input: {
  workers: WorkerQueueCatalog<TBotId>;
  httpListen: InterfaceServerListenOptions;
}): AppServiceDirectory<TBotId> {
  return Object.freeze({
    create_order: Object.freeze(["workers", "http"] as const),
    close_order: Object.freeze(["http", "workers"] as const),
    cleanup_on_failure: Object.freeze(["http", "workers"] as const),
    workers: Object.freeze({
      catalog: input.workers,
      redis_reuse: "shared_client",
    }),
    http: Object.freeze({
      routes: API_ROUTE_DEFINITIONS,
      listen: input.httpListen,
    }),
  });
}

function createAppDefaultInterfaceStatusSnapshot<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
): InterfaceBotStatusSnapshot {
  return createInterfaceBotStatusSnapshot({
    bot_id: bootstrap.bot_id,
    status: bootstrap.runtime.initial_status,
    intent_epoch: 0,
    last_event_seq: 0,
    updated_at: bootstrap.interfaces.health.timestamp,
  });
}

function createAppExternalAuthPlanContract(
  plan: RuntimeScaffold["externalAuthPlan"],
): AppExternalAuthPlanContract {
  switch (plan.status) {
    case "not_required":
      return Object.freeze({
        status: "not_required",
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: true,
      });
    case "pending":
      return Object.freeze({
        status: "pending",
        action_summary: plan.action_summary,
        retry_allowed: true,
        ready_for_idle: false,
      });
    case "authenticated":
      return Object.freeze({
        status: "authenticated",
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: true,
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        action_summary: null,
        retry_allowed: false,
        ready_for_idle: false,
        failure_reason: plan.failure_reason,
        secret_source: plan.secret_source,
        secret_reference: plan.secret_reference,
      });
  }
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
