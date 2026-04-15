/**
 * 接口层契约与基础转换。
 * 
 * 架构职责：
 * 1. 鉴权契约：定义 Session、Token 校验逻辑及登录响应结构。
 * 2. 入口（Ingress）适配：提供标准化的 Envelope 工厂，将不同来源（Web, Game, Bridge）的消息和事件统一收口。
 * 3. 状态投影：定义 Bot 状态、外部认证状态和健康检查的对外公开快照结构。
 * 4. 安全校验：实现 Session 与 Bot ID 的绑定校验，防止跨 Bot 的非法操作。
 */

import { MessageSource } from "../domain/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import {
  type BotStatus,
  type ExternalAuthState,
  createExternalAuthPublicState,
  createRuntimeReadyGate,
} from "../runtime/contracts.js";

const SESSION_TTL_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const HEALTH_SERVICE_NAME = "ts-core" as const;
const HEALTH_STATUS_OK = "ok" as const;

/** 会话 token（令牌） 的默认有效期毫秒数。 */
export const SESSION_TOKEN_TTL_MS = SESSION_TTL_DAYS * MILLISECONDS_PER_DAY;

/** 网页端消息在接口层固定使用的通道名。 */
export const WEB_MESSAGE_CHANNEL = "web" as const;

/** 网页端消息在接口层固定使用的来源。 */
export const WEB_MESSAGE_SOURCE = MessageSource.Web;

/** 接口层统一入口通道集合。 */
export const INTERFACE_INGRESS_CHANNELS = [
  WEB_MESSAGE_CHANNEL,
  "game_chat",
  "server_bridge",
] as const;

/** 接口层统一入口通道联合类型。 */
export type InterfaceIngressChannel = (typeof INTERFACE_INGRESS_CHANNELS)[number];

/** 接口层统一主人标识缺席语义，`null` 表示当前入口没有主人上下文。 */
export type InterfaceOwnerId = string | null;

/** 接口层统一会话标识缺席语义，`null` 表示当前入口不经过网页登录会话。 */
export type InterfaceSessionId = string | null;

/** 登录请求结构，用于承载轻身份模式下的账号密码登录输入。 */
export interface SessionLoginRequest {
  /** 用户名。 */
  readonly username: string;
  /** 密码明文。 */
  readonly password: string;
  /** 当前登录目标 Bot 标识。 */
  readonly bot_id: string;
}

/** 会话记录结构，用于投影 sessions（会话） 表的最小字段集合。 */
export interface SessionRecord {
  /** 会话标识。 */
  readonly id: string;
  /** 主人标识。 */
  readonly owner_id: string;
  /** Bot 标识。 */
  readonly bot_id: string;
  /** 登录 token（令牌）。 */
  readonly token: string;
  /** 过期时间。 */
  readonly expires_at: string;
  /** 创建时间。 */
  readonly created_at: string;
}

/** 登录成功响应结构，用于返回新建会话的最小鉴权信息。 */
export interface SessionLoginResponse {
  /** 会话标识。 */
  readonly session_id: string;
  /** 主人标识。 */
  readonly owner_id: string;
  /** Bot 标识。 */
  readonly bot_id: string;
  /** 登录 token（令牌）。 */
  readonly token: string;
  /** 过期时间。 */
  readonly expires_at: string;
}

/** 会话鉴权输入结构，用于统一承载 Bearer token（令牌） 边界。 */
export interface SessionAuthorization {
  /** 请求中携带的 token（令牌）。 */
  readonly token: string;
}

/** 会话鉴权状态集合，用于描述 token（令牌） 校验结果。 */
export const SESSION_VALIDATION_STATUSES = [
  "valid",
  "missing",
  "expired",
  "bot_mismatch",
  "token_mismatch",
] as const;

/** 会话鉴权状态联合类型。 */
export type SessionValidationStatus = (typeof SESSION_VALIDATION_STATUSES)[number];

/** 会话鉴权结果结构，用于输出纯函数鉴权判定。 */
export type SessionValidationResult =
  | {
      /** 鉴权结果状态。 */
      readonly status: "valid";
      /** 校验通过的会话记录。 */
      readonly session: SessionRecord;
    }
  | {
      /** 鉴权结果状态。 */
      readonly status: Exclude<SessionValidationStatus, "valid">;
    };

