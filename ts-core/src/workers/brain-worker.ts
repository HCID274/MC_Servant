/**
 * BrainWorker 真实运行时。
 *
 * 1. 摘要读取：从 `brain` 队列消费终态任务，并通过注入 source（来源）读取 task_history（任务历史）与 JSONL（结构化日志）摘要输入。
 * 2. 摘要写入：通过注入式 summary（摘要）生成器、可选 embedding（向量嵌入）生成器和 persist（持久化）端口写入 task_summaries（任务摘要）。
 * 3. 边界收口：BrainWorker（摘要工作线程） 只读历史和日志、只写摘要，不接触 BotActor（机器人执行代理）或 Mineflayer（Minecraft 协议客户端）句柄。
 */

import { Worker, type WorkerOptions } from "bullmq";

import type { TaskHistoryStatus } from "../core-ports/tasking.js";
import {
  type TaskSummary,
  type TaskSummaryDraft,
  type TaskSummarySource,
  createDeterministicTaskSummaryText,
  createTaskSummaryDraft,
  createTaskSummarySource,
  isPersistedTaskSummaryStatus,
} from "../data/contracts.js";
import type { RedisClientLike } from "../db/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import { type BrainWorkerTask, createBrainWorkerTask } from "./contracts.js";
import { type BrainQueueName, createBrainQueueName } from "./queues.js";

/** BrainWorker（摘要工作线程） 摘要生成结果。 */
export interface BrainTaskSummaryGeneration {
  /** 意图摘要；未提供时复用 source（来源） 的 intent（意图）。 */
  readonly intent?: string;
  /** Level 1（一级） 摘要正文。 */
  readonly summary: string;
}

/** BrainWorker（摘要工作线程） 运行时事件。 */
export type BrainWorkerRuntimeEvent =
  | {
      /** 事件类型。 */
      readonly type: "brain.summary.persisted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** task_history（任务历史） 主键。 */
      readonly task_id: string;
      /** task_summaries（任务摘要） 主键。 */
      readonly summary_id: string;
      /** 终态状态。 */
      readonly status: TaskSummaryDraft["status"];
    }
  | {
      /** 事件类型。 */
      readonly type: "brain.summary.failed";
      /** 目标 Bot 标识。 */
      readonly bot_id?: string;
      /** 原始消息标识。 */
      readonly message_id?: string;
      /** 失败错误快照。 */
      readonly error: Readonly<{
        /** 错误分类名。 */
        readonly name?: string;
        /** 错误消息。 */
        readonly message: string;
      }>;
    };

/** BrainWorker（摘要工作线程） BullMQ（任务队列） Worker 最小能力。 */
export interface BrainBullmqWorkerLike {
  /** 关闭 Worker（工作线程）。 */
  close(): Promise<unknown>;
}

/** BrainWorker（摘要工作线程） 创建 Worker 的注入函数。 */
export type CreateBrainBullmqWorker = (input: {
  /** 队列名称。 */
  readonly queueName: BrainQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
  /** BullMQ（任务队列） job（任务） 处理器。 */
  readonly processor: (job: { readonly data: unknown }) => Promise<void>;
}) => BrainBullmqWorkerLike;

/** BrainWorker（摘要工作线程） 依赖注入集合。 */
export interface BrainWorkerRuntimeDependencies {
  /** 读取 task_history（任务历史） 与 JSONL（结构化日志） 摘要输入。 */
  readonly loadTaskSummarySource: (task: BrainWorkerTask) => Promise<TaskSummarySource>;
  /** 生成 Level 1（一级） 摘要。 */
  readonly generateTaskSummary: (
    source: TaskSummarySource,
  ) => Promise<BrainTaskSummaryGeneration> | BrainTaskSummaryGeneration;
  /** 可选 embedding（向量嵌入） 生成器。 */
  readonly generateEmbedding?: (draft: TaskSummaryDraft) => Promise<readonly number[]>;
  /** 持久化 task_summaries（任务摘要） 草案。 */
  readonly persistTaskSummary: (draft: TaskSummaryDraft) => Promise<TaskSummary | unknown>;
  /** 运行时事件汇点。 */
  readonly actionSink?: (event: BrainWorkerRuntimeEvent) => Promise<unknown>;
  /** 当前时钟。 */
  readonly now?: () => Date;
  /** 可注入 BullMQ（任务队列） Worker 工厂。 */
  readonly createWorker?: CreateBrainBullmqWorker;
}

/** BrainWorker（摘要工作线程） 运行时输入队列。 */
export interface BrainWorkerRuntimeQueue {
  /** 队列名称。 */
  readonly name: BrainQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
}

/** BrainWorker（摘要工作线程） 运行时句柄。 */
export interface BrainWorkerRuntime {
  /** 消费的摘要队列名。 */
  readonly queue_name: BrainQueueName;
  /** 启动 BullMQ（任务队列） Worker。 */
  start(): Promise<void>;
  /** 关闭 BullMQ（任务队列） Worker。 */
  close(): Promise<void>;
  /** 获取处理过程事件快照。 */
  getEvents(): readonly BrainWorkerRuntimeEvent[];
}

/** 创建确定性 fallback（兜底） 摘要生成结果。 */
export function createDeterministicBrainTaskSummary(
  source: TaskSummarySource,
): BrainTaskSummaryGeneration {
  return Object.freeze({
    intent: source.intent,
    summary: createDeterministicTaskSummaryText(source),
  });
}

