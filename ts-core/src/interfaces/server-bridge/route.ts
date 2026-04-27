/**
 * Server Bridge（服务端桥接） WebSocket（全双工通信协议） 路由装配。
 *
 * 1. 端点收口：把 mod（模组）→ TS Core（TypeScript 单核心）外部桥接通道收口为单一路由 /ws/server-bridge。
 * 2. token 校验：握手阶段校验 Authorization: Bearer <token>，缺失或不匹配直接拒绝 upgrade，
 *    不进入 onConnect，不写入 replay（补拉）事件流。
 * 3. 帧编排：解析 hello / heartbeat / player_message，回送 ack / error，并把成功事件
 *    通过 onEvent 注入 replay 流（observe_only）。
 * 4. 脱敏：access token 只在 Authorization 头中流动，不进入日志、ack/error 帧或事件载荷。
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import fastifyWebsocket from "@fastify/websocket";

import { type ServerBridgeEventEnvelope, createServerBridgeEventEnvelope } from "./contracts.js";
import {
  type ServerBridgeAckFrame,
  type ServerBridgeErrorCode,
  type ServerBridgeErrorFrame,
  type ServerBridgeFrameParseFailure,
  type ServerBridgeInboundFrame,
  type ServerBridgeInboundFrameType,
  createServerBridgeAckFrame,
  createServerBridgeEnvelopeFromFrame,
  createServerBridgeErrorFrame,
  parseServerBridgeInboundFrame,
} from "./protocol.js";

/** Server Bridge（服务端桥接） WebSocket 端点默认路径。 */
export const SERVER_BRIDGE_WS_PATH = "/ws/server-bridge" as const;

/** Server Bridge（服务端桥接） 默认心跳超时毫秒数。 */
export const SERVER_BRIDGE_DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;

/** Server Bridge（服务端桥接） 单连接 message_id（消息标识）去重窗口大小。 */
export const SERVER_BRIDGE_MESSAGE_ID_DEDUP_WINDOW_SIZE = 1024;

/** 帧成功解析后的事件回调入参。 */
export interface ServerBridgeRouteEventInput {
  /** 入站原始帧。 */
  readonly frame: ServerBridgeInboundFrame;
  /** 转换后的 ServerBridgeEventEnvelope（observe_only）。 */
  readonly envelope: ServerBridgeEventEnvelope;
  /** 服务端接收时间。 */
  readonly received_at: string;
}

/** Server Bridge WebSocket 路由装配输入。 */
export interface ServerBridgeWsRouteOptions {
  /** 注入的访问令牌；为空字符串等同于禁用握手。 */
  readonly accessToken: string;
  /** 端点路径，默认 /ws/server-bridge。 */
  readonly path?: string;
  /** 当前 bot_id；envelope 与 instance_id 解耦，envelope 上必须固定。 */
  readonly botId: string;
  /** 时钟，用于 ack / error / 事件时间戳；默认使用系统时间。 */
  readonly now?: () => string;
  /** 事件 id 生成器；默认基于时间戳与计数器。 */
  readonly eventIdFactory?: () => string;
  /** 帧解析成功后的回调；用于把事件写入 replay 流。 */
  readonly onEvent?: (input: ServerBridgeRouteEventInput) => void | Promise<void>;
  /** 连接生命周期诊断事件回调；用于 replay（补拉） 或状态诊断。 */
  readonly onLifecycleEvent?: (input: {
    readonly envelope: ServerBridgeEventEnvelope;
    readonly received_at: string;
  }) => void | Promise<void>;
  /** 解析失败回调，便于诊断；不允许回显 access token。 */
  readonly onParseFailure?: (input: {
    readonly raw: string;
    readonly failure: ServerBridgeFrameParseFailure;
  }) => void;
  /** 心跳超时毫秒数；默认 90 秒，适合本地开发。 */
  readonly heartbeatTimeoutMs?: number;
  /** WS 关闭时回调；不强制要求实现。 */
  readonly onClose?: (input: { readonly code: number; readonly reason: string }) => void;
}

/** Server Bridge WebSocket 路由装配结果。 */
export interface ServerBridgeWsRouteRegistration {
  /** 实际生效的端点路径。 */
  readonly path: string;
}

