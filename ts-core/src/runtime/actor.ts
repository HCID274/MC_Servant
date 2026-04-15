import type { ObservationRuntimeCache } from "../observation/runtime.js";
import {
  BotStatus,
  type ExternalAuthExecutionPlan,
  type ExternalAuthState,
  type RuntimeReadyGate,
  createExternalAuthExecutionPlan,
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
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的聊天写入记录。 */
  readonly chat_writes: readonly BotActorChatWriteRecord[];
}

/** BotActor（机器人执行代理） 聊天写入记录。 */
export type BotActorChatWriteRecord =
  | {
      /** 写入类型。 */
      readonly kind: "broadcast_reply";
      /** 原始消息标识。 */
      readonly message_id: string;
    }
  | {
      /** 写入类型。 */
      readonly kind: "external_auth_login";
    };

/** BotActor（机器人执行代理） 游戏聊天回复输入。 */
export interface BotActorBroadcastReplyInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 要写入 Minecraft（我的世界） 聊天频道的回复文本。 */
  readonly content: string;
}

/** BotActor（机器人执行代理） 最小运行时句柄。 */
export interface BotActorRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 启动 Mineflayer（Minecraft 协议客户端） 并按 ready（就绪） 门控推进状态。 */
  start(): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 通过 BotActor（机器人执行代理） 单写者入口向游戏聊天广播回复。 */
  broadcastReply(input: BotActorBroadcastReplyInput): Promise<BotActorRuntimeSnapshot<TBotId>>;
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
  let externalAuth = input.externalAuth;
  let externalAuthPlan = input.externalAuthPlan;
  let chatWriteInFlight: Promise<void> | null = null;
  const emittedEvents: RuntimeEventType[] = [];
  const chatWrites: BotActorChatWriteRecord[] = [];

  const createSnapshot = (): BotActorRuntimeSnapshot<TBotId> =>
    Object.freeze({
      bot_id: input.botId,
      status,
      transport: input.transport.getSnapshot(),
      ready_gate: createRuntimeReadyGate({
        status,
        externalAuth,
      }),
      external_auth_plan: externalAuthPlan,
      emitted_events: Object.freeze([...emittedEvents]),
      chat_writes: Object.freeze([...chatWrites]),
    });

  return Object.freeze({
    bot_id: input.botId,
    async start(): Promise<BotActorRuntimeSnapshot<TBotId>> {
      if (status !== BotStatus.INITIALIZING) {
        return createSnapshot();
      }

      await input.transport.connect();
      await sendExternalAuthLoginIfNeeded();
      const readyDecision = resolveTransition(status, {
        type: "ready",
        external_auth: externalAuth,
      });

      if (readyDecision.accepted) {
        status = readyDecision.to;
        emittedEvents.push(...readyDecision.emittedEvents);
      }

      return createSnapshot();
    },
    async broadcastReply(
      replyInput: BotActorBroadcastReplyInput,
    ): Promise<BotActorRuntimeSnapshot<TBotId>> {
      assertBroadcastReplyInput(replyInput);

      const readyGate = createRuntimeReadyGate({
        status,
        externalAuth,
      });

      if (!readyGate.ready) {
        throw new Error("BotActor is not ready for broadcastReply");
      }

      await runSerializedChatWrite(async () => {
        await input.transport.chat(replyInput.content);
        emittedEvents.push("chat.reply");
        chatWrites.push(
          Object.freeze({
            kind: "broadcast_reply",
            message_id: replyInput.message_id,
          }),
        );
      });

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

  async function sendExternalAuthLoginIfNeeded(): Promise<void> {
    if (
      externalAuth.status !== "pending" ||
      externalAuthPlan.status !== "pending" ||
      externalAuthPlan.next_action === null
    ) {
      return;
    }

    const nextAction = externalAuthPlan.next_action;

    try {
      await runSerializedChatWrite(async () => {
        await input.transport.chat(nextAction.command);
        emittedEvents.push("chat.reply");
        chatWrites.push(
          Object.freeze({
            kind: "external_auth_login",
          }),
        );
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not expose chat")) {
        return;
      }

      throw error;
    }

    externalAuth = Object.freeze({
      status: "authenticated" as const,
      required: true as const,
      entrypoint: "game_chat_command" as const,
      secret_source: externalAuth.secret_source,
      secret_reference: externalAuth.secret_reference,
    });
    externalAuthPlan = createExternalAuthExecutionPlan(externalAuth);
  }

  async function runSerializedChatWrite(write: () => Promise<void>): Promise<void> {
    if (chatWriteInFlight !== null) {
      throw new Error("BotActor chat write is already in flight");
    }

    const writePromise = write();
    chatWriteInFlight = writePromise;

    try {
      await writePromise;
    } finally {
      if (chatWriteInFlight === writePromise) {
        chatWriteInFlight = null;
      }
    }
  }
}

function assertBroadcastReplyInput(input: BotActorBroadcastReplyInput): void {
  if (input.message_id.trim().length === 0) {
    throw new Error("message_id must be a non-empty string");
  }

  if (input.content.trim().length === 0) {
    throw new Error("content must be a non-empty string");
  }
}
