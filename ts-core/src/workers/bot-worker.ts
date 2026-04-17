/**
 * BotWorker（机器人工作线程） 真实运行时。
 *
 * 架构职责：
 * 1. 串行消费 `bot:{botId}:exec`（执行队列）。
 * 2. 只通过 BotActor（机器人执行代理） 单写者入口执行技能。
 * 3. 发出 started（已开始）/ completed（已完成）/ failed（已失败）/ discarded（已丢弃） 生命周期事件。
 */

import { Worker, type WorkerOptions } from "bullmq";

import type { RedisClientLike } from "../db/index.js";
import { ExecutionTaskKind } from "../domain/contracts.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import type { BotActorRuntime } from "../runtime/actor.js";
import type { TaskFailedErrorSnapshot } from "../runtime/events.js";
import {
  type ExecJob,
  ExecPriority,
  type SandboxCodeJob,
  type SkillCallJob,
  TaskHistoryStatus,
  createSandboxCodeJob,
  createSkillCallJob,
} from "../runtime/tasking.js";
import {
  SKILL_DIRECTORY,
  isCollectSkillParams,
  isCutTreeSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
} from "../skills/index.js";
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
  readonly actor: Pick<BotActorRuntime, "executeSkill">;
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

function cloneExecJob(job: ExecJob): ExecJob {
  switch (job.type) {
    case ExecutionTaskKind.SkillCall:
      return cloneSkillCallJob(job);
    case ExecutionTaskKind.SandboxCode:
      return cloneSandboxCodeJob(job);
  }
}

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

/** 创建 BotWorker（机器人工作线程） 真实运行时。 */
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

    try {
      if (task.exec_job.type !== ExecutionTaskKind.SkillCall) {
        throw new Error("BotWorker currently supports only skill_call execution");
      }

      const outcome = await input.dependencies.actor.executeSkill(task.exec_job);
      const durationMs = Math.max(0, now() - startedAt);

      await emitActions(
        createBotWorkerActions({
          task,
          phase: "terminal",
          status: TaskHistoryStatus.Completed,
          total_steps: outcome.result.total_steps,
          duration_ms: durationMs,
        }),
      );
      events.push(
        Object.freeze({
          type: "task.completed" as const,
          bot_id: task.bot_id,
          message_id: task.exec_job.message_id,
          status: TaskHistoryStatus.Completed,
          total_steps: outcome.result.total_steps,
        }),
      );
    } catch (error) {
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
          last_step: "executeSkill",
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
