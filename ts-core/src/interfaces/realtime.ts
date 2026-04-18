/**
 * 实时推送事件模型与转换。
 *
 * 1. 事件包装：定义 RealtimeEventEnvelope，将运行时的原子事件包装为适合 Socket.io 推送和补拉（Replay）的统一格式。
 * 2. 深度克隆：提供 cloneRealtimeValue，确保推送的载荷是完全解耦且不可变的，防止并发修改。
 * 3. 契约复用：复用 runtime/events.ts 中的事件类型定义，保证内部逻辑与外部接口的一致性。
 */

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

/**
 * 克隆实时事件载荷。
 */
function cloneRealtimePayload(
  payload: RuntimeEventLogEntry["payload"] | undefined,
): RuntimeEventLogEntry["payload"] | undefined {
  if (!payload) {
    return undefined;
  }

  return cloneRealtimeValue(payload);
}

/**
 * 递归深度克隆并冻结值。
 *
 * 数据隔离保障（Data Isolation Guard）：确保推送或同步的载荷是完全解耦且不可变的。
 *
 * 线程/闭包安全：防止由于并发消息推送或 Replay 过程中原始对象被意外修改导致的脏读或状态不一致。
 */
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

/**
 * 创建实时推送事件信封。
 *
 * 事件标准化包装（Event Standardized Wrapping）：将运行时的原始事件统一封装为适合推送和补拉的协议格式。
 *
 * 契约闭环：强制执行载荷的深克隆（Object.freeze），确保每一个推送到 Socket.io 或返回到补拉 API 的事件都是不可变的独立单元。
 *
 * @param input 包含序号、Bot ID、类型、时间戳、会话 ID 和可选载荷的输入
 * @returns 包装后的只读事件信封
 */
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

/**
 * 克隆实时推送事件。
 *
 * 引用切断：用于在补拉（Replay）等接口边界处彻底断开对原始对象的引用，确保输出数据的物理独立性。
 *
 * @param input 原始事件信封
 * @returns 克隆后的新信封
 */
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
