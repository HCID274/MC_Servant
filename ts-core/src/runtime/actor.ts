import type { ObservationRuntimeCache } from "../observation/runtime.js";
import {
  type SkillExecutionDependencies,
  type SkillExecutionResult,
  executeSkillCallJob,
} from "../skills/index.js";
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
import type { SkillCallJob } from "./tasking.js";
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
  /** 当前外部认证真实状态；运行期查询以 BotActor（机器人执行代理） 快照为准。 */
  readonly external_auth: ExternalAuthState;
  /** 外部认证执行计划。 */
  readonly external_auth_plan: ExternalAuthExecutionPlan;
  /** 本轮生命周期已产出的运行时事件类型。 */
  readonly emitted_events: readonly RuntimeEventType[];
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的聊天写入记录。 */
  readonly chat_writes: readonly BotActorChatWriteRecord[];
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的技能执行记录。 */
  readonly skill_executions: readonly BotActorSkillExecutionRecord[];
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

/** BotActor（机器人执行代理） 技能执行记录。 */
export interface BotActorSkillExecutionRecord {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 已执行技能名。 */
  readonly skill: SkillCallJob["skill"];
}

/** BotActor（机器人执行代理） 技能执行输出。 */
export interface BotActorSkillExecutionOutcome<TBotId extends string = string> {
  /** 技能执行结果。 */
  readonly result: SkillExecutionResult;
  /** 执行后的运行时快照。 */
  readonly snapshot: BotActorRuntimeSnapshot<TBotId>;
}

/** BotActor（机器人执行代理） 最小运行时句柄。 */
export interface BotActorRuntime<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 启动 Mineflayer（Minecraft 协议客户端） 并按 ready（就绪） 门控推进状态。 */
  start(): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 通过 BotActor（机器人执行代理） 单写者入口向游戏聊天广播回复。 */
  broadcastReply(input: BotActorBroadcastReplyInput): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 通过 BotActor（机器人执行代理） 单写者入口执行技能调用任务。 */
  executeSkill(job: SkillCallJob): Promise<BotActorSkillExecutionOutcome<TBotId>>;
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
  skillExecution?: SkillExecutionDependencies;
}): BotActorRuntime<TBotId> {
  let status = BotStatus.INITIALIZING;
  let externalAuth = input.externalAuth;
  let externalAuthPlan = input.externalAuthPlan;
  let chatWriteInFlight: Promise<void> | null = null;
  const emittedEvents: RuntimeEventType[] = [];
  const chatWrites: BotActorChatWriteRecord[] = [];
  const skillExecutions: BotActorSkillExecutionRecord[] = [];
  const skillExecution = input.skillExecution ?? {
    goToMovement: input.transport,
  };

  const createSnapshot = (): BotActorRuntimeSnapshot<TBotId> =>
    Object.freeze({
      bot_id: input.botId,
      status,
      transport: input.transport.getSnapshot(),
      ready_gate: createRuntimeReadyGate({
        status,
        externalAuth,
      }),
      external_auth: externalAuth,
      external_auth_plan: externalAuthPlan,
      emitted_events: Object.freeze([...emittedEvents]),
      chat_writes: Object.freeze([...chatWrites]),
      skill_executions: Object.freeze([...skillExecutions]),
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
    async executeSkill(job: SkillCallJob): Promise<BotActorSkillExecutionOutcome<TBotId>> {
      const transportSnapshot = input.transport.getSnapshot();
      const readyGate = createRuntimeReadyGate({
        status,
        externalAuth,
      });

      if (!readyGate.ready) {
        throw new Error("BotActor is not ready for executeSkill");
      }

      if (!transportSnapshot.world_ready) {
        throw new Error("BotActor world interaction is not ready for executeSkill");
      }

      const startDecision = resolveTransition(status, {
        type: "exec_job_pulled",
        epoch_fresh: true,
        snapshot_fresh: true,
      });

      if (!startDecision.accepted) {
        throw new Error(`BotActor cannot execute skill while ${status}`);
      }

      status = startDecision.to;
      emittedEvents.push(...startDecision.emittedEvents);

      try {
        const result = await executeSkillCallJob({
          job,
          dependencies: skillExecution,
        });
        const completedDecision = resolveTransition(status, {
          type: "task_completed",
        });

        if (completedDecision.accepted) {
          status = completedDecision.to;
          emittedEvents.push(...completedDecision.emittedEvents);
        }

        skillExecutions.push(
          Object.freeze({
            message_id: job.message_id,
            skill: job.skill,
          }),
        );

        return Object.freeze({
          result,
          snapshot: createSnapshot(),
        });
      } catch (error) {
        const failedDecision = resolveTransition(status, {
          type: "task_failed",
        });

        if (failedDecision.accepted) {
          status = failedDecision.to;
          emittedEvents.push(...failedDecision.emittedEvents);
        }

        throw error;
      }
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

    await runSerializedChatWrite(async () => {
      await input.transport.chat(nextAction.command);
      emittedEvents.push("chat.reply");
      chatWrites.push(
        Object.freeze({
          kind: "external_auth_login",
        }),
      );
    });

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
