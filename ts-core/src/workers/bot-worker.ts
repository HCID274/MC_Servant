/**
 * BotWorker 真实运行时。
 *
 * 1. 任务串行化：持续消费 `bot:{botId}:exec` 队列，确保机器人的物理动作任务（如移动、挖掘）严格串行执行。
 * 2. 状态机驱动：通过 BotActor 代理接口执行技能，并根据执行结果触发任务生命周期事件（Started, Completed, Failed 等）。
 */

import { Worker, type WorkerOptions } from "bullmq";

import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import type { InterruptSignal } from "../core-ports/runtime.js";
import type { SandboxSearchAdapter } from "../core-ports/sandbox.js";
import type { TaskResultSummary } from "../core-ports/task-result.js";
import {
  type CodeJob,
  type ExecJob,
  ExecPriority,
  TaskHistoryStatus,
  createCodeJob,
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
import {
  createTaskFailureResultSummary,
  createTaskResultSummaryFromCodeResult,
} from "./task-result-summary/index.js";

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
      readonly type: "task.interrupted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 生命周期状态。 */
      readonly status: TaskHistoryStatus.Interrupted;
      /** 中断原因。 */
      readonly reason: string;
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
  readonly actor: Pick<BotActorRuntime, "executeCode">;
  /** 当前意图纪元，用于丢弃过期任务。 */
  readonly currentIntentEpoch?: () => number | Promise<number>;
  /** 当前时钟，单位毫秒。 */
  readonly now?: () => number;
  /** 生命周期动作汇点，后续可接入 event_log（事件日志） 或 realtime（实时推送）。 */
  readonly actionSink?: (action: BotWorkerAction) => Promise<unknown>;
  /** TS（TypeScript） 语义 API（接口） search（检索） 只读桥。 */
  readonly semanticSearch?: SandboxSearchAdapter;
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
    owner_text: candidate.owner_text,
    ...(candidate.owner_position_at_message === undefined
      ? {}
      : { owner_position_at_message: candidate.owner_position_at_message }),
  });
}
/** 克隆底层执行任务。 */

function cloneExecJob(job: ExecJob): ExecJob {
  return cloneCodeJob(job);
}
/** 克隆代码执行任务。 */

function cloneCodeJob(job: CodeJob): CodeJob {
  assertCommonExecJob(job);
  assertNonEmptyString(job.code, "code");

  return createCodeJob({
    message_id: job.message_id,
    intent_epoch: job.intent_epoch,
    snapshot_ts: job.snapshot_ts,
    priority: job.priority,
    code: job.code,
    ...(job.recovery_chain_id === undefined ? {} : { recovery_chain_id: job.recovery_chain_id }),
    ...(job.replan_count === undefined ? {} : { replan_count: job.replan_count }),
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
      ...readStructuredErrorFields(error),
    });
  }

  return Object.freeze({
    message: String(error),
  });
}

function createErrorSnapshotFromTaskResultSummary(
  summary: TaskResultSummary,
): TaskFailedErrorSnapshot {
  const failure = summary.failure;
  const details = Object.freeze({
    ...(summary.details ?? {}),
    ...(failure?.target_progress === undefined || failure.target_progress === null
      ? {}
      : { target_progress: failure.target_progress }),
  });
  return Object.freeze({
    name: "TaskResultSummaryError",
    message:
      failure?.message ?? `${failure?.failure_code ?? "unknown_completion"}:${summary.operation}`,
    error_code: failure?.failure_code ?? "unknown_completion",
    details,
  });
}

