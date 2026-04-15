import type { ObservationRuntimeCache } from "../observation/runtime.js";
import {
  BotStatus,
  type ExternalAuthExecutionPlan,
  type ExternalAuthState,
  type RuntimeReadyGate,
  createRuntimeReadyGate,
} from "./contracts.js";
import type { RuntimeEventType } from "./events.js";
import { resolveTransition } from "./state-machine.js";
import type { MineflayerRuntimeTransport, MineflayerTransportSnapshot } from "./transport.js";

/** BotActor（机器人执行代理） 最小运行时快照。 */
export interface BotActorRuntimeSnapshot<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 当前 BotActor（机器人执行代理） 状态。 */
  readonly status: BotStatus;
  /** Mineflayer（Minecraft 协议客户端） 传输快照。 */
  readonly transport: MineflayerTransportSnapshot<TBotId>;
  /** 当前 ready（就绪） 门控。 */
  readonly ready_gate: RuntimeReadyGate;
  /** 外部认证执行计划。 */
  readonly external_auth_plan: ExternalAuthExecutionPlan;
  /** 本轮生命周期已产出的运行时事件类型。 */
  readonly emitted_events: readonly RuntimeEventType[];
}

/** BotActor（机器人执行代理） 最小运行时句柄。 */
export interface BotActorRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 启动 Mineflayer（Minecraft 协议客户端） 并按 ready（就绪） 门控推进状态。 */
  start(): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 将 BotActor（机器人执行代理） 切换到 SHUTDOWN（关闭） 状态。 */
  shutdown(): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 获取当前运行时快照。 */
  getSnapshot(): BotActorRuntimeSnapshot<TBotId>;
}

/** 创建 BotActor（机器人执行代理） 最小生命周期运行时。 */
export function createBotActorRuntime<TBotId extends string>(input: {
  botId: TBotId;
  transport: MineflayerRuntimeTransport<TBotId>;
  observation: ObservationRuntimeCache;
  externalAuth: ExternalAuthState;
  externalAuthPlan: ExternalAuthExecutionPlan;
}): BotActorRuntime<TBotId> {
  let status = BotStatus.INITIALIZING;
  const emittedEvents: RuntimeEventType[] = [];

  const createSnapshot = (): BotActorRuntimeSnapshot<TBotId> =>
    Object.freeze({
      bot_id: input.botId,
      status,
      transport: input.transport.getSnapshot(),
      ready_gate: createRuntimeReadyGate({
        status,
        externalAuth: input.externalAuth,
      }),
      external_auth_plan: input.externalAuthPlan,
      emitted_events: Object.freeze([...emittedEvents]),
    });

  return Object.freeze({
    bot_id: input.botId,
    async start(): Promise<BotActorRuntimeSnapshot<TBotId>> {
      if (status !== BotStatus.INITIALIZING) {
        return createSnapshot();
      }

      await input.transport.connect();
      const readyDecision = resolveTransition(status, {
        type: "ready",
        external_auth: input.externalAuth,
      });

      if (readyDecision.accepted) {
        status = readyDecision.to;
        emittedEvents.push(...readyDecision.emittedEvents);
      }

      return createSnapshot();
    },
    async shutdown(): Promise<BotActorRuntimeSnapshot<TBotId>> {
      const shutdownDecision = resolveTransition(status, {
        type: "shutdown_requested",
      });

      if (shutdownDecision.accepted) {
        status = shutdownDecision.to;
        emittedEvents.push(...shutdownDecision.emittedEvents);
      }

      return createSnapshot();
    },
    getSnapshot(): BotActorRuntimeSnapshot<TBotId> {
      void input.observation;
      return createSnapshot();
    },
  });
}
