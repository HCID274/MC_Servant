import type {
  RuntimeSandboxExecutionDependencies,
  RuntimeSandboxExecutionResult,
  SandboxFacadeCallControl,
  SandboxFacadeExecutionAdapter,
} from "../core-ports/sandbox.js";
import {
  SKILL_DIRECTORY,
  type SkillExecutionDependencies,
  type SkillExecutionResult,
  type SkillName,
  type SkillParamsByName,
  isCollectSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
} from "../core-ports/skills.js";
import {
  type BotActorCurrentTaskProjection,
  BotStatus,
  type ExternalAuthExecutionPlan,
  type ExternalAuthState,
  type RuntimeReadyGate,
  createExternalAuthExecutionPlan,
  createRuntimeReadyGate,
} from "./contracts.js";
import type { RuntimeEventType } from "./events.js";
import { resolveTransition } from "./state-machine.js";
import type { SandboxCodeJob, SkillCallJob } from "./tasking.js";
import type { MineflayerRuntimeTransport, MineflayerTransportSnapshot } from "./transport.js";

/** BotActor（机器人执行代理） 只需要持有观测缓存引用，不直接依赖 observation（观测） 实现。 */
export interface BotActorObservationRuntimeCachePort {
  /** 获取当前观测快照；当前运行时只保留端口，不主动读取。 */
  getSnapshot(): unknown;
}

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
  /** 当前正在执行的任务只读摘要。 */
  readonly current_task: BotActorCurrentTaskProjection | null;
  /** 本轮生命周期已产出的运行时事件类型。 */
  readonly emitted_events: readonly RuntimeEventType[];
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的聊天写入记录。 */
  readonly chat_writes: readonly BotActorChatWriteRecord[];
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的技能执行记录。 */
  readonly skill_executions: readonly BotActorSkillExecutionRecord[];
  /** 本轮由 BotActor（机器人执行代理） 单写者完成的沙箱执行记录。 */
  readonly sandbox_executions: readonly BotActorSandboxExecutionRecord[];
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
    }
  | {
      /** 写入类型。 */
      readonly kind: "sandbox_chat";
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 沙箱聊天方法。 */
      readonly method: "say" | "report";
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

/** BotActor（机器人执行代理） 沙箱执行记录。 */
export interface BotActorSandboxExecutionRecord {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 沙箱执行终态。 */
  readonly status: RuntimeSandboxExecutionResult["status"];
  /** 沙箱步骤数。 */
  readonly total_steps: number;
}

/** BotActor（机器人执行代理） 沙箱执行输出。 */
export interface BotActorSandboxExecutionOutcome<TBotId extends string = string> {
  /** 沙箱执行结果。 */
  readonly result: RuntimeSandboxExecutionResult;
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
  /** 通过 BotActor（机器人执行代理） 单写者入口执行沙箱代码任务。 */
  executeSandboxCode(job: SandboxCodeJob): Promise<BotActorSandboxExecutionOutcome<TBotId>>;
  /** 将 BotActor（机器人执行代理） 切换到 SHUTDOWN（关闭） 状态。 */
  shutdown(): Promise<BotActorRuntimeSnapshot<TBotId>>;
  /** 获取当前运行时快照。 */
  getSnapshot(): BotActorRuntimeSnapshot<TBotId>;
}

/**
 * 创建 BotActor 最小生命周期运行时。
 *
 * 1. 执行代理：作为 Bot 的唯一执行主体（Single Writer），负责序列化所有对 Minecraft 服务器的写操作（聊天、技能、移动）。
 * 2. 状态一致性：通过内部状态机驱动 Bot 的生命周期，确保在任何时刻其执行行为均符合就绪门控（Ready Gate）的约束。
 * 3. 结果投影：提供实时快照能力，将复杂的内部执行态（事件、聊天记录、技能历史）转换为不可变的领域模型供外部查询。
 *
 * @param input 包含 Bot ID, 传输层, 观测缓存, 认证状态及初始计划的输入
 * @returns BotActor 运行时句柄
 */
export function createBotActorRuntime<TBotId extends string>(input: {
  botId: TBotId;
  transport: MineflayerRuntimeTransport<TBotId>;
  observation: BotActorObservationRuntimeCachePort;
  externalAuth: ExternalAuthState;
  externalAuthPlan: ExternalAuthExecutionPlan;
  skillExecution?: SkillExecutionDependencies;
  sandboxExecution?: RuntimeSandboxExecutionDependencies;
}): BotActorRuntime<TBotId> {
  let status = BotStatus.INITIALIZING;
  let externalAuth = input.externalAuth;
  let externalAuthPlan = input.externalAuthPlan;
  let currentTask: BotActorCurrentTaskProjection | null = null;
  let chatWriteInFlight: Promise<void> | null = null;
  const emittedEvents: RuntimeEventType[] = [];
  const chatWrites: BotActorChatWriteRecord[] = [];
  const skillExecutions: BotActorSkillExecutionRecord[] = [];
  const sandboxExecutions: BotActorSandboxExecutionRecord[] = [];
  const skillExecution = input.skillExecution ?? {
    goToMovement: input.transport,
    mine: input.transport.mine.bind(input.transport),
    collect: input.transport.collect.bind(input.transport),
    equip: input.transport.equip.bind(input.transport),
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
      current_task: currentTask,
      emitted_events: Object.freeze([...emittedEvents]),
      chat_writes: Object.freeze([...chatWrites]),
      skill_executions: Object.freeze([...skillExecutions]),
      sandbox_executions: Object.freeze([...sandboxExecutions]),
    });

  const createActorSandboxFacade = (job: SandboxCodeJob): SandboxFacadeExecutionAdapter =>
    Object.freeze({
      async executeBotSkill<TName extends SkillName>(
        skill: TName,
        params: Readonly<SkillParamsByName[TName]>,
        control?: SandboxFacadeCallControl,
      ): Promise<Readonly<Record<string, unknown>>> {
        assertSandboxFacadeCallActive(control);

        switch (skill) {
          case SKILL_DIRECTORY.goTo:
            if (!isGoToSkillParams(params)) {
              throw new Error("sandbox goTo params are invalid");
            }

            return (await skillExecution.goToMovement.goTo(params)) as unknown as Readonly<
              Record<string, unknown>
            >;
          case SKILL_DIRECTORY.mine:
            if (!isMineSkillParams(params)) {
              throw new Error("sandbox mine params are invalid");
            }

            return (await skillExecution.mine(params)) as unknown as Readonly<
              Record<string, unknown>
            >;
          case SKILL_DIRECTORY.collect:
            if (!isCollectSkillParams(params)) {
              throw new Error("sandbox collect params are invalid");
            }

            return (await skillExecution.collect(params)) as unknown as Readonly<
              Record<string, unknown>
            >;
          case SKILL_DIRECTORY.equip:
            if (!isEquipSkillParams(params)) {
              throw new Error("sandbox equip params are invalid");
            }

            return (await skillExecution.equip(params)) as unknown as Readonly<
              Record<string, unknown>
            >;
          case SKILL_DIRECTORY.cutTree:
            throw new Error("cutTree is not executable in the current runtime sandbox");
        }

        throw new Error(`Unsupported sandbox skill: ${String(skill)}`);
      },
      async writeChat(
        method: "say" | "report",
        params: Readonly<{ message: string }>,
        control?: SandboxFacadeCallControl,
      ): Promise<Readonly<Record<string, unknown>>> {
        assertSandboxChatParams(params);
        assertSandboxFacadeCallActive(control);

        await runSerializedChatWrite(async () => {
          assertSandboxFacadeCallActive(control);
          await input.transport.chat(params.message);
          emittedEvents.push("chat.reply");
          chatWrites.push(
            Object.freeze({
              kind: "sandbox_chat" as const,
              message_id: job.message_id,
              method,
            }),
          );
        });

        return Object.freeze({
          delivered: true,
          method,
        });
      },
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

      const broadcastGate = createBroadcastReplyGate({
        status,
        externalAuth,
      });

      if (!broadcastGate.ready) {
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

      currentTask = Object.freeze({
        kind: "skill_call" as const,
        message_id: job.message_id,
        skill: job.skill,
      });
      status = startDecision.to;
      emittedEvents.push(...startDecision.emittedEvents);

      try {
        const result = await executeActorSkillCallJob(job, skillExecution);
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
        currentTask = null;

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
      } finally {
        currentTask = null;
      }
    },
    async executeSandboxCode(
      job: SandboxCodeJob,
    ): Promise<BotActorSandboxExecutionOutcome<TBotId>> {
      const transportSnapshot = input.transport.getSnapshot();
      const readyGate = createRuntimeReadyGate({
        status,
        externalAuth,
      });

      if (!readyGate.ready) {
        throw new Error("BotActor is not ready for executeSandboxCode");
      }

      if (!transportSnapshot.world_ready) {
        throw new Error("BotActor world interaction is not ready for executeSandboxCode");
      }

      const startDecision = resolveTransition(status, {
        type: "exec_job_pulled",
        epoch_fresh: true,
        snapshot_fresh: true,
      });

      if (!startDecision.accepted) {
        throw new Error(`BotActor cannot execute sandbox code while ${status}`);
      }

      currentTask = Object.freeze({
        kind: "sandbox_code" as const,
        message_id: job.message_id,
      });
      status = startDecision.to;
      emittedEvents.push(...startDecision.emittedEvents);

      try {
        if (input.sandboxExecution === undefined) {
          throw new Error("BotActor sandbox execution dependency is not configured");
        }

        const request = input.sandboxExecution.createRequest({
          job_id: job.message_id,
          bot_id: input.botId,
          intent_epoch: job.intent_epoch,
          snapshot_ts: job.snapshot_ts,
          code: job.code,
          log_ref: input.sandboxExecution.createLogRef({
            date: new Date(job.snapshot_ts).toISOString().slice(0, 10),
            job_id: job.message_id,
          }),
        });

        const sandboxResult = await input.sandboxExecution.executeRequest({
          request,
          task: {
            id: job.message_id,
            userMessage: job.code,
            intent: "sandbox_code",
          },
          facade: createActorSandboxFacade(job),
        });

        const completedDecision = resolveTransition(status, {
          type: sandboxResult.status === "completed" ? "task_completed" : "task_failed",
        });

        if (completedDecision.accepted) {
          status = completedDecision.to;
          emittedEvents.push(...completedDecision.emittedEvents);
        }

        sandboxExecutions.push(
          Object.freeze({
            message_id: job.message_id,
            status: sandboxResult.status,
            total_steps: sandboxResult.summary.total_steps,
          }),
        );
        currentTask = null;

        return Object.freeze({
          result: sandboxResult,
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
      } finally {
        currentTask = null;
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

  /**
   * 若外部认证处于 pending 状态，则尝试发送登录命令。
   */
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

  /**
   * 序列化执行聊天写入操作，防止多个写入动作冲突。
   */
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

/**
 * 创建聊天广播专用准入结果。
 *
 * 聊天回复允许在任务执行中穿过 BotActor（机器人执行代理） 单写者入口写回游戏，
 * 但不能复用 executeSkill（执行技能） 的忙碌门控，否则“执行中问状态”的回复无法送达。
 */
function createBroadcastReplyGate(input: {
  readonly status: BotStatus;
  readonly externalAuth: ExternalAuthState;
}): { readonly ready: boolean } {
  if (input.status !== BotStatus.IDLE && input.status !== BotStatus.EXECUTING) {
    return Object.freeze({ ready: false });
  }

  if (input.externalAuth.status === "pending" || input.externalAuth.status === "failed") {
    return Object.freeze({ ready: false });
  }

  return Object.freeze({ ready: true });
}

/**
 * 校验广播回复输入的合法性。
 */
function assertBroadcastReplyInput(input: BotActorBroadcastReplyInput): void {
  if (input.message_id.trim().length === 0) {
    throw new Error("message_id must be a non-empty string");
  }

  if (input.content.trim().length === 0) {
    throw new Error("content must be a non-empty string");
  }
}

/**
 * 校验沙箱聊天写入参数，确保空消息不会穿过 BotActor（机器人执行代理） 单写者边界。
 */
function assertSandboxChatParams(input: Readonly<{ message: string }>): void {
  if (input.message.trim().length === 0) {
    throw new Error("sandbox chat message must be a non-empty string");
  }
}

/**
 * 校验沙箱 Facade API（门面接口） 调用仍处在当前执行窗口内。
 */
function assertSandboxFacadeCallActive(control: SandboxFacadeCallControl | undefined): void {
  if (control === undefined) {
    return;
  }

  if (control.signal.aborted || Date.now() >= control.deadline_ms) {
    throw new Error("sandbox Facade call is no longer active");
  }
}

/** 通过注入的技能执行依赖分发 skill_call（技能调用），避免 runtime（运行时） 依赖 skills（技能） 实现模块。 */
async function executeActorSkillCallJob(
  job: SkillCallJob,
  dependencies: SkillExecutionDependencies,
): Promise<SkillExecutionResult> {
  switch (job.skill) {
    case SKILL_DIRECTORY.goTo:
      return dependencies.goToMovement.goTo(job.params);
    case SKILL_DIRECTORY.mine:
      return dependencies.mine(job.params);
    case SKILL_DIRECTORY.collect:
      return dependencies.collect(job.params);
    case SKILL_DIRECTORY.equip:
      return dependencies.equip(job.params);
    case SKILL_DIRECTORY.cutTree:
      throw new Error("cutTree is not executable in the current runtime");
  }
}