/**
 * 在已存在的 Fastify 实例上注册 Server Bridge WebSocket 端点。
 *
 * 1. 注册 @fastify/websocket 插件；调用方需保证只注册一次（重复注册会被插件本身拒绝）。
 * 2. 装配 GET <path> 路由，并在 preValidation 阶段校验 Bearer token。
 * 3. 在 ws 处理器内逐帧解析、回送 ack/error，并通过 onEvent 把成功事件注入 replay 流。
 *
 * @param server   现成的 Fastify 实例（与 createInterfaceServerRuntime 共用）
 * @param options  路由装配选项
 * @returns        装配结果（端点路径）
 */
export async function registerServerBridgeWsRoute(
  server: FastifyInstance,
  options: ServerBridgeWsRouteOptions,
): Promise<ServerBridgeWsRouteRegistration> {
  const path = options.path ?? SERVER_BRIDGE_WS_PATH;
  const expectedToken = options.accessToken;
  const now = options.now ?? defaultNow;
  const eventIdFactory = options.eventIdFactory ?? createDefaultEventIdFactory();
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? SERVER_BRIDGE_DEFAULT_HEARTBEAT_TIMEOUT_MS;

  if (!Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
    throw new Error("server-bridge heartbeatTimeoutMs must be a positive integer");
  }

  if (!server.hasDecorator("websocketServer")) {
    await server.register(fastifyWebsocket);
  }

  server.get(
    path,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const failure = checkAuthorization(request.headers.authorization, expectedToken);
        if (failure !== null) {
          reply.code(401).send({
            error: "unauthorized",
            message: failure,
          });
        }
      },
    },
    (socket: WebSocket, _request: FastifyRequest) => {
      const state = createConnectionState({
        socket,
        botId: options.botId,
        now,
        eventIdFactory,
        heartbeatTimeoutMs,
        ...(options.onLifecycleEvent === undefined
          ? {}
          : { onLifecycleEvent: options.onLifecycleEvent }),
      });

      state.emitLifecycle("server_bridge.connected", {
        connection_state: "connected",
        heartbeat_timeout_ms: heartbeatTimeoutMs,
      });
      state.resetHeartbeatTimeout();

      socket.on("message", (raw: Buffer) => {
        const text = raw.toString("utf8");
        const result = parseServerBridgeInboundFrame(text);

        if (!result.ok) {
          options.onParseFailure?.({ raw: redactRaw(text, expectedToken), failure: result });
          sendErrorFrame(socket, result.code, result.message, now());

          if (shouldCloseOnFailure(result.code)) {
            socket.close(4001, result.code);
          }

          return;
        }

        const protocolFailure = state.validateFrame(result.frame);
        if (protocolFailure !== null) {
          options.onParseFailure?.({
            raw: redactRaw(text, expectedToken),
            failure: protocolFailure,
          });
          sendErrorFrame(socket, protocolFailure.code, protocolFailure.message, now());
          return;
        }

        state.acceptFrame(result.frame);
        const receivedAt = now();
        const envelope = createServerBridgeEnvelopeFromFrame({
          frame: result.frame,
          botId: options.botId,
          eventId: eventIdFactory(),
          receivedAt,
        });

        const promise = options.onEvent?.({
          frame: result.frame,
          envelope,
          received_at: receivedAt,
        });

        sendAckFrame(socket, result.frame.type, receivedAt);

        if (promise !== undefined) {
          promise.catch((cause: unknown) => {
            options.onParseFailure?.({
              raw: "(onEvent failed)",
              failure: {
                ok: false,
                code: "invalid_field",
                message: cause instanceof Error ? cause.message : String(cause),
              },
            });
          });
        }
      });

      socket.on("close", (code: number, reason: Buffer) => {
        state.close();
        const reasonText = redactRaw(reason.toString("utf8"), expectedToken);
        state.emitLifecycle(code === 1000 ? "server_bridge.closed" : "server_bridge.disconnected", {
          code,
          reason: reasonText,
        });
        options.onClose?.({
          code,
          reason: reasonText,
        });
      });
    },
  );

  return Object.freeze({ path });
}

function checkAuthorization(headerValue: string | undefined, expectedToken: string): string | null {
  if (expectedToken.length === 0) {
    return "server-bridge access token is not configured";
  }

  if (typeof headerValue !== "string" || headerValue.length === 0) {
    return "Authorization header is required";
  }

  if (!headerValue.startsWith("Bearer ")) {
    return "Authorization header must start with 'Bearer '";
  }

  const token = headerValue.slice("Bearer ".length).trim();

  if (token.length === 0) {
    return "Authorization Bearer token is empty";
  }

  if (token !== expectedToken) {
    return "Authorization Bearer token does not match";
  }

  return null;
}

