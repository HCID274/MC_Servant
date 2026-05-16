import { createDataConfig } from "../../data/index.js";
import type { DataConfigEnvironment } from "../../data/index.js";
import {
  createDrizzleMigrationMetadata,
  createPostgresConnectionDescriptor,
  createRedisConnectionDescriptor,
  createRedisKeyCatalog,
} from "../../db/index.js";
import { createDiagnosticsCatalog } from "../../diagnostics/index.js";
import { assertNonEmptyString } from "../../domain/invariants.js";
import { API_ROUTE_DEFINITIONS, createHealthResponse } from "../../interfaces/index.js";
import { BotStatus, createRuntimeScaffold } from "../../runtime/index.js";
import type { ExternalAuthSecretBinding } from "../../runtime/index.js";
import { createSandboxResourceLimits } from "../../sandbox/index.js";
import { createWorkerQueueCatalog } from "../../workers/index.js";
import { createAppLifecyclePlan, createAppReadinessCatalog } from "../contracts.js";
import { selectDataBotConfig } from "./config.js";
import {
  createAppHttpListenOptions,
  createAppLlmContract,
  createAppResourceDirectory,
  createAppRuntimeCoreDirectory,
  createAppRuntimeScaffoldContract,
  createAppServiceDirectory,
} from "./directories.js";
import { readOptionalString } from "./env.js";
import {
  createAppExternalAuthInitialConfigFromRuntimeState,
  resolveAppExternalAuthResolution,
} from "./external-auth.js";
import type {
  AppBootstrapContract,
  AppBootstrapInput,
  AppExternalAuthInitialConfig,
} from "./types.js";

/**
 * 创建应用装配层的外部认证初始配置。
 *
 * 1. 提供外部认证（如 Minecraft 账户登录）在引导阶段的静态视图。
 * 2. 预判认证入口和密钥注入状态，辅助引导层决定是否需要暂停启动流程等待人工干预。
 *
 * @param input 包含环境变量或 Bot 配置的可选输入
 * @returns 初始认证配置对象
 */
export function createAppExternalAuthInitialConfig(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): AppExternalAuthInitialConfig {
  const runtimeState = resolveAppExternalAuthResolution(input).state;

  return createAppExternalAuthInitialConfigFromRuntimeState(runtimeState);
}

/**
 * 从应用环境中解析一次性外部认证明文密钥绑定。
 *
 * 1. 将明文密钥（如账户 Token 或密码）的提取逻辑封装在引导层。
 * 2. 结果仅供运行时启动动作（如 Mineflayer 登录）瞬间使用，不在配置对象中长期留存。
 *
 * @param input 包含环境变量或 Bot 配置的输入
 * @returns 密钥绑定对象，如果未找到则返回 undefined
 */
export function createAppExternalAuthSecretFromEnvironment(input: {
  env?: DataConfigEnvironment;
  botConfig?: unknown;
}): ExternalAuthSecretBinding | undefined {
  return resolveAppExternalAuthResolution(input).secret;
}

/**
 * 从应用环境中解析 LLM（大语言模型） 接口密钥。
 *
 * 1. 装配契约只暴露“是否已注入”，不长期留存明文。
 * 2. 真正的在线入口在启动瞬间拿到密钥后立刻交给网络客户端使用。
 *
 * @param input 包含环境变量快照的输入
 * @returns 已校验的密钥；未配置时返回 undefined
 */
export function createAppLlmApiKeyFromEnvironment(input: {
  env?: DataConfigEnvironment;
}): string | undefined {
  return readOptionalString(input.env ?? {}, "LLM_API_KEY");
}

/**
 * 创建应用引导契约。
 *
 * 1. 验证基础引导参数（Bot ID, 启动时间戳）的合法性。
 * 2. 依次聚合配置、生命周期计划、数据库描述、运行时骨架和诊断目录。
 * 3. 生成一个不可变的、且包含所有子系统定义的“组合根契约（Composition Root Contract）”。
 * 4. 将“定义”与“实例创建”解耦，确保系统在没有任何真实 I/O 资源被分配前，就能完成所有静态结构的校验。
 * 5. 为测试提供一个完整的“声明式”系统快照，便于在不启动真实服务的情况下进行验证。
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
  const externalAuth = createAppExternalAuthInitialConfigFromRuntimeState(
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
  const llm = createAppLlmContract({
    env: input.env ?? {},
  });
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
      resource_limits: createSandboxResourceLimits(),
    }),
    diagnostics: Object.freeze({
      catalog: createDiagnosticsCatalog(),
    }),
    llm,
    migrations,
    resources: createAppResourceDirectory({
      postgres,
      migrations,
      redisKeys,
      redisConnection,
    }),
    runtime_resources: createAppRuntimeCoreDirectory({
      botId: input.botId,
      runtimeScaffold,
      env: input.env ?? {},
    }),
    services: createAppServiceDirectory({
      workers: workersCatalog,
      httpListen: createAppHttpListenOptions(),
    }),
    lifecycle,
    readiness: createAppReadinessCatalog(),
  });
}
