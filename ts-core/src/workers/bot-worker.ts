/**
 * BotWorker 真实运行时。
 *
 * 1. 任务串行化：持续消费 `bot:{botId}:exec` 队列，确保机器人的物理动作任务（如移动、挖掘）严格串行执行。
 * 2. 状态机驱动：通过 BotActor 代理接口执行技能，并根据执行结果触发任务生命周期事件（Started, Completed, Failed 等）。
 */

import { Worker, type WorkerOptions } from "bullmq";

import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import { ExecutionTaskKind } from "../core-ports/foundation.js";
import {
  SKILL_DIRECTORY,
  isCollectSkillParams,
  isCutTreeSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
} from "../core-ports/skills.js";
import {
  type ExecJob,
  ExecPriority,
  type SandboxCodeJob,
  type SkillCallJob,
  TaskHistoryStatus,
  createSandboxCodeJob,
  createSkillCallJob,
} from "../core-ports/tasking.js";
import type { RedisClientLike } from "../db/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import type { BotActorRuntime } from "../runtime/actor.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import {
  type BotWorkerAction,
  type BotWorkerTask,
  createBotWorkerActions,
  createBotWorkerTask,
} from "./contracts.js";
import type { ExecQueueName } from "./queues.js";

/** BotWorker（机器人工作线程） 处理过程事件。 */
export type BotWorkerRuntimeEvent =
  | {
      /** 事件类型。 */
      readonly type: "task.started";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 生命周期状态。 */
      readonly status: TaskHistoryStatus.Started;
    }
  | {
      /** 事件类型。 */
      readonly type: "task.completed";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 生命周期状态。 */
      readonly status: TaskHistoryStatus.Completed;
      /** 总步骤数。 */
      readonly total_steps: number;
    }
  | {
      /** 事件类型。 */
      readonly type: "task.failed";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 生命周期状态。 */
      readonly status: TaskHistoryStatus.Failed;
      /** 错误摘要。 */
      readonly error: TaskFailedErrorSnapshot;
    }
  | {
      /** 事件类型。 */
      readonly type: "task.discarded";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 生命周期状态。 */
      readonly status: TaskHistoryStatus.Discarded;
      /** 丢弃原因。 */
      readonly reason: "intent_epoch_stale";
    };

/** BotWorker（机器人工作线程） BullMQ（任务队列） Worker 最小能力。 */
export interface BotBullmqWorkerLike {
  /** 关闭 Worker（工作线程）。 */
  close(): Promise<unknown>;
}

/** BotWorker（机器人工作线程） 创建 Worker 的注入函数。 */
export type CreateBotBullmqWorker = (input: {
  /** 队列名称。 */
  readonly queueName: ExecQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
  /** BullMQ（任务队列） job（任务） 处理器。 */
  readonly processor: (job: { readonly data: unknown }) => Promise<void>;
}) => BotBullmqWorkerLike;

/** BotWorker（机器人工作线程） 依赖注入集合。 */
export interface BotWorkerRuntimeDependencies {
  /** BotActor（机器人执行代理） 单写者入口。 */
  readonly actor: Pick<BotActorRuntime, "executeSkill" | "executeSandboxCode">;
  /** 当前意图纪元，用于丢弃过期任务。 */
  readonly currentIntentEpoch?: () => number;
  /** 当前时钟，单位毫秒。 */
  readonly now?: () => number;
  /** 生命周期动作汇点，后续可接入 event_log（事件日志） 或 realtime（实时推送）。 */
  readonly actionSink?: (action: BotWorkerAction) => Promise<unknown>;
  /** 可注入 BullMQ（任务队列） Worker 工厂。 */
  readonly createWorker?: CreateBotBullmqWorker;
}

/** BotWorker（机器人工作线程） 运行时输入队列。 */
export interface BotWorkerRuntimeQueue {
  /** 队列名称。 */
  readonly name: ExecQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
}

