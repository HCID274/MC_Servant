import type { RuntimeEventLogEntry, RuntimeEventType } from "../runtime/events.js";

/** 实时推送事件结构，用于统一 Socket.io（实时推送） 与 replay（补拉） 的事件载荷。 */
export interface RealtimeEventEnvelope<TType extends RuntimeEventType = RuntimeEventType> {
  /** 事件序号。 */
  readonly seq: number;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 事件类型。 */
  readonly type: TType;
  /** 事件创建时间。 */
  readonly created_at: string;
  /** 关联会话标识。 */
  readonly session_id?: string;
  /** 事件扩展载荷。 */
  readonly payload?: RuntimeEventLogEntry["payload"];
}

function cloneRealtimePayload(
  payload: RuntimeEventLogEntry["payload"] | undefined,
): RuntimeEventLogEntry["payload"] | undefined {
  if (!payload) {
    return undefined;
  }

  return cloneRealtimeValue(payload);
}

function cloneRealtimeValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneRealtimeValue(item))) as TValue;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      cloneRealtimeValue(entryValue),
    ]);

    return Object.freeze(Object.fromEntries(entries)) as TValue;
  }

  return value;
}

/** 创建实时推送事件，用于复用 runtime/events.ts（运行时事件） 的同名类型集合。 */
export function createRealtimeEventEnvelope<TType extends RuntimeEventType>(input: {
  seq: number;
  botId: string;
  type: TType;
  createdAt: string;
  sessionId?: string;
  payload?: RuntimeEventLogEntry["payload"];
}): RealtimeEventEnvelope<TType> {
  return Object.freeze({
    seq: input.seq,
    bot_id: input.botId,
    type: input.type,
    created_at: input.createdAt,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.payload ? { payload: cloneRealtimePayload(input.payload) } : {}),
  });
}

/** 克隆实时推送事件，用于在 replay（补拉） 等接口边界内切断调用方对象引用。 */
export function cloneRealtimeEventEnvelope<TType extends RuntimeEventType>(
  input: RealtimeEventEnvelope<TType>,
): RealtimeEventEnvelope<TType> {
  return createRealtimeEventEnvelope({
    seq: input.seq,
    botId: input.bot_id,
    type: input.type,
    createdAt: input.created_at,
    ...(input.session_id ? { sessionId: input.session_id } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
  });
}
