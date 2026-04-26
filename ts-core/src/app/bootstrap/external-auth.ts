import type { DataConfigEnvironment } from "../../data/index.js";
import {
  createExternalAuthPublicState,
  createExternalAuthSecretBinding,
  createExternalAuthState,
} from "../../runtime/index.js";
import type { ExternalAuthSecretBinding, ExternalAuthState } from "../../runtime/index.js";
import {
  asOptionalPlainObject,
  readOptionalBoolean,
  readOptionalBooleanField,
  readOptionalString,
  readOptionalStringField,
} from "./env.js";
import type {
  AppBootstrapContract,
  AppExternalAuthInitialConfig,
  AppRuntimeCoreResourceDependencies,
} from "./types.js";

/**
 * 解析应用外部认证决策。
 *
 * 1. 策略分发：根据环境变量或 Bot 配置判断是否需要认证。
 * 2. 秘密绑定：尝试从环境变量或配置中解析并绑定明文密钥。
 * 3. 失败预测：若配置要求认证但未找到有效密钥，立即宣告状态为失败，避免进入后续复杂的认证流程。
 */
export function resolveAppExternalAuthResolution(
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

/**
 * 从运行时状态创建外部认证初始配置。
 *
 * 1. 状态投影：将复杂的 ExternalAuthState 转换为引导层专用的简化配置视图。
 * 2. 入口锁定：在引导阶段就确定认证操作的物理入口（如聊天命令）。
 */
export function createAppExternalAuthInitialConfigFromRuntimeState(
  runtimeState: ExternalAuthState,
): AppExternalAuthInitialConfig {
  return Object.freeze({
    state: createExternalAuthPublicState(runtimeState),
    entrypoint: runtimeState.entrypoint,
    secret_injected: runtimeState.status === "pending" || runtimeState.status === "authenticated",
  });
}

/**
 * 为运行时核心组件创建外部认证状态。
 *
 * 1. 依赖解耦：将引导契约中的状态重新包装为运行时所需的领域对象。
 * 2. 运行时校验：在创建核心组件前，确保“已认证”或“待认证”状态下必须持有明文密钥。
 */
export function createAppRuntimeCoreExternalAuth(
  bootstrap: AppBootstrapContract,
  dependencies: AppRuntimeCoreResourceDependencies,
): ExternalAuthState {
  switch (bootstrap.runtime.external_auth.status) {
    case "not_required":
      return createExternalAuthState({ status: "not_required" });
    case "pending":
      if (dependencies.externalAuthSecret === undefined) {
        throw new Error("pending runtime core external auth requires injected secret binding");
      }

      return createExternalAuthState({
        status: "pending",
        secret: dependencies.externalAuthSecret,
      });
    case "authenticated":
      if (dependencies.externalAuthSecret === undefined) {
        throw new Error(
          "authenticated runtime core external auth requires injected secret binding",
        );
      }

      return createExternalAuthState({
        status: "authenticated",
        secret: dependencies.externalAuthSecret,
      });
    case "failed":
      return createExternalAuthState({
        status: "failed",
        failureReason: bootstrap.runtime.external_auth.failure_reason,
        secretSource: bootstrap.runtime.external_auth.secret_source,
        secretReference: bootstrap.runtime.external_auth.secret_reference,
      });
  }
}

/** 解析系统必需的认证入口点配置。 */
export function resolveRequiredAuthEntrypoint(
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

/** 从环境及配置对象中解析外部认证所需密钥。 */
export function resolveExternalAuthSecretBinding(
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

/**
 * 推断外部认证密钥的来源。
 *
 * 自动溯源：根据配置项的优先级，判定密钥是从环境变量还是 Bot 配置文件中读取。
 */
export function inferSecretSource(
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

/**
 * 推断外部认证密钥的具体引用标识。
 *
 * 诊断支持：提供具体的文件键名或环境变量名，用于在认证失败时进行精准提示。
 */
export function inferSecretReference(
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
