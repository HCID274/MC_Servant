/**
 * Server Bridge（服务端桥接） 应用层协议契约。
 *
 * 1. 帧形态：定义 mod（模组） → TS Core（TypeScript 单核心） 的 hello（握手） / heartbeat（心跳） / player_message（玩家消息），
 *    以及 TS Core 回送的 ack（确认） / error（错误）帧。
 * 2. 解析：提供 parseServerBridgeInboundFrame，把任意 unknown 输入收口为强类型联合，
 *    所有失败统一返回 ServerBridgeFrameParseFailure 而非抛异常，便于路由层稳压响应。
 * 3. 转换：将解析成功的帧转换为通道层 ServerBridgeEventEnvelope，保持 runtime_effect="observe_only"。
 * 4. 脱敏：协议层不感知 access token；任何字段都不允许回显或打印 token。
 */

import { cloneReadonlyValue } from "../../domain/invariants.js";
import { type ServerBridgeEventEnvelope, createServerBridgeEventEnvelope } from "./contracts.js";

/** Server Bridge（服务端桥接） 协议版本，与 mod 端 OkHttp 实现对齐。 */
export const SERVER_BRIDGE_PROTOCOL_VERSION = "server-bridge.v1" as const;

/** 入站帧类型集合。 */
export const SERVER_BRIDGE_INBOUND_FRAME_TYPES = ["hello", "heartbeat", "player_message"] as const;

/** 入站帧类型联合。 */
export type ServerBridgeInboundFrameType = (typeof SERVER_BRIDGE_INBOUND_FRAME_TYPES)[number];

/** 出站帧类型集合（TS Core 回送）。 */
export const SERVER_BRIDGE_OUTBOUND_FRAME_TYPES = ["ack", "error"] as const;

/** 出站帧类型联合。 */
export type ServerBridgeOutboundFrameType = (typeof SERVER_BRIDGE_OUTBOUND_FRAME_TYPES)[number];

/** 协议错误码集合，用于在 close / error 帧上提供机器可读的失败原因。 */
export const SERVER_BRIDGE_ERROR_CODES = [
  "invalid_json",
  "missing_type",
  "unknown_type",
  "protocol_version_mismatch",
  "missing_field",
  "invalid_field",
  "unauthorized",
] as const;

/** 协议错误码联合。 */
export type ServerBridgeErrorCode = (typeof SERVER_BRIDGE_ERROR_CODES)[number];

/** mod 端发送的 hello（握手）帧。 */
export interface ServerBridgeHelloFrame {
  readonly type: "hello";
  readonly protocol_version: typeof SERVER_BRIDGE_PROTOCOL_VERSION;
  readonly mod_id: string;
  readonly mod_version: string;
  readonly connected_at: string;
  readonly instance_id: string;
}

/** mod 端发送的 heartbeat（心跳）帧。 */
export interface ServerBridgeHeartbeatFrame {
  readonly type: "heartbeat";
  readonly protocol_version: typeof SERVER_BRIDGE_PROTOCOL_VERSION;
  readonly instance_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly state: string;
}

/** mod 端发送的 player_message（玩家消息）帧。 */
export interface ServerBridgePlayerMessageFrame {
  readonly type: "player_message";
  readonly protocol_version: typeof SERVER_BRIDGE_PROTOCOL_VERSION;
  readonly instance_id: string;
  readonly message_id: string;
  readonly player_uuid: string;
  readonly player_name: string;
  readonly content: string;
  readonly timestamp: string;
}

/** 解析成功的入站帧联合。 */
export type ServerBridgeInboundFrame =
  | ServerBridgeHelloFrame
  | ServerBridgeHeartbeatFrame
  | ServerBridgePlayerMessageFrame;

/** TS Core 回送的 ack（确认）帧。 */
export interface ServerBridgeAckFrame {
  readonly type: "ack";
  readonly ack_type: ServerBridgeInboundFrameType;
  readonly timestamp: string;
}

/** TS Core 回送的 error（错误）帧。 */
export interface ServerBridgeErrorFrame {
  readonly type: "error";
  readonly code: ServerBridgeErrorCode;
  readonly message: string;
  readonly timestamp: string;
}

/** 帧解析失败结果。 */
export interface ServerBridgeFrameParseFailure {
  readonly ok: false;
  readonly code: ServerBridgeErrorCode;
  readonly message: string;
}

