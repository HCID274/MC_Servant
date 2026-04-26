import type { DataConfigEnvironment } from "../../data/index.js";
import type {
  DrizzleMigrationMetadata,
  PostgresConnectionDescriptor,
  RedisConnectionDescriptor,
  RedisKeyCatalog,
} from "../../db/index.js";
import type { LlmDiagnosticSummary } from "../../diagnostics/index.js";
import {
  API_ROUTE_DEFINITIONS,
  type InterfaceBotStatusSnapshot,
  type InterfaceServerListenOptions,
  createInterfaceBotStatusSnapshot,
} from "../../interfaces/index.js";
import {
  BotStatus,
  createExternalAuthPublicState,
  createMineflayerTransportDescriptor,
} from "../../runtime/index.js";
import type { RuntimeScaffold } from "../../runtime/index.js";
import type { WorkerQueueCatalog } from "../../workers/index.js";
import { readOptionalInteger, readOptionalString } from "./env.js";
import type {
  AppBootstrapContract,
  AppExternalAuthPlanContract,
  AppLlmContract,
  AppResourceDirectory,
  AppRuntimeCoreDirectory,
  AppRuntimeCoreResources,
  AppRuntimeScaffoldContract,
  AppServiceDirectory,
} from "./types.js";

/**
 * 创建应用层使用的运行时骨架契约。
 *
 * 视图脱敏：将底层的 RuntimeScaffold 投影为应用层可见的 Contract 对象，隐藏不必要的实现细节。
 */
export function createAppRuntimeScaffoldContract(
  scaffold: RuntimeScaffold,
): AppRuntimeScaffoldContract {
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
 * 1. 声明式时序：显式定义资源的创建、关闭和回滚顺序。
 * 2. 映射关系：将抽象的资源名（如 'postgres'）与具体的描述符和元信息关联。
 *
 * @param input 包含连接描述符和元信息的输入
 */
export function createAppResourceDirectory<TBotId extends string>(input: {
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

/**
 * 创建运行时核心资源目录。
 *
 * 1. 资源定义：显式配置观测模式（事件驱动缓存）和 Mineflayer 连接参数。
 * 2. 顺序管理：定义核心资源（观测、传输、代理）的生命周期拓扑顺序。
 */
export function createAppRuntimeCoreDirectory<TBotId extends string>(input: {
  botId: TBotId;
  runtimeScaffold: RuntimeScaffold;
  env: DataConfigEnvironment;
}): AppRuntimeCoreDirectory<TBotId> {
  return Object.freeze({
    create_order: Object.freeze(["observation", "mineflayer_transport", "bot_actor"] as const),
    close_order: Object.freeze(["bot_actor", "mineflayer_transport", "observation"] as const),
    cleanup_on_failure: Object.freeze([
      "bot_actor",
      "mineflayer_transport",
      "observation",
    ] as const),
    observation: Object.freeze({
      mode: "event_driven_cache",
      source: "mineflayer_events",
    }),
    mineflayer_transport: Object.freeze({
      descriptor: createMineflayerTransportDescriptor({
        botId: input.botId,
        username: readOptionalString(input.env, "MC_USERNAME") ?? input.botId,
        host: readOptionalString(input.env, "MC_HOST") ?? "localhost",
        port: readOptionalInteger(input.env, "MC_PORT", { min: 1, max: 65_535 }) ?? 25565,
        version: readOptionalString(input.env, "MC_VERSION") ?? null,
        auth: readOptionalString(input.env, "MC_AUTH") ?? null,
      }),
    }),
    bot_actor: Object.freeze({
      initial_status: input.runtimeScaffold.defaultStatus,
      ready_gate: input.runtimeScaffold.readyGate,
    }),
  });
}

/**
 * 创建应用默认的 HTTP 监听配置。
 *
 * 边界设定：固定内网监听地址与端口，作为单进程服务的标准接入点。
 */
export function createAppHttpListenOptions(): InterfaceServerListenOptions {
  return Object.freeze({
    host: "0.0.0.0",
    port: 3000,
  });
}

/**
 * 创建服务层资源目录。
 *
 * 1. 服务拓扑：关联 BullMQ 队列目录与 Fastify 路由定义。
 * 2. 生命周期规划：定义服务层资源的物理拉起与销毁顺序。
 */
export function createAppServiceDirectory<TBotId extends string>(input: {
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

/**
 * 创建应用层的 LLM（大语言模型） 配置摘要。
 *
 * 1. 若三个核心环境变量均缺失，则声明为 disabled（未启用）。
 * 2. 若任一项出现，则要求三项全部合法存在，避免“半配半不配”的隐性回退。
 */
export function createAppLlmContract(input: { env: DataConfigEnvironment }): AppLlmContract {
  const baseUrl = readOptionalString(input.env, "LLM_BASE_URL");
  const apiKey = readOptionalString(input.env, "LLM_API_KEY");
  const model = readOptionalString(input.env, "LLM_MODEL");
  const hasAnyConfig = baseUrl !== undefined || apiKey !== undefined || model !== undefined;

  if (!hasAnyConfig) {
    return Object.freeze({
      enabled: false,
      provider: "openai_compatible",
      base_url: null,
      model: null,
      api_key_injected: false,
    });
  }

  if (baseUrl === undefined) {
    throw new Error("LLM_BASE_URL must be configured when LLM is enabled");
  }

  if (apiKey === undefined) {
    throw new Error("LLM_API_KEY must be configured when LLM is enabled");
  }

  if (model === undefined) {
    throw new Error("LLM_MODEL must be configured when LLM is enabled");
  }

  return Object.freeze({
    enabled: true,
    provider: "openai_compatible",
    base_url: baseUrl,
    model,
    api_key_injected: true,
  });
}

/**
 * 创建应用默认的接口状态快照。
 *
 * 初始投影：在 BotActor 尚未完全活跃或快照不可用时，提供一个基于引导契约的保底状态视图。
 */
export function createAppDefaultInterfaceStatusSnapshot<TBotId extends string>(
  bootstrap: AppBootstrapContract<TBotId>,
  runtimeCore?: AppRuntimeCoreResources<TBotId>,
  latestLlmDiagnostic: LlmDiagnosticSummary | null = null,
): InterfaceBotStatusSnapshot {
  const actorSnapshot = runtimeCore?.actor.getSnapshot();
  const transportSnapshot = actorSnapshot?.transport as
    | {
        readonly connected?: boolean;
        readonly username?: string;
        readonly world_ready?: boolean;
      }
    | undefined;

  return createInterfaceBotStatusSnapshot({
    bot_id: bootstrap.bot_id,
    status: actorSnapshot?.status ?? bootstrap.runtime.initial_status,
    intent_epoch: 0,
    last_event_seq: 0,
    updated_at: bootstrap.interfaces.health.timestamp,
    ...(transportSnapshot === undefined
      ? {}
      : {
          mineflayer: {
            connected: transportSnapshot.connected ?? false,
            world_ready: transportSnapshot.world_ready ?? false,
            ...(transportSnapshot.username === undefined
              ? {}
              : { username: transportSnapshot.username }),
          },
        }),
    llm: latestLlmDiagnostic,
  });
}

/** 创建带有应用执行计划的外部认证契约。 */
export function createAppExternalAuthPlanContract(
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