/** 网页端消息提交请求结构，用于描述 POST /api/message 的请求体。 */
export interface MessageSubmissionRequest {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 全局唯一消息标识。 */
  readonly message_id: string;
  /** 用户输入文本。 */
  readonly content: string;
}

/** 网页端标准化消息结构，用于把 HTTP（超文本传输协议） 输入投影成统一消息事件。 */
export type WebMessageEnvelope = InterfaceMessageEnvelope<
  typeof WEB_MESSAGE_SOURCE,
  typeof WEB_MESSAGE_CHANNEL,
  string,
  string
>;

/** 接口层统一消息包结构，用于收口所有文本入口的关键字段命名。 */
export interface InterfaceMessageEnvelope<
  TSource extends MessageSource = MessageSource,
  TChannel extends InterfaceIngressChannel = InterfaceIngressChannel,
  TOwnerId extends InterfaceOwnerId = InterfaceOwnerId,
  TSessionId extends InterfaceSessionId = InterfaceSessionId,
> {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 主人标识；`null` 表示当前入口没有主人上下文。 */
  readonly owner_id: TOwnerId;
  /** 会话标识；`null` 表示当前入口不经过网页登录会话。 */
  readonly session_id: TSessionId;
  /** 全局唯一消息标识。 */
  readonly message_id: string;
  /** 文本内容。 */
  readonly content: string;
  /** 消息来源。 */
  readonly source: TSource;
  /** 消息通道。 */
  readonly channel: TChannel;
  /** 标准化完成时间。 */
  readonly timestamp: string;
}

/** 接口层统一事件包结构，用于收口非文本入口的关键字段命名。 */
export interface InterfaceEventEnvelope<
  TSource extends MessageSource = MessageSource,
  TChannel extends InterfaceIngressChannel = InterfaceIngressChannel,
  TOwnerId extends InterfaceOwnerId = InterfaceOwnerId,
> {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 主人标识；`null` 表示当前事件没有主人上下文。 */
  readonly owner_id: TOwnerId;
  /** 全局唯一事件标识。 */
  readonly event_id: string;
  /** 事件来源。 */
  readonly source: TSource;
  /** 事件通道。 */
  readonly channel: TChannel;
  /** 标准化完成时间。 */
  readonly timestamp: string;
}

/** 消息入队响应结构，用于描述 HTTP（超文本传输协议） 入口的立即返回结果。 */
export interface MessageAcceptedResponse {
  /** 是否已被接受。 */
  readonly accepted: true;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 入队任务标识。 */
  readonly job_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 入队时间。 */
  readonly queued_at: string;
}

/** 接口层状态快照结构，用于描述 GET /api/status 与 replay（补拉） 返回的 Bot 当前状态。 */
export interface InterfaceBotStatusSnapshot {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 当前运行时状态。 */
  readonly status: BotStatus;
  /** 当前意图纪元。 */
  readonly intent_epoch: number;
  /** 最新事件序号。 */
  readonly last_event_seq: number;
  /** 最近更新时间。 */
  readonly updated_at: string;
  /** 当前活跃任务标识。 */
  readonly active_task_id?: string;
}

/** 接口层外部认证快照，用于输出脱敏认证状态与 ready（就绪） 门控。 */
export interface InterfaceExternalAuthSnapshot {
  /** 脱敏后的认证状态。 */
  readonly state: ReturnType<typeof createExternalAuthPublicState>;
  /** 当前 ready（就绪） 门控结果。 */
  readonly ready_gate: ReturnType<typeof createRuntimeReadyGate>;
}

/** 健康检查响应结构，用于描述 GET /api/health 的纯输出。 */
export interface HealthResponse {
  /** 当前服务名。 */
  readonly service: typeof HEALTH_SERVICE_NAME;
  /** 健康状态。 */
  readonly status: typeof HEALTH_STATUS_OK;
  /** 响应时间。 */
  readonly timestamp: string;
}

function cloneSessionRecord(input: SessionRecord): SessionRecord {
  return {
    id: input.id,
    owner_id: input.owner_id,
    bot_id: input.bot_id,
    token: input.token,
    expires_at: input.expires_at,
    created_at: input.created_at,
  };
}

