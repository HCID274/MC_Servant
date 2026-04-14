import { assertNonEmptyString } from "../domain/invariants.js";
import type { InterfaceBotStatusSnapshot } from "./contracts.js";
import { createInterfaceBotStatusSnapshot } from "./contracts.js";
import { type RealtimeEventEnvelope, cloneRealtimeEventEnvelope } from "./realtime.js";

const DEFAULT_REPLAY_LIMIT = 50;
const MIN_REPLAY_LIMIT = 1;

/** HTTP（超文本传输协议） 方法集合，用于描述接口层的最小路由元信息。 */
export const API_METHODS = ["GET", "POST"] as const;

/** HTTP（超文本传输协议） 方法联合类型。 */
export type ApiMethod = (typeof API_METHODS)[number];

/** 接口层路由名集合，用于收敛 Phase 1 的最小 HTTP（超文本传输协议） 入口。 */
export const API_ROUTE_NAMES = ["health", "status", "message", "replay"] as const;

/** 接口层路由名联合类型。 */
export type ApiRouteName = (typeof API_ROUTE_NAMES)[number];

/** 路由鉴权模式集合，用于区分公开接口与会话保护接口。 */
export const API_AUTH_MODES = ["none", "session"] as const;

/** 路由鉴权模式联合类型。 */
export type ApiAuthMode = (typeof API_AUTH_MODES)[number];

/** HTTP（超文本传输协议） 路由定义结构，用于声明接口层最小入口边界。 */
export interface ApiRouteDefinition<TName extends ApiRouteName = ApiRouteName> {
  /** 路由名。 */
  readonly name: TName;
  /** 路由方法。 */
  readonly method: ApiMethod;
  /** 路由路径。 */
  readonly path: string;
  /** 鉴权模式。 */
  readonly auth: ApiAuthMode;
}

/** 状态查询请求结构，用于描述 GET /api/status 的查询参数。 */
export interface StatusQuery {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
}

/** 状态查询响应结构，用于返回当前 Bot 状态快照。 */
export interface StatusResponse {
  /** 当前 Bot 状态。 */
  readonly bot: InterfaceBotStatusSnapshot;
}

/** replay（补拉） 请求结构，用于描述 GET /api/replay 的查询参数。 */
export interface ReplayRequest {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 最近已见事件序号。 */
  readonly after_seq: number;
  /** 期望返回条数。 */
  readonly limit: number;
}

/** replay（补拉） 响应结构，用于返回当前状态快照与事件批次。 */
export interface ReplayResponse {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 最近已见事件序号。 */
  readonly after_seq: number;
  /** 实际使用的补拉上限。 */
  readonly limit: number;
  /** 当前状态快照。 */
  readonly state: InterfaceBotStatusSnapshot;
  /** 事件列表。 */
  readonly events: readonly RealtimeEventEnvelope[];
}

/** 接口层最小路由清单，用于声明不含真实网络 I/O（输入输出） 的 HTTP（超文本传输协议） 入口。 */
export const API_ROUTE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "health",
    method: "GET",
    path: "/api/health",
    auth: "none",
  }),
  Object.freeze({
    name: "status",
    method: "GET",
    path: "/api/status",
    auth: "session",
  }),
  Object.freeze({
    name: "message",
    method: "POST",
    path: "/api/message",
    auth: "session",
  }),
  Object.freeze({
    name: "replay",
    method: "GET",
    path: "/api/replay",
    auth: "session",
  }),
] as const satisfies readonly ApiRouteDefinition[]);

/** 读取指定路由定义，用于在纯函数层复用固定接口元信息。 */
export function getApiRouteDefinition<TName extends ApiRouteName>(
  name: TName,
): Extract<(typeof API_ROUTE_DEFINITIONS)[number], { readonly name: TName }> {
  const routeDefinition = API_ROUTE_DEFINITIONS.find((route) => route.name === name);

  if (!routeDefinition) {
    throw new Error(`Unknown API route: ${name}`);
  }

  return routeDefinition as Extract<
    (typeof API_ROUTE_DEFINITIONS)[number],
    { readonly name: TName }
  >;
}

/** 创建状态查询请求，用于标准化 GET /api/status 的查询参数。 */
export function createStatusQuery(botId: string): StatusQuery {
  return Object.freeze({ bot_id: botId });
}

/** 创建状态查询响应，用于返回只读状态快照。 */
export function createStatusResponse(input: {
  bot: InterfaceBotStatusSnapshot;
}): StatusResponse {
  return Object.freeze({
    bot: createInterfaceBotStatusSnapshot(input.bot),
  });
}

/** 归一化 replay（补拉） 条数，用于落实文档中的默认 50 条边界。 */
export function normalizeReplayLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_REPLAY_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < MIN_REPLAY_LIMIT) {
    throw new Error("replay limit must be a positive integer");
  }

  return Math.min(limit, DEFAULT_REPLAY_LIMIT);
}

/** 创建 replay（补拉） 请求，用于标准化 GET /api/replay 的查询参数。 */
export function createReplayRequest(input: {
  botId: string;
  afterSeq: number;
  limit?: number;
}): ReplayRequest {
  assertNonEmptyString(input.botId, "botId");

  if (!Number.isInteger(input.afterSeq) || input.afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative integer");
  }

  return Object.freeze({
    bot_id: input.botId,
    after_seq: input.afterSeq,
    limit: normalizeReplayLimit(input.limit),
  });
}

/** 选择符合 replay（补拉） 语义的事件批次。 */
export function selectReplayEvents(input: {
  request: ReplayRequest;
  events: readonly RealtimeEventEnvelope[];
}): readonly RealtimeEventEnvelope[] {
  const selectedEvents = input.events
    .filter((event) => event.bot_id === input.request.bot_id && event.seq > input.request.after_seq)
    .sort((left, right) => left.seq - right.seq)
    .slice(0, input.request.limit)
    .map((event) => cloneRealtimeEventEnvelope(event));

  return Object.freeze(selectedEvents);
}

/** 创建 replay（补拉） 响应，用于返回状态快照与事件列表的只读组合。 */
export function createReplayResponse(input: {
  request: ReplayRequest;
  state: InterfaceBotStatusSnapshot;
  events: readonly RealtimeEventEnvelope[];
}): ReplayResponse {
  if (input.state.bot_id !== input.request.bot_id) {
    throw new Error("replay state bot_id must match request.bot_id");
  }

  const events = selectReplayEvents({
    request: input.request,
    events: input.events,
  });

  return Object.freeze({
    bot_id: input.request.bot_id,
    after_seq: input.request.after_seq,
    limit: input.request.limit,
    state: createInterfaceBotStatusSnapshot(input.state),
    events,
  });
}