function createDefaultBrainWorker(input: {
  queueName: BrainQueueName;
  connection: RedisClientLike;
  processor: (job: { readonly data: unknown }) => Promise<void>;
}): BrainBullmqWorkerLike {
  return new Worker(createBullmqPhysicalQueueName(input.queueName), input.processor, {
    connection: input.connection as WorkerOptions["connection"],
    concurrency: 2,
  });
}

function cloneBrainWorkerTask(data: unknown): BrainWorkerTask {
  const candidate = data as BrainWorkerTask;

  if (candidate.worker !== "brain") {
    throw new Error("BrainWorker task must have worker=brain");
  }
  if (candidate.queue !== createBrainQueueName()) {
    throw new Error("BrainWorker task must target brain queue");
  }
  assertNonEmptyString(candidate.payload.bot_id, "payload.bot_id");
  assertNonEmptyString(candidate.payload.message_id, "payload.message_id");
  if (!Number.isInteger(candidate.payload.intent_epoch) || candidate.payload.intent_epoch < 0) {
    throw new Error("payload.intent_epoch must be a non-negative integer");
  }
  if (!isPersistedTaskSummaryStatus(candidate.payload.status as TaskHistoryStatus)) {
    throw new Error("BrainWorker task status must be completed, failed, or interrupted");
  }

  return createBrainWorkerTask({
    bot_id: candidate.payload.bot_id,
    message_id: candidate.payload.message_id,
    intent_epoch: candidate.payload.intent_epoch,
    status: candidate.payload.status,
  });
}

function assertSourceMatchesTask(source: TaskSummarySource, task: BrainWorkerTask): void {
  if (source.bot_id !== task.payload.bot_id) {
    throw new Error("summary source bot_id must match task payload");
  }
  if (source.message_id !== task.payload.message_id) {
    throw new Error("summary source message_id must match task payload");
  }
  if (source.intent_epoch !== task.payload.intent_epoch) {
    throw new Error("summary source intent_epoch must match task payload");
  }
  if (source.status !== task.payload.status) {
    throw new Error("summary source status must match task payload");
  }
}

function createErrorSnapshot(error: unknown): BrainWorkerRuntimeEvent & {
  readonly type: "brain.summary.failed";
} {
  if (error instanceof Error) {
    return Object.freeze({
      type: "brain.summary.failed" as const,
      error: Object.freeze({
        name: error.name,
        message: error.message,
      }),
    });
  }

  return Object.freeze({
    type: "brain.summary.failed" as const,
    error: Object.freeze({
      message: String(error),
    }),
  });
}

/**
 * 创建 BrainWorker（摘要工作线程） 真实运行时。
 *
 * @param input 摘要队列和依赖注入集合
 * @returns 可启动和关闭的 BrainWorker（摘要工作线程） 运行时
 */
export function createBrainWorkerRuntime(input: {
  /** 待消费的摘要队列。 */
  readonly queue: BrainWorkerRuntimeQueue;
  /** 运行时依赖注入。 */
  readonly dependencies: BrainWorkerRuntimeDependencies;
}): BrainWorkerRuntime {
  let worker: BrainBullmqWorkerLike | null = null;
  const events: BrainWorkerRuntimeEvent[] = [];
  const createWorker = input.dependencies.createWorker ?? createDefaultBrainWorker;
  const now = input.dependencies.now ?? (() => new Date());

  const emitEvent = async (event: BrainWorkerRuntimeEvent): Promise<void> => {
    events.push(event);
    await input.dependencies.actionSink?.(event);
  };

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    let task: BrainWorkerTask | undefined;

    try {
      task = cloneBrainWorkerTask(job.data);
      const source = createTaskSummarySource(await input.dependencies.loadTaskSummarySource(task));
      assertSourceMatchesTask(source, task);
      const generated = await input.dependencies.generateTaskSummary(source);
      const baseDraft = createTaskSummaryDraft({
        task_id: source.task_id,
        bot_id: source.bot_id,
        message_id: source.message_id,
        intent: generated.intent ?? source.intent,
        status: source.status,
        summary: generated.summary,
        ...(source.log_ref === undefined ? {} : { log_ref: source.log_ref }),
        created_at: now().toISOString(),
      });
      const embedding =
        input.dependencies.generateEmbedding === undefined
          ? undefined
          : await input.dependencies.generateEmbedding(baseDraft);
      const draft =
        embedding === undefined
          ? baseDraft
          : createTaskSummaryDraft({
              ...baseDraft,
              message_id: source.message_id,
              embedding,
            });

      await input.dependencies.persistTaskSummary(draft);
      await emitEvent(
        Object.freeze({
          type: "brain.summary.persisted" as const,
          bot_id: draft.bot_id,
          message_id: source.message_id,
          task_id: draft.task_id,
          summary_id: draft.id,
          status: draft.status,
        }),
      );
    } catch (error) {
      const failedEvent = createErrorSnapshot(error);
      await emitEvent(
        Object.freeze({
          ...failedEvent,
          ...(task === undefined
            ? {}
            : {
                bot_id: task.payload.bot_id,
                message_id: task.payload.message_id,
              }),
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
    getEvents(): readonly BrainWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}
