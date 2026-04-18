/**
 * Fastify（接口网关） 最小 HTTP（超文本传输协议） 服务器骨架。
 *
 * 架构职责：
 * 1. 基于纯接口契约注册最小 Phase 1 路由。
 * 2. 提供 listen（监听） / close（关闭） 生命周期边界，并支持 `fastify.inject()` 测试。
 * 3. 通过依赖注入与可替换处理器，隔离真实网络监听与后续消息处理链路。
 */

import Fastify, { type FastifyInstance } from "fastify";

import { assertNonEmptyString } from "../domain/invariants.js";
import {
  API_ROUTE_DEFINITIONS,
  type ReplayRequest,
  type ReplayResponse,
  type StatusQuery,
  type StatusResponse,
  createReplayRequest,
  createReplayResponse,
  createStatusQuery,
  createStatusResponse,
} from "./api.js";
import {
  type HealthResponse,
  type InterfaceBotStatusSnapshot,
  type MessageAcceptedResponse,
  type MessageSubmissionRequest,
  createInterfaceBotStatusSnapshot,
  createMessageAcceptedResponse,
} from "./contracts.js";

/** HTTP（超文本传输协议） 监听参数。 */
export interface InterfaceServerListenOptions {
  /** 监听主机。 */
  readonly host: string;
  /** 监听端口。 */
  readonly port: number;
}

/** Fastify（接口网关） 路由处理器注入。 */
export interface InterfaceServerRouteHandlers {
  /** 健康检查处理器。 */
  readonly health?: () => HealthResponse | Promise<HealthResponse>;
  /** 状态查询处理器。 */
  readonly status?: (query: StatusQuery) => StatusResponse | Promise<StatusResponse>;
  /** 消息提交处理器。 */
  readonly message?: (
    request: MessageSubmissionRequest,
  ) => MessageAcceptedResponse | Promise<MessageAcceptedResponse>;
  /** replay（补拉） 处理器。 */
  readonly replay?: (request: ReplayRequest) => ReplayResponse | Promise<ReplayResponse>;
}

/** Fastify（接口网关） 工厂可注入依赖。 */
export interface InterfaceServerDependencies {
  /** 自定义 Fastify（接口网关） 工厂。 */
  readonly createServer?: () => FastifyInstance;
}

/** 最小 Fastify（接口网关） 运行时句柄。 */
export interface InterfaceServerRuntime<TBotId extends string = string> {
  /** 资源类型。 */
  readonly kind: "fastify";
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 已注册路由的 Fastify（接口网关） 实例。 */
  readonly server: FastifyInstance;
  /** 路由目录快照。 */
  readonly routes: typeof API_ROUTE_DEFINITIONS;
  /** 默认监听参数。 */
  readonly listen_options: InterfaceServerListenOptions;
  /** 真实监听。 */
  listen(options?: Partial<InterfaceServerListenOptions>): Promise<string>;
  /** 关闭 HTTP（超文本传输协议） 服务。 */
  close(): Promise<void>;
}

/**
 * 创建 HTTP 400 错误。
 */
function createHttpBadRequest(message: string): Error & { statusCode: 400 } {
  const error = new Error(message) as Error & { statusCode: 400 };

  error.statusCode = 400;

  return error;
}

/**
 * 读取并校验必填字符串。
 */
function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw createHttpBadRequest(`${fieldName} must be a string`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw createHttpBadRequest(`${fieldName} must be a non-empty string`);
  }

  return normalizedValue;
}

/**
 * 校验请求中的 Bot ID 是否匹配当前运行时。
 */
function assertRequestBotId(requestBotId: string, runtimeBotId: string): void {
  if (requestBotId !== runtimeBotId) {
    throw createHttpBadRequest("bot_id does not match current runtime bot");
  }
}

/**
 * 读取并校验整数。
 */
function readInteger(value: unknown, fieldName: string, fallback?: number): number {
  const resolved = value ?? fallback;

  if (resolved === undefined) {
    throw createHttpBadRequest(`${fieldName} is required`);
  }

  const numericValue =
    typeof resolved === "number"
      ? resolved
      : typeof resolved === "string"
        ? Number.parseInt(resolved, 10)
        : Number.NaN;

  if (!Number.isInteger(numericValue)) {
    throw createHttpBadRequest(`${fieldName} must be an integer`);
  }

  return numericValue;
}

/**
 * 读取并校验监听参数。
 */
function readListenOptions(input: InterfaceServerListenOptions): InterfaceServerListenOptions {
  assertNonEmptyString(input.host, "listen.host");

  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65_535) {
    throw new Error("listen.port must be a valid TCP port");
  }

  return Object.freeze({
    host: input.host.trim(),
    port: input.port,
  });
}