function sendAckFrame(
  socket: WebSocket,
  ackType: ServerBridgeInboundFrameType,
  timestamp: string,
): void {
  const ack: ServerBridgeAckFrame = createServerBridgeAckFrame({ ackType, timestamp });
  socket.send(JSON.stringify(ack));
}

function sendErrorFrame(
  socket: WebSocket,
  code: ServerBridgeErrorCode,
  message: string,
  timestamp: string,
): void {
  const errorFrame: ServerBridgeErrorFrame = createServerBridgeErrorFrame({
    code,
    message,
    timestamp,
  });
  socket.send(JSON.stringify(errorFrame));
}

function shouldCloseOnFailure(code: ServerBridgeErrorCode): boolean {
  return code === "protocol_version_mismatch";
}

function createConnectionState(input: {
  socket: WebSocket;
  botId: string;
  now: () => string;
  eventIdFactory: () => string;
  heartbeatTimeoutMs: number;
  onLifecycleEvent?: (input: {
    readonly envelope: ServerBridgeEventEnvelope;
    readonly received_at: string;
  }) => void | Promise<void>;
}): {
  readonly validateFrame: (frame: ServerBridgeInboundFrame) => ServerBridgeFrameParseFailure | null;
  readonly acceptFrame: (frame: ServerBridgeInboundFrame) => void;
  readonly resetHeartbeatTimeout: () => void;
  readonly emitLifecycle: (eventType: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly close: () => void;
} {
  let handshaken = false;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  const seenMessageIds = new Set<string>();
  const seenMessageIdOrder: string[] = [];

  const emitLifecycle = (eventType: string, payload: Readonly<Record<string, unknown>>): void => {
    const receivedAt = input.now();
    const envelope = createServerBridgeEventEnvelope({
      bot_id: input.botId,
      event_id: input.eventIdFactory(),
      event_type: eventType,
      timestamp: receivedAt,
      payload,
    });
    const promise = input.onLifecycleEvent?.({ envelope, received_at: receivedAt });

    if (promise !== undefined) {
      promise.catch(() => undefined);
    }
  };

  const resetHeartbeatTimeout = (): void => {
    if (closed) {
      return;
    }

    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(() => {
      if (closed) {
        return;
      }

      emitLifecycle("server_bridge.heartbeat_timeout", {
        timeout_ms: input.heartbeatTimeoutMs,
      });
      input.socket.close(4002, "heartbeat_timeout");
    }, input.heartbeatTimeoutMs);
  };

  return Object.freeze({
    validateFrame(frame): ServerBridgeFrameParseFailure | null {
      if (frame.type === "hello") {
        if (handshaken) {
          return {
            ok: false,
            code: "duplicate_hello",
            message: "server-bridge hello was already accepted",
          };
        }
        return null;
      }

      if (!handshaken) {
        return {
          ok: false,
          code: "handshake_required",
          message: "server-bridge hello must be accepted before this frame",
        };
      }

      if (frame.type === "player_message" && seenMessageIds.has(frame.message_id)) {
        return {
          ok: false,
          code: "duplicate_message_id",
          message: "server-bridge player_message message_id was already accepted",
        };
      }

      return null;
    },
    acceptFrame(frame): void {
      if (frame.type === "hello") {
        handshaken = true;
      }

      if (frame.type === "heartbeat") {
        resetHeartbeatTimeout();
      }

      if (frame.type === "player_message") {
        rememberMessageId(seenMessageIds, seenMessageIdOrder, frame.message_id);
      }
    },
    resetHeartbeatTimeout,
    emitLifecycle,
    close(): void {
      closed = true;
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  });
}

function rememberMessageId(
  seenMessageIds: Set<string>,
  seenMessageIdOrder: string[],
  id: string,
): void {
  seenMessageIds.add(id);
  seenMessageIdOrder.push(id);

  if (seenMessageIdOrder.length <= SERVER_BRIDGE_MESSAGE_ID_DEDUP_WINDOW_SIZE) {
    return;
  }

  const oldestId = seenMessageIdOrder.shift();
  if (oldestId !== undefined) {
    seenMessageIds.delete(oldestId);
  }
}

function redactRaw(raw: string, token: string): string {
  if (token.length === 0) {
    return raw;
  }

  return raw.split(token).join("[redacted]");
}

function defaultNow(): string {
  return new Date().toISOString();
}

function createDefaultEventIdFactory(): () => string {
  let counter = 0;

  return () => {
    counter += 1;
    return `server-bridge-${Date.now()}-${counter.toString(36)}`;
  };
}