function assertSessionBotBinding(input: {
  requestBotId: string;
  sessionBotId: string;
}): void {
  if (input.requestBotId !== input.sessionBotId) {
    throw new Error(
      `Message submission bot_id mismatch: request=${input.requestBotId}, session=${input.sessionBotId}`,
    );
  }
}

/** 创建只读会话记录，用于统一 sessions（会话） 表投影。 */
export function createSessionRecord(input: SessionRecord): SessionRecord {
  return Object.freeze(cloneSessionRecord(input));
}

/**
 * 创建接口层统一消息包。
 * 
 * 架构意图：
 * 作为一个“收口点”，它将不同接入方式（如 Web 登录、游戏内直接触发）的元数据
 * 转化为系统内部一致的消息信封结构。它强制要求 bot_id, message_id 等核心字段的非空校验。
 * 
 * @param input 消息包核心字段输入
 * @returns 经过校验和克隆的只读消息信封
 */
export function createInterfaceMessageEnvelope<
  TSource extends MessageSource,
  TChannel extends InterfaceIngressChannel,
  TOwnerId extends InterfaceOwnerId,
  TSessionId extends InterfaceSessionId,
>(input: {
  bot_id: string;
  owner_id: TOwnerId;
  session_id: TSessionId;
  message_id: string;
  content: string;
  source: TSource;
  channel: TChannel;
  timestamp: string;
}): InterfaceMessageEnvelope<TSource, TChannel, TOwnerId, TSessionId> {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.content, "content");
  assertNonEmptyString(input.timestamp, "timestamp");

  return Object.freeze({
    bot_id: input.bot_id,
    owner_id: input.owner_id,
    session_id: input.session_id,
    message_id: input.message_id,
    content: input.content,
    source: input.source,
    channel: input.channel,
    timestamp: input.timestamp,
  });
}

/**
 * 创建接口层统一事件包。
 * 
 * 架构意图：
 * 专门用于承载服务端桥接（Server Bridge）等非文本输入的事件，
 * 与 createInterfaceMessageEnvelope 共享相似的元数据校验逻辑。
 * 
 * @param input 事件包核心字段输入
 * @returns 经过校验和克隆的只读事件信封
 */
export function createInterfaceEventEnvelope<
  TSource extends MessageSource,
  TChannel extends InterfaceIngressChannel,
  TOwnerId extends InterfaceOwnerId,
>(input: {
  bot_id: string;
  owner_id: TOwnerId;
  event_id: string;
  source: TSource;
  channel: TChannel;
  timestamp: string;
}): InterfaceEventEnvelope<TSource, TChannel, TOwnerId> {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.event_id, "event_id");
  assertNonEmptyString(input.timestamp, "timestamp");

  return Object.freeze({
    bot_id: input.bot_id,
    owner_id: input.owner_id,
    event_id: input.event_id,
    source: input.source,
    channel: input.channel,
    timestamp: input.timestamp,
  });
}

/** 创建登录成功响应，用于输出最小会话鉴权结果。 */
export function createSessionLoginResponse(input: SessionRecord): SessionLoginResponse {
  return Object.freeze({
    session_id: input.id,
    owner_id: input.owner_id,
    bot_id: input.bot_id,
    token: input.token,
    expires_at: input.expires_at,
  });
}

/** 创建会话鉴权输入，用于标准化 token（令牌） 透传边界。 */
export function createSessionAuthorization(token: string): SessionAuthorization {
  return Object.freeze({ token });
}

/** 从 Authorization（鉴权） 请求头中提取 Bearer token（令牌）。 */
export function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.trim().split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

/** 判断会话是否过期，用于实现 7 天 token（令牌） 有效期规则。 */
export function isSessionExpired(input: { expiresAt: string; now: string }): boolean {
  return Date.parse(input.expiresAt) <= Date.parse(input.now);
}

/**
 * 校验会话鉴权输入。
 * 
 * 架构意图：
 * 实现核心的鉴权逻辑判定：
 * 1. 完整性：必须同时提供 Authorization 和 Session 记录。
 * 2. 匹配性：Token 和 Bot ID 必须与 Session 记录严格对齐。
 * 3. 时效性：校验 Session 是否已过期。
 * 它是一个纯函数，返回结构化的 SessionValidationResult。
 * 
 * @param input 包含鉴权输入、Session 记录及上下文信息的输入
 * @returns 判定结果
 */