/** BotWorker（机器人工作线程） 运行时句柄。 */
export interface BotWorkerRuntime {
  /** 消费的执行队列名。 */
  readonly queue_name: ExecQueueName;
  /** 启动 BullMQ（任务队列） Worker。 */
  start(): Promise<void>;
  /** 关闭 BullMQ（任务队列） Worker。 */
  close(): Promise<void>;
  /** 获取处理过程事件快照。 */
  getEvents(): readonly BotWorkerRuntimeEvent[];
}
/** 创建默认的执行工作线程。 */

function createDefaultBotWorker(input: {
  queueName: ExecQueueName;
  connection: RedisClientLike;
  processor: (job: { readonly data: unknown }) => Promise<void>;
}): BotBullmqWorkerLike {
  return new Worker(createBullmqPhysicalQueueName(input.queueName), input.processor, {
    connection: input.connection as WorkerOptions["connection"],
    concurrency: 1,
  });
}
/** 克隆并校验机器人任务负载。 */

function cloneBotWorkerTask(data: unknown): BotWorkerTask {
  const candidate = data as BotWorkerTask;

  if (candidate.worker !== "bot") {
    throw new Error("BotWorker task must have worker=bot");
  }

  assertNonEmptyString(candidate.bot_id, "bot_id");

  return createBotWorkerTask({
    bot_id: candidate.bot_id,
    exec_job: cloneExecJob(candidate.exec_job),
  });
}
/** 克隆底层执行任务。 */

function cloneExecJob(job: ExecJob): ExecJob {
  switch (job.type) {
    case ExecutionTaskKind.SkillCall:
      return cloneSkillCallJob(job);
    case ExecutionTaskKind.SandboxCode:
      return cloneSandboxCodeJob(job);
  }
}
/** 克隆技能调用任务及其参数。 */

function cloneSkillCallJob(job: SkillCallJob): SkillCallJob {
  assertCommonExecJob(job);

  switch (job.skill) {
    case SKILL_DIRECTORY.goTo:
      if (!isGoToSkillParams(job.params)) {
        throw new Error("goTo skill_call params are invalid");
      }

      return createSkillCallJob({
        message_id: job.message_id,
        intent_epoch: job.intent_epoch,
        snapshot_ts: job.snapshot_ts,
        priority: job.priority,
        skill: SKILL_DIRECTORY.goTo,
        params: job.params,
      });
    case SKILL_DIRECTORY.mine:
      if (!isMineSkillParams(job.params)) {
        throw new Error("mine skill_call params are invalid");
      }

      return createSkillCallJob({
        message_id: job.message_id,
        intent_epoch: job.intent_epoch,
        snapshot_ts: job.snapshot_ts,
        priority: job.priority,
        skill: SKILL_DIRECTORY.mine,
        params: job.params,
      });
    case SKILL_DIRECTORY.cutTree:
      if (!isCutTreeSkillParams(job.params)) {
        throw new Error("cutTree skill_call params are invalid");
      }

      return createSkillCallJob({
        message_id: job.message_id,
        intent_epoch: job.intent_epoch,
        snapshot_ts: job.snapshot_ts,
        priority: job.priority,
        skill: SKILL_DIRECTORY.cutTree,
        params: job.params,
      });
    case SKILL_DIRECTORY.collect:
      if (!isCollectSkillParams(job.params)) {
        throw new Error("collect skill_call params are invalid");
      }

      return createSkillCallJob({
        message_id: job.message_id,
        intent_epoch: job.intent_epoch,
        snapshot_ts: job.snapshot_ts,
        priority: job.priority,
        skill: SKILL_DIRECTORY.collect,
        params: job.params,
      });
    case SKILL_DIRECTORY.equip:
      if (!isEquipSkillParams(job.params)) {
        throw new Error("equip skill_call params are invalid");
      }

      return createSkillCallJob({
        message_id: job.message_id,
        intent_epoch: job.intent_epoch,
        snapshot_ts: job.snapshot_ts,
        priority: job.priority,
        skill: SKILL_DIRECTORY.equip,
        params: job.params,
      });
  }
}
/** 克隆沙箱代码执行任务。 */