/** 帧解析成功结果。 */
export interface ServerBridgeFrameParseSuccess {
  readonly ok: true;
  readonly frame: ServerBridgeInboundFrame;
}

/** 帧解析结果联合。 */
export type ServerBridgeFrameParseResult =
  | ServerBridgeFrameParseSuccess
  | ServerBridgeFrameParseFailure;

/**
 * 把原始字符串解析为入站帧。
 *
 * 失败统一以 ServerBridgeFrameParseFailure 返回，路由层据此选择 error 帧或断连，
 * 不允许向上抛异常（防止单条坏帧污染整个连接生命周期）。
 *
 * @param raw mod 端发送的文本帧
 * @returns 解析结果联合
 */
export function parseServerBridgeInboundFrame(raw: string): ServerBridgeFrameParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "frame is not valid JSON",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "invalid_json",
      message: "frame must be a JSON object",
    };
  }

  const record = parsed as Record<string, unknown>;
  const typeValue = record.type;

  if (typeof typeValue !== "string" || typeValue.length === 0) {
    return {
      ok: false,
      code: "missing_type",
      message: "frame.type must be a non-empty string",
    };
  }

  if (!isInboundFrameType(typeValue)) {
    return {
      ok: false,
      code: "unknown_type",
      message: `frame.type "${typeValue}" is not supported`,
    };
  }

  const protocolVersionValue = record.protocol_version;

  if (typeof protocolVersionValue !== "string" || protocolVersionValue.length === 0) {
    return {
      ok: false,
      code: "missing_field",
      message: "frame.protocol_version must be a non-empty string",
    };
  }

  if (protocolVersionValue !== SERVER_BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol_version_mismatch",
      message: `frame.protocol_version "${protocolVersionValue}" does not match "${SERVER_BRIDGE_PROTOCOL_VERSION}"`,
    };
  }

  switch (typeValue) {
    case "hello": {
      return readHelloFrame(record);
    }
    case "heartbeat": {
      return readHeartbeatFrame(record);
    }
    case "player_message": {
      return readPlayerMessageFrame(record);
    }
  }
}

/**
 * 创建 ack 回执帧。
 */
export function createServerBridgeAckFrame(input: {
  ackType: ServerBridgeInboundFrameType;
  timestamp: string;
}): ServerBridgeAckFrame {
  return Object.freeze({
    type: "ack",
    ack_type: input.ackType,
    timestamp: input.timestamp,
  });
}

/**
 * 创建 error 回执帧。
 */
export function createServerBridgeErrorFrame(input: {
  code: ServerBridgeErrorCode;
  message: string;
  timestamp: string;
}): ServerBridgeErrorFrame {
  return Object.freeze({
    type: "error",
    code: input.code,
    message: input.message,
    timestamp: input.timestamp,
  });
}

/**
 * 把入站帧转换为 ServerBridgeEventEnvelope。
 *
 * 采用 mod 端 instance_id 作为 bot_id 的占位值（observe_only 通道），
 * 事件类型形如 "server_bridge.hello" / "server_bridge.heartbeat" / "server_bridge.player_message"。
 */
export function createServerBridgeEnvelopeFromFrame(input: {
  frame: ServerBridgeInboundFrame;
  botId: string;
  eventId: string;
  receivedAt: string;
}): ServerBridgeEventEnvelope {
  const payload = buildEnvelopePayload(input.frame);

  return createServerBridgeEventEnvelope({
    bot_id: input.botId,
    event_id: input.eventId,
    event_type: `server_bridge.${input.frame.type}`,
    timestamp: input.receivedAt,
    payload,
  });
}

function isInboundFrameType(value: string): value is ServerBridgeInboundFrameType {
  return (SERVER_BRIDGE_INBOUND_FRAME_TYPES as readonly string[]).includes(value);
}

function readHelloFrame(record: Record<string, unknown>): ServerBridgeFrameParseResult {
  const modId = readNonEmptyString(record, "mod_id");
  if (!modId.ok) {
    return modId;
  }
  const modVersion = readNonEmptyString(record, "mod_version");
  if (!modVersion.ok) {
    return modVersion;
  }
  const connectedAt = readNonEmptyString(record, "connected_at");
  if (!connectedAt.ok) {
    return connectedAt;
  }
  const instanceId = readNonEmptyString(record, "instance_id");
  if (!instanceId.ok) {
    return instanceId;
  }

  return {
    ok: true,
    frame: Object.freeze({
      type: "hello",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      mod_id: modId.value,
      mod_version: modVersion.value,
      connected_at: connectedAt.value,
      instance_id: instanceId.value,
    }),
  };
}

