/**
 * 服务端桥接入口契约与事件封装。
 *
 * 架构职责：
 * 1. 非侵入式观测：定义 Server Bridge 入口，用于接收来自 Minecraft 插件或其他服务端组件的外部事件。
 * 2. 运行时影响约束：显式声明桥接事件仅用于“观测（observe_only）”，不直接触发 Bot 的状态写操作或任务调度。
 * 3. 载荷稳压：提供 `createServerBridgeEventEnvelope` 工厂函数，对桥接事件的元数据进行校验并对扩展载荷执行深度克隆。
 */

import { MessageSource } from "../../domain/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../../domain/invariants.js";
import { type InterfaceEventEnvelope, createInterfaceEventEnvelope } from "../contracts.js";

/** 服务端桥接入口固定使用的通道名。 */
export const SERVER_BRIDGE_CHANNEL = "server_bridge" as const;

/** 服务端桥接入口固定使用的来源。 */
export const SERVER_BRIDGE_SOURCE = MessageSource.ServerBridge;

/** 服务端桥接事件对运行时的固定影响集合。 */
export const SERVER_BRIDGE_RUNTIME_EFFECTS = ["observe_only"] as const;

/** 服务端桥接事件对运行时的固定影响联合类型。 */
export type ServerBridgeRuntimeEffect = (typeof SERVER_BRIDGE_RUNTIME_EFFECTS)[number];

/** 服务端桥接进入主线后的标准化事件包。 */
export interface ServerBridgeEventEnvelope
  extends InterfaceEventEnvelope<
    typeof SERVER_BRIDGE_SOURCE,
    typeof SERVER_BRIDGE_CHANNEL,
    string | null
  > {
  /** 桥接事件类型。 */
  readonly event_type: string;
  /** 明确声明该入口只提供事件，不直接形成 Bot 写操作。 */
  readonly runtime_effect: "observe_only";
  /** 事件扩展载荷。 */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * 克隆只读载荷。
 */
function cloneReadonlyPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return cloneReadonlyValue(payload) as Readonly<Record<string, unknown>>;
}

/**
 * 创建服务端桥接事件包。
 *
 * 架构职责：
 * 1. 外部事件适配（External Event Adaptation）：将来自外部插件或系统的非结构化事件转化为接口层标准的事件信封。
 *
 * 架构意图：
 * 1. 观测语义保障：显式通过 runtime_effect: "observe_only" 声明该入口仅用于数据观测，不具备触发核心逻辑状态写操作的权限，从而在接口层建立一道安全防线。
 *
 * @param input 包含 Bot ID, 事件 ID, 事件类型, 时间戳及可选载荷的输入
 * @returns 标准化的只读桥接事件包
 */
export function createServerBridgeEventEnvelope(input: {
  bot_id: string;
  owner_id?: string | null;
  event_id: string;
  event_type: string;
  timestamp: string;
  payload?: Readonly<Record<string, unknown>>;
}): ServerBridgeEventEnvelope {
  assertNonEmptyString(input.event_type, "event_type");

  const payload = cloneReadonlyPayload(input.payload);

  return Object.freeze({
    ...createInterfaceEventEnvelope({
      bot_id: input.bot_id,
      owner_id: input.owner_id ?? null,
      event_id: input.event_id,
      source: SERVER_BRIDGE_SOURCE,
      channel: SERVER_BRIDGE_CHANNEL,
      timestamp: input.timestamp,
    }),
    event_type: input.event_type,
    runtime_effect: "observe_only",
    ...(payload === undefined ? {} : { payload }),
  });
}