export function validateSessionAuthorization(input: {
  authorization: SessionAuthorization | null;
  session: SessionRecord | null;
  botId: string;
  now: string;
}): SessionValidationResult {
  if (!input.authorization || !input.session) {
    return Object.freeze({ status: "missing" });
  }

  if (input.authorization.token !== input.session.token) {
    return Object.freeze({ status: "token_mismatch" });
  }

  if (input.session.bot_id !== input.botId) {
    return Object.freeze({ status: "bot_mismatch" });
  }

  if (isSessionExpired({ expiresAt: input.session.expires_at, now: input.now })) {
    return Object.freeze({ status: "expired" });
  }

  return Object.freeze({
    status: "valid",
    session: createSessionRecord(input.session),
  });
}

/**
 * 创建网页端标准化消息。
 * 
 * 架构意图：
 * 封装 Web 提交逻辑。在创建信封前，它会额外执行 assertSessionBotBinding 校验，
 * 确保提交请求中的 bot_id 与当前会话绑定的 bot_id 严格一致。
 * 
 * @param input 包含请求内容、Session 和创建时间戳的输入
 * @returns 格式化后的网页端消息信封
 */
export function createWebMessageEnvelope(input: {
  request: MessageSubmissionRequest;
  session: SessionRecord;
  createdAt: string;
}): WebMessageEnvelope {
  assertSessionBotBinding({
    requestBotId: input.request.bot_id,
    sessionBotId: input.session.bot_id,
  });

  return createInterfaceMessageEnvelope({
    bot_id: input.session.bot_id,
    owner_id: input.session.owner_id,
    session_id: input.session.id,
    message_id: input.request.message_id,
    content: input.request.content,
    source: WEB_MESSAGE_SOURCE,
    channel: WEB_MESSAGE_CHANNEL,
    timestamp: input.createdAt,
  });
}

/** 创建消息入队响应，用于表达 HTTP（超文本传输协议） 入口的 202 风格结果。 */
export function createMessageAcceptedResponse(input: {
  botId: string;
  jobId: string;
  messageId: string;
  queuedAt: string;
}): MessageAcceptedResponse {
  return Object.freeze({
    accepted: true,
    bot_id: input.botId,
    job_id: input.jobId,
    message_id: input.messageId,
    queued_at: input.queuedAt,
  });
}

/** 创建接口层状态快照，用于统一状态查询与 replay（补拉） 的状态载荷。 */
export function createInterfaceBotStatusSnapshot(
  input: InterfaceBotStatusSnapshot,
): InterfaceBotStatusSnapshot {
  return Object.freeze({
    bot_id: input.bot_id,
    status: input.status,
    intent_epoch: input.intent_epoch,
    last_event_seq: input.last_event_seq,
    updated_at: input.updated_at,
    ...(input.active_task_id ? { active_task_id: input.active_task_id } : {}),
  });
}

/**
 * 创建接口层外部认证快照。
 * 
 * 架构意图：
 * 它是对外暴露认证状态的聚合工厂。它不仅包含脱敏后的 PublicState，
 * 还集成了 ready_gate 判定逻辑，用于告知外部客户端当前 Bot 是否已满足进入服务态的前提。
 * 
 * @param input 包含 Bot 运行时状态和认证状态的输入
 * @returns 对外公开的认证与就绪快照
 */
export function createInterfaceExternalAuthSnapshot(input: {
  status: BotStatus;
  external_auth: ExternalAuthState;
}): InterfaceExternalAuthSnapshot {
  return cloneReadonlyValue({
    state: createExternalAuthPublicState(input.external_auth),
    ready_gate: createRuntimeReadyGate({
      status: input.status,
      externalAuth: input.external_auth,
    }),
  });
}

/** 创建健康检查响应，用于返回最小无副作用健康状态。 */
export function createHealthResponse(timestamp: string): HealthResponse {
  return Object.freeze({
    service: HEALTH_SERVICE_NAME,
    status: HEALTH_STATUS_OK,
    timestamp,
  });
}