function readHeartbeatFrame(record: Record<string, unknown>): ServerBridgeFrameParseResult {
  const instanceId = readNonEmptyString(record, "instance_id");
  if (!instanceId.ok) {
    return instanceId;
  }
  const sequence = readNonNegativeInteger(record, "sequence");
  if (!sequence.ok) {
    return sequence;
  }
  const timestamp = readNonEmptyString(record, "timestamp");
  if (!timestamp.ok) {
    return timestamp;
  }
  const state = readNonEmptyString(record, "state");
  if (!state.ok) {
    return state;
  }

  return {
    ok: true,
    frame: Object.freeze({
      type: "heartbeat",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      instance_id: instanceId.value,
      sequence: sequence.value,
      timestamp: timestamp.value,
      state: state.value,
    }),
  };
}

function readPlayerMessageFrame(record: Record<string, unknown>): ServerBridgeFrameParseResult {
  const instanceId = readNonEmptyString(record, "instance_id");
  if (!instanceId.ok) {
    return instanceId;
  }
  const messageId = readNonEmptyString(record, "message_id");
  if (!messageId.ok) {
    return messageId;
  }
  const playerUuid = readNonEmptyString(record, "player_uuid");
  if (!playerUuid.ok) {
    return playerUuid;
  }
  const playerName = readNonEmptyString(record, "player_name");
  if (!playerName.ok) {
    return playerName;
  }
  const content = readNonEmptyString(record, "content");
  if (!content.ok) {
    return content;
  }
  const timestamp = readNonEmptyString(record, "timestamp");
  if (!timestamp.ok) {
    return timestamp;
  }

  return {
    ok: true,
    frame: Object.freeze({
      type: "player_message",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      instance_id: instanceId.value,
      message_id: messageId.value,
      player_uuid: playerUuid.value,
      player_name: playerName.value,
      content: content.value,
      timestamp: timestamp.value,
    }),
  };
}

type ReadStringResult =
  | { readonly ok: true; readonly value: string }
  | ServerBridgeFrameParseFailure;

function readNonEmptyString(record: Record<string, unknown>, field: string): ReadStringResult {
  const value = record[field];

  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "missing_field",
      message: `frame.${field} is required`,
    };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      code: "invalid_field",
      message: `frame.${field} must be a string`,
    };
  }

  if (value.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_field",
      message: `frame.${field} must be a non-empty string`,
    };
  }

  return { ok: true, value };
}

type ReadIntegerResult =
  | { readonly ok: true; readonly value: number }
  | ServerBridgeFrameParseFailure;

function readNonNegativeInteger(record: Record<string, unknown>, field: string): ReadIntegerResult {
  const value = record[field];

  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "missing_field",
      message: `frame.${field} is required`,
    };
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      code: "invalid_field",
      message: `frame.${field} must be a non-negative integer`,
    };
  }

  return { ok: true, value };
}

function buildEnvelopePayload(frame: ServerBridgeInboundFrame): Readonly<Record<string, unknown>> {
  switch (frame.type) {
    case "hello": {
      return cloneReadonlyValue({
        protocol_version: frame.protocol_version,
        mod_id: frame.mod_id,
        mod_version: frame.mod_version,
        connected_at: frame.connected_at,
        instance_id: frame.instance_id,
      }) as Readonly<Record<string, unknown>>;
    }
    case "heartbeat": {
      return cloneReadonlyValue({
        protocol_version: frame.protocol_version,
        instance_id: frame.instance_id,
        sequence: frame.sequence,
        timestamp: frame.timestamp,
        state: frame.state,
      }) as Readonly<Record<string, unknown>>;
    }
    case "player_message": {
      return cloneReadonlyValue({
        protocol_version: frame.protocol_version,
        instance_id: frame.instance_id,
        message_id: frame.message_id,
        player_uuid: frame.player_uuid,
        player_name: frame.player_name,
        content: frame.content,
        timestamp: frame.timestamp,
      }) as Readonly<Record<string, unknown>>;
    }
  }
}
