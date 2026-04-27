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

import type { ServerBridgeEventEnvelope } from "./contracts.js";
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
  /** 解析失败回调，便于诊断；不允许回显 access token。 */
  readonly onParseFailure?: (input: {
    readonly raw: string;
    readonly failure: ServerBridgeFrameParseFailure;
  }) => void;
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
        options.onClose?.({
          code,
          reason: reason.toString("utf8"),
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