function readStructuredErrorFields(error: Error): {
  readonly error_code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
} {
  const candidate = error as {
    readonly error_code?: unknown;
    readonly details?: unknown;
  };
  return Object.freeze({
    ...(typeof candidate.error_code === "string" && candidate.error_code.trim().length > 0
      ? { error_code: candidate.error_code }
      : {}),
    ...(typeof candidate.details === "object" && candidate.details !== null
      ? { details: candidate.details as Readonly<Record<string, unknown>> }
      : {}),
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
    const currentEpoch = (await input.dependencies.currentIntentEpoch?.()) ?? 0;

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
      const outcome = await input.dependencies.actor.executeCode(task.exec_job, {
        userMessage: task.owner_text,
        ...(task.owner_position_at_message === undefined
          ? {}
          : {
              owner: {
                online: true,
                position: task.owner_position_at_message,
              },
            }),
        ...(input.dependencies.semanticSearch === undefined
          ? {}
          : { searchMemory: input.dependencies.semanticSearch }),
      });
      const executionResult = outcome.result;
      const durationMs = Math.max(0, now() - startedAt);

      if (executionResult.status === TaskHistoryStatus.Failed) {
        const errorSnapshot = Object.freeze({
          name: executionResult.error.name,
          message: executionResult.error.message,
          ...("error_code" in executionResult.error
            ? { error_code: executionResult.error.error_code }
            : {}),
          ...("details" in executionResult.error &&
          typeof executionResult.error.details === "object" &&
          executionResult.error.details !== null
            ? { details: executionResult.error.details as Readonly<Record<string, unknown>> }
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
            last_step: executionResult.step_results.at(-1)?.action ?? "executeCode",
            result_summary: createTaskResultSummaryFromCodeResult(task.exec_job, executionResult, {
              durationMs,
            }),
            code_result: Object.freeze({
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

      if (executionResult.status === TaskHistoryStatus.Interrupted) {
        const reason = executionResult.error.message;
        await emitActions(
          createBotWorkerActions({
            task,
            phase: "terminal",
            status: TaskHistoryStatus.Interrupted,
            total_steps: executionResult.summary.total_steps,
            duration_ms: durationMs,
            interrupt_source: {
              type: "system",
              cause: "stalled",
            },
            reason,
            result_summary: createTaskResultSummaryFromCodeResult(task.exec_job, executionResult, {
              durationMs,
            }),
            code_result: Object.freeze({
              ...getSandboxResultRefs(executionResult),
              error: executionResult.error,
            }),
          }),
        );
        events.push(
          Object.freeze({
            type: "task.interrupted" as const,
            bot_id: task.bot_id,
            message_id: task.exec_job.message_id,
            status: TaskHistoryStatus.Interrupted,
            reason,
          }),
        );
        return;
      }

      const resultSummary = createTaskResultSummaryFromCodeResult(task.exec_job, executionResult, {
        durationMs,
      });
      if (resultSummary.status !== "completed") {
        const errorSnapshot = createErrorSnapshotFromTaskResultSummary(resultSummary);
        await emitActions(
          createBotWorkerActions({
            task,
            phase: "terminal",
            status: TaskHistoryStatus.Failed,
            total_steps: executionResult.summary.total_steps,
            duration_ms: durationMs,
            error: errorSnapshot,
            last_step: executionResult.step_results.at(-1)?.action ?? "executeCode",
            result_summary: resultSummary,
            code_result: Object.freeze({
              ...getSandboxResultRefs(executionResult),
              error: errorSnapshot,
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
        throw Object.assign(new Error(errorSnapshot.message), {
          name: errorSnapshot.name,
        });
      }

      await emitActions(
        createBotWorkerActions({
          task,
          phase: "terminal",
          status: TaskHistoryStatus.Completed,
          total_steps: executionResult.summary.total_steps,
          duration_ms: durationMs,
          result_summary: resultSummary,
          code_result: getSandboxResultRefs(executionResult),
        }),
      );
      events.push(
        Object.freeze({
          type: "task.completed" as const,
          bot_id: task.bot_id,
          message_id: task.exec_job.message_id,
          status: TaskHistoryStatus.Completed,
          total_steps: executionResult.summary.total_steps,
        }),
      );
    } catch (error) {
      if (terminalFailureHandled) {
        throw error;
      }

      const errorSnapshot = createErrorSnapshot(error);
      const durationMs = Math.max(0, now() - startedAt);
      const interruptSource = readInterruptedErrorSource(error);
      if (interruptSource !== null) {
        const reason = readInterruptedErrorReason(error) ?? errorSnapshot.message;
        await emitActions(
          createBotWorkerActions({
            task,
            phase: "terminal",
            status: TaskHistoryStatus.Interrupted,
            total_steps: 0,
            duration_ms: durationMs,
            interrupt_source: interruptSource,
            reason,
            result_summary: createTaskFailureResultSummary(
              task.exec_job,
              {
                message: reason,
                error_code: "task_interrupted",
                ...(errorSnapshot.details === undefined ? {} : { details: errorSnapshot.details }),
              },
              {
                durationMs,
                status: "interrupted",
              },
            ),
          }),
        );
        events.push(
          Object.freeze({
            type: "task.interrupted" as const,
            bot_id: task.bot_id,
            message_id: task.exec_job.message_id,
            status: TaskHistoryStatus.Interrupted,
            reason,
          }),
        );
        return;
      }

      await emitActions(
        createBotWorkerActions({
          task,
          phase: "terminal",
          status: TaskHistoryStatus.Failed,
          total_steps: 0,
          duration_ms: durationMs,
          error: errorSnapshot,
          result_summary: createTaskFailureResultSummary(task.exec_job, errorSnapshot, {
            durationMs,
          }),
          last_step: "executeCode",
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

function readInterruptedErrorSource(error: unknown): InterruptSignal["source"] | null {
  if (error === null || typeof error !== "object") {
    return null;
  }

  const candidate = error as {
    readonly error_code?: unknown;
    readonly interrupt_source?: unknown;
  };
  if (candidate.error_code !== "task_interrupted") {
    return null;
  }
  if (candidate.interrupt_source === null || typeof candidate.interrupt_source !== "object") {
    return null;
  }

  return candidate.interrupt_source as InterruptSignal["source"];
}

function readInterruptedErrorReason(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  const details = (error as { readonly details?: unknown }).details;
  if (details === null || typeof details !== "object") {
    return undefined;
  }

  const reason = (details as { readonly reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : undefined;
}