/**
 * 为指定 Bot 克隆状态快照。
 */
function cloneStatusForBot(
  status: InterfaceBotStatusSnapshot,
  botId: string,
): InterfaceBotStatusSnapshot {
  return createInterfaceBotStatusSnapshot({
    ...status,
    bot_id: botId,
  });
}

/**
 * 创建最小 Fastify 运行时骨架。
 *
 * 架构职责：
 * 1. 路由注册（Route Registration）：基于静态契约注册系统的 Phase 1 HTTP 接口。
 * 2. 入口协议转换：将 HTTP Query/Body 参数转换为系统内部的强类型请求对象（如 StatusQuery, ReplayRequest）。
 * 3. 处理器抽象：支持注入业务处理器（Handlers），实现 Fastify 框架与核心业务逻辑的解耦。
 *
 * 架构意图：
 * 1. 轻量级网关：提供一个可测试、低开销的 HTTP 接入层，支持 listen/close 生命周期管理及 fastify.inject() 测试模拟。
 *
 * @param input 路由目录、健康基线和占位处理器
 * @param dependencies 可注入的 Fastify 实例工厂
 * @returns 已注册四条最小路由的运行时句柄
 */
export function createInterfaceServerRuntime<TBotId extends string>(
  input: {
    bot_id: TBotId;
    health: HealthResponse;
    default_status: InterfaceBotStatusSnapshot;
    listen: InterfaceServerListenOptions;
    handlers?: InterfaceServerRouteHandlers;
  },
  dependencies: InterfaceServerDependencies = {},
): InterfaceServerRuntime<TBotId> {
  assertNonEmptyString(input.bot_id, "bot_id");

  if (input.default_status.bot_id !== input.bot_id) {
    throw new Error("default_status.bot_id must match bot_id");
  }

  const listenOptions = readListenOptions(input.listen);
  const handlers = input.handlers ?? {};
  const server = dependencies.createServer?.() ?? Fastify();

  server.get("/api/health", async () => handlers.health?.() ?? input.health);

  server.get("/api/status", async (request) => {
    const queryRecord = request.query as Record<string, unknown>;
    const statusQuery = createStatusQuery(readRequiredString(queryRecord.bot_id, "bot_id"));
    assertRequestBotId(statusQuery.bot_id, input.bot_id);

    return (
      (await handlers.status?.(statusQuery)) ??
      createStatusResponse({
        bot: cloneStatusForBot(input.default_status, statusQuery.bot_id),
      })
    );
  });

  server.post("/api/message", async (request, reply) => {
    const bodyRecord = request.body as Record<string, unknown>;
    const messageRequest = Object.freeze({
      bot_id: readRequiredString(bodyRecord.bot_id, "bot_id"),
      message_id: readRequiredString(bodyRecord.message_id, "message_id"),
      content: readRequiredString(bodyRecord.content, "content"),
    } satisfies MessageSubmissionRequest);
    assertRequestBotId(messageRequest.bot_id, input.bot_id);
    const acceptedResponse =
      (await handlers.message?.(messageRequest)) ??
      createMessageAcceptedResponse({
        botId: messageRequest.bot_id,
        jobId: messageRequest.message_id,
        messageId: messageRequest.message_id,
        queuedAt: input.health.timestamp,
      });

    reply.code(202);

    return acceptedResponse;
  });

  server.get("/api/replay", async (request) => {
    const queryRecord = request.query as Record<string, unknown>;
    const replayRequest = createReplayRequest({
      botId: readRequiredString(queryRecord.bot_id, "bot_id"),
      afterSeq: readInteger(queryRecord.after_seq, "after_seq", 0),
      ...(queryRecord.limit === undefined
        ? {}
        : { limit: readInteger(queryRecord.limit, "limit") }),
    });
    assertRequestBotId(replayRequest.bot_id, input.bot_id);

    return (
      (await handlers.replay?.(replayRequest)) ??
      createReplayResponse({
        request: replayRequest,
        state: cloneStatusForBot(input.default_status, replayRequest.bot_id),
        events: [],
      })
    );
  });

  return Object.freeze({
    kind: "fastify",
    bot_id: input.bot_id,
    server,
    routes: API_ROUTE_DEFINITIONS,
    listen_options: listenOptions,
    listen(options?: Partial<InterfaceServerListenOptions>): Promise<string> {
      return server.listen({
        host: options?.host ?? listenOptions.host,
        port: options?.port ?? listenOptions.port,
      });
    },
    async close(): Promise<void> {
      await server.close();
    },
  });
}