function cloneSandboxCodeJob(job: SandboxCodeJob): SandboxCodeJob {
  assertCommonExecJob(job);
  assertNonEmptyString(job.code, "code");

  return createSandboxCodeJob({
    message_id: job.message_id,
    intent_epoch: job.intent_epoch,
    snapshot_ts: job.snapshot_ts,
    priority: job.priority,
    code: job.code,
  });
}
/** 校验执行任务的通用必要字段。 */

function assertCommonExecJob(job: ExecJob): void {
  assertNonEmptyString(job.message_id, "message_id");

  if (!Number.isInteger(job.intent_epoch) || job.intent_epoch < 0) {
    throw new Error("intent_epoch must be a non-negative integer");
  }

  if (!Number.isFinite(job.snapshot_ts)) {
    throw new Error("snapshot_ts must be finite");
  }

  if (!Object.values(ExecPriority).includes(job.priority)) {
    throw new Error("exec job priority is invalid");
  }
}
/** 捕获并创建异常报错快照。 */

function createErrorSnapshot(error: unknown): TaskFailedErrorSnapshot {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name,
      message: error.message,
    });
  }

  return Object.freeze({
    message: String(error),
  });
}

/** 从运行时沙箱结果中提取可选存储引用，兼容当前 BotActor（机器人执行代理） 结果裁剪。 */
function getSandboxResultRefs(result: unknown): {
  readonly log_ref?: string;
  readonly code_ref?: string;
} {
  if (result === null || typeof result !== "object") {
    return {};
  }

  const candidate = result as { readonly log_ref?: unknown; readonly code_ref?: unknown };
  return Object.freeze({
    ...(typeof candidate.log_ref === "string" ? { log_ref: candidate.log_ref } : {}),
    ...(typeof candidate.code_ref === "string" ? { code_ref: candidate.code_ref } : {}),
  });
}

/**
 * 创建 BotWorker 真实运行时。
 *
 * 1. 执行网关：作为机器人的底层执行网关，将上层调度派发的抽象任务转化为实际对 BotActor 的调用。
 * 2. 纪元守卫：在执行前验证任务纪元（Intent Epoch）的新鲜度，拦截过期指令。
 * 3. 日志流：向 actionSink 发射标准化的生命周期动作（started, completed, failed），供后续持久化审计。
 *
 * @param input 包含执行队列连接与运行时依赖的输入
 * @returns 机器人工作线程运行时句柄
 */
