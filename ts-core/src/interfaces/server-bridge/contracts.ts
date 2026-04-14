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

function cloneReadonlyPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (payload === undefined) {
    return undefined;
  }

  return cloneReadonlyValue(payload) as Readonly<Record<string, unknown>>;
}

/** 创建服务端桥接事件包，用于收口插件 / 桥接侧进入主线的只读事件边界。 */
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
