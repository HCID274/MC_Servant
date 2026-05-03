import type { DataConfigEnvironment } from "../../data/index.js";
import { assertNonEmptyString } from "../../domain/invariants.js";

/** Server Bridge（服务端桥接） 环境变量解析结果。 */
export interface AppServerBridgeEnvironmentConfig {
  /** 是否启用接收端。 */
  readonly enabled: true;
  /** 注入到 WebSocket（全双工通信协议） 握手校验中的访问令牌。 */
  readonly accessToken: string;
  /** 是否把 player_message（玩家消息） 接入 conversation（对话）主线。 */
  readonly conversationEnabled: boolean;
  /** 可选监听路径，默认由路由层使用 /ws/server-bridge。 */
  readonly path?: string;
  /** 可选心跳超时毫秒数，默认由路由层使用 90 秒。 */
  readonly heartbeatTimeoutMs?: number;
}

/** BrainWorker（大脑工作线程） embedding（向量） 环境变量解析结果。 */
export interface AppEmbeddingEnvironmentConfig {
  /** 完整 embeddings endpoint（向量端点）。 */
  readonly endpoint_url?: string;
  /** OpenAI compatible（OpenAI 兼容） base URL（基础地址）。 */
  readonly base_url?: string;
  /** embedding API（向量接口）密钥。 */
  readonly api_key: string;
  /** embedding model（向量模型）。 */
  readonly model?: string;
}

/**
 * 将未知输入转换为可选的普通对象。
 *
 * 类型防御：在解析外部配置时提供第一层类型校验。
 */
export function asOptionalPlainObject(
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

/**
 * 从环境变量读取可选布尔值。
 *
 * 宽容解析：支持 1/true/yes/on 等多种布尔表达方式。
 */
export function readOptionalBoolean(
  env: DataConfigEnvironment,
  fieldName: string,
): boolean | undefined {
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

/**
 * 从普通对象读取可选布尔字段。
 */
export function readOptionalBooleanField(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

/**
 * 内部辅助函数，读取可选环境变量并确保非空。
 */
export function readOptionalEnvValue(
  env: DataConfigEnvironment,
  fieldName: string,
): string | undefined {
  const value = env[fieldName];

  if (value === undefined || value === "") {
    return undefined;
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }

  return normalizedValue;
}

/**
 * 从环境变量读取可选字符串。
 */
export function readOptionalString(
  env: DataConfigEnvironment,
  fieldName: string,
): string | undefined {
  return readOptionalEnvValue(env, fieldName);
}

/**
 * 从环境变量解析 Server Bridge（服务端桥接） 接收端配置。
 *
 * 默认策略：
 * 1. SERVER_BRIDGE_ENABLED（是否启用） 未设置时，按 SERVER_BRIDGE_ACCESS_TOKEN（访问令牌） 是否存在决定。
 * 2. 显式 false（禁用） 时不注册端点，即使 token（令牌） 存在也保持关闭。
 * 3. 显式 true（启用） 时必须提供 token（令牌），错误信息不得回显 token（令牌） 内容。
 */
export function createAppServerBridgeConfigFromEnvironment(input: {
  env: DataConfigEnvironment;
}): AppServerBridgeEnvironmentConfig | undefined {
  const enabled = readOptionalBoolean(input.env, "SERVER_BRIDGE_ENABLED");
  const accessToken = readOptionalString(input.env, "SERVER_BRIDGE_ACCESS_TOKEN");
  const path = readOptionalString(input.env, "SERVER_BRIDGE_PATH");
  const heartbeatTimeoutMs = readOptionalInteger(input.env, "SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS", {
    min: 1,
  });
  const conversationEnabled =
    readOptionalBoolean(input.env, "SERVER_BRIDGE_CONVERSATION_ENABLED") ?? false;

  if (enabled === false) {
    return undefined;
  }

  if (enabled === true && accessToken === undefined) {
    throw new Error(
      "SERVER_BRIDGE_ACCESS_TOKEN must be configured when SERVER_BRIDGE_ENABLED is true",
    );
  }

  if (enabled === undefined && accessToken === undefined) {
    return undefined;
  }

  if (accessToken === undefined) {
    throw new Error("SERVER_BRIDGE_ACCESS_TOKEN must be configured when Server Bridge is enabled");
  }

  return Object.freeze({
    enabled: true,
    accessToken,
    conversationEnabled,
    ...(path === undefined ? {} : { path }),
    ...(heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs }),
  });
}

/**
 * 从环境变量解析 BrainWorker（大脑工作线程） embedding（向量） 配置。
 *
 * 任一 EMBEDDING_*（向量配置）出现时即视为启用独立 embedding（向量）装配，
 * 必须显式提供 endpoint/base_url（端点/基础地址） 与 api_key（密钥），避免回退到 LLM
 * base_url（大语言模型基础地址）后再次打到不支持 embeddings（向量）的网关。
 */
export function createAppEmbeddingConfigFromEnvironment(input: {
  env: DataConfigEnvironment;
}): AppEmbeddingEnvironmentConfig | undefined {
  const endpointUrl = readOptionalString(input.env, "EMBEDDING_ENDPOINT_URL");
  const baseUrl = readOptionalString(input.env, "EMBEDDING_BASE_URL");
  const apiKey = readOptionalString(input.env, "EMBEDDING_API_KEY");
  const model = readOptionalString(input.env, "EMBEDDING_MODEL");
  const hasAnyConfig =
    endpointUrl !== undefined ||
    baseUrl !== undefined ||
    apiKey !== undefined ||
    model !== undefined;

  if (!hasAnyConfig) {
    return undefined;
  }

  if (endpointUrl === undefined && baseUrl === undefined) {
    throw new Error(
      "EMBEDDING_ENDPOINT_URL or EMBEDDING_BASE_URL must be configured when embedding is enabled",
    );
  }

  if (apiKey === undefined) {
    throw new Error("EMBEDDING_API_KEY must be configured when embedding is enabled");
  }

  return Object.freeze({
    ...(endpointUrl === undefined ? {} : { endpoint_url: endpointUrl }),
    ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
    api_key: apiKey,
    ...(model === undefined ? {} : { model }),
  });
}

/**
 * 从环境变量读取可选整数并校验边界。
 */
export function readOptionalInteger(
  env: DataConfigEnvironment,
  fieldName: string,
  bounds?: {
    min?: number;
    max?: number;
  },
): number | undefined {
  const value = readOptionalEnvValue(env, fieldName);

  if (value === undefined) {
    return undefined;
  }

  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${fieldName} must be an integer string`);
  }

  const integerValue = Number(value);

  if (!Number.isSafeInteger(integerValue)) {
    throw new Error(`${fieldName} must be an integer string`);
  }

  if (bounds?.min !== undefined && integerValue < bounds.min) {
    throw new Error(`${fieldName} must be at least ${bounds.min}`);
  }

  if (bounds?.max !== undefined && integerValue > bounds.max) {
    throw new Error(`${fieldName} must be at most ${bounds.max}`);
  }

  return integerValue;
}

/**
 * 从对象中读取可选字符串字段。
 */
export function readOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  assertNonEmptyString(value, fieldName);

  return value.trim();
}