export function createBotWorkerRuntime(input: {
  /** 待消费的执行队列。 */
  readonly queue: BotWorkerRuntimeQueue;
  /** 运行时依赖注入。 */
  readonly dependencies: BotWorkerRuntimeDependencies;
}): BotWorkerRuntime {
  let worker: BotBullmqWorkerLike | null = null;
  const events: BotWorkerRuntimeEvent[] = [];
  const createWorker = input.dependencies.createWorker ?? createDefaultBotWorker;
  const now = input.dependencies.now ?? Date.now;

  const emitActions = async (actions: readonly BotWorkerAction[]): Promise<void> => {
    for (const action of actions) {
      await input.dependencies.actionSink?.(action);
    }
  };

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    const task = cloneBotWorkerTask(job.data);
    const currentEpoch = input.dependencies.currentIntentEpoch?.() ?? 0;

    if (task.exec_job.intent_epoch < currentEpoch) {
      await emitActions(
        createBotWorkerActions({
          task,
          phase: "discarded",
          discard_reason: "intent_epoch_stale",
          current_epoch: currentEpoch,
        }),
      );
      events.push(
        Object.freeze({
          type: "task.discarded" as const,
          bot_id: task.bot_id,
          message_id: task.exec_job.message_id,
          status: TaskHistoryStatus.Discarded,
          reason: "intent_epoch_stale" as const,
        }),
      );
      return;
    }

    await emitActions(
      createBotWorkerActions({
        task,
        phase: "started",
      }),
    );
    events.push(
      Object.freeze({
        type: "task.started" as const,
        bot_id: task.bot_id,
        message_id: task.exec_job.message_id,
        status: TaskHistoryStatus.Started,
      }),
    );

    const startedAt = now();
    let terminalFailureHandled = false;

    try {
      const outcome =
        task.exec_job.type === ExecutionTaskKind.SkillCall
          ? await input.dependencies.actor.executeSkill(task.exec_job)
          : await input.dependencies.actor.executeSandboxCode(task.exec_job);
      const executionResult = outcome.result;
      const durationMs = Math.max(0, now() - startedAt);

      if ("status" in executionResult && executionResult.status === TaskHistoryStatus.Failed) {
        const errorSnapshot = Object.freeze({
          name: executionResult.error.name,
          message: executionResult.error.message,
          ...("error_code" in executionResult.error
            ? { error_code: executionResult.error.error_code }
            : {}),
        });
        await emitActions(
          createBotWorkerActions({
            task,
            phase: "terminal",
            status: TaskHistoryStatus.Failed,
            total_steps: executionResult.summary.total_steps,
            duration_ms: durationMs,
            error: errorSnapshot,
            last_step: executionResult.step_results.at(-1)?.action ?? "executeSandboxCode",
            sandbox_result: Object.freeze({
              ...getSandboxResultRefs(executionResult),
              error: executionResult.error,
            }),
          }),
        );
        events.push(
          Object.freeze({
            type: "task.failed" as const,
            bot_id: task.bot_id,
            message_id: task.exec_job.message_id,
            status: TaskHistoryStatus.Failed,
            error: errorSnapshot,
          }),
        );
        terminalFailureHandled = true;
        throw Object.assign(new Error(executionResult.error.message), {
          name: executionResult.error.name,
        });
      }

      await emitActions(
        createBotWorkerActions({
          task,
          phase: "terminal",
          status: TaskHistoryStatus.Completed,
          total_steps:
            "summary" in executionResult
              ? executionResult.summary.total_steps
              : executionResult.total_steps,
          duration_ms: durationMs,
          ...(task.exec_job.type === ExecutionTaskKind.SandboxCode
            ? {
                sandbox_result: getSandboxResultRefs(executionResult),
              }
            : {}),
        }),
      );
      events.push(
        Object.freeze({
          type: "task.completed" as const,
          bot_id: task.bot_id,
          message_id: task.exec_job.message_id,
          status: TaskHistoryStatus.Completed,
          total_steps:
            "summary" in executionResult
              ? executionResult.summary.total_steps
              : executionResult.total_steps,
        }),
      );
    } catch (error) {
      if (terminalFailureHandled) {
        throw error;
      }

      const errorSnapshot = createErrorSnapshot(error);
      const durationMs = Math.max(0, now() - startedAt);

      await emitActions(
        createBotWorkerActions({
          task,
          phase: "terminal",
          status: TaskHistoryStatus.Failed,
          total_steps: 0,
          duration_ms: durationMs,
          error: errorSnapshot,
          last_step:
            task.exec_job.type === ExecutionTaskKind.SkillCall
              ? "executeSkill"
              : "executeSandboxCode",
        }),
      );
      events.push(
        Object.freeze({
          type: "task.failed" as const,
          bot_id: task.bot_id,
          message_id: task.exec_job.message_id,
          status: TaskHistoryStatus.Failed,
          error: errorSnapshot,
        }),
      );
      throw error;
    }
  };

  return Object.freeze({
    queue_name: input.queue.name,
    async start(): Promise<void> {
      if (worker !== null) {
        return;
      }

      worker = createWorker({
        queueName: input.queue.name,
        connection: input.queue.connection,
        processor: processTask,
      });
    },
    async close(): Promise<void> {
      const currentWorker = worker;
      worker = null;
      await currentWorker?.close();
    },
    getEvents(): readonly BotWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}
