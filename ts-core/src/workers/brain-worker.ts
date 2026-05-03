/**
 * BrainWorker 真实运行时。
 *
 * 1. 任务卡消费：从 `brain` 队列消费 BotWorker（机器人工作线程） 终态任务卡。
 * 2. B 层写入：调用 embedding API（向量接口） 后一次写入 task_events（任务事件）。
 * 3. 边界收口：BrainWorker（大脑工作线程） 只依赖任务卡、embedding（向量）和持久化端口。
 */

import { Worker, type WorkerOptions } from "bullmq";

import {
  type TaskEventDraft,
  createTaskEventDraft,
  createTaskEventEmbeddingText,
  isPersistedTaskSummaryStatus,
} from "../data/contracts.js";
import type { RedisClientLike } from "../db/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import {
  type BrainWorkerTask,
  createBrainWorkerActions,
  createBrainWorkerTask,
} from "./contracts.js";
import { type BrainQueueName, createBrainQueueName } from "./queues.js";

/** BrainWorker（大脑工作线程） 运行时事件。 */
export type BrainWorkerRuntimeEvent =
  | {
      /** 事件类型。 */
      readonly type: "brain.task_event.persisted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** task_history（任务历史） 主键。 */
      readonly task_id: string;
      /** task_events（任务事件） 主键。 */
      readonly event_id: string;
      /** 终态状态。 */
      readonly status: BrainWorkerTask["payload"]["status"];
    }
  | {
      /** 事件类型。 */
      readonly type: "brain.task_event.failed";
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

/** BrainWorker（大脑工作线程） BullMQ（任务队列） Worker 最小能力。 */
export interface BrainBullmqWorkerLike {
  /** 关闭 Worker（工作线程）。 */
  close(): Promise<unknown>;
}

/** BrainWorker（大脑工作线程） 创建 Worker 的注入函数。 */
export type CreateBrainBullmqWorker = (input: {
  /** 队列名称。 */
  readonly queueName: BrainQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
  /** BullMQ（任务队列） job（任务） 处理器。 */
  readonly processor: (job: { readonly data: unknown }) => Promise<void>;
}) => BrainBullmqWorkerLike;

/** BrainWorker（大脑工作线程） 依赖注入集合。 */
export interface BrainWorkerRuntimeDependencies {
  /** embedding API（向量接口） 生成器。 */
  readonly generateEmbedding: (text: string) => Promise<readonly number[]>;
  /** 持久化 task_events（任务事件） 草案。 */
  readonly persistTaskEvent: (draft: TaskEventDraft) => Promise<unknown>;
  /** BrainWorker（大脑工作线程） 运行时事件汇点。 */
  readonly eventSink?: (event: BrainWorkerRuntimeEvent) => Promise<unknown>;
  /** 当前时钟。 */
  readonly now?: () => Date;
  /** 可注入 BullMQ（任务队列） Worker 工厂。 */
  readonly createWorker?: CreateBrainBullmqWorker;
}

/** BrainWorker（大脑工作线程） 运行时输入队列。 */
export interface BrainWorkerRuntimeQueue {
  /** 队列名称。 */
  readonly name: BrainQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
}

/** BrainWorker（大脑工作线程） 运行时句柄。 */
export interface BrainWorkerRuntime {
  /** 消费的 brain（大脑） 队列名。 */
  readonly queue_name: BrainQueueName;
  /** 启动 BullMQ（任务队列） Worker。 */
  start(): Promise<void>;
  /** 关闭 BullMQ（任务队列） Worker。 */
  close(): Promise<void>;
  /** 获取处理过程事件快照。 */
  getEvents(): readonly BrainWorkerRuntimeEvent[];
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
  assertNonEmptyString(candidate.payload.owner_text, "payload.owner_text");
  if (!Number.isInteger(candidate.payload.intent_epoch) || candidate.payload.intent_epoch < 0) {
    throw new Error("payload.intent_epoch must be a non-negative integer");
  }
  if (!isPersistedTaskSummaryStatus(candidate.payload.status)) {
    throw new Error("BrainWorker task status must be completed, failed, or interrupted");
  }

  return createBrainWorkerTask({
    bot_id: candidate.payload.bot_id,
    message_id: candidate.payload.message_id,
    intent_epoch: candidate.payload.intent_epoch,
    status: candidate.payload.status,
    owner_text: candidate.payload.owner_text,
    task_card: candidate.payload.task_card,
    ...(candidate.payload.log_ref === undefined ? {} : { log_ref: candidate.payload.log_ref }),
  });
}

function createErrorSnapshot(error: unknown): BrainWorkerRuntimeEvent & {
  readonly type: "brain.task_event.failed";
} {
  if (error instanceof Error) {
    return Object.freeze({
      type: "brain.task_event.failed" as const,
      error: Object.freeze({
        name: error.name,
        message: error.message,
      }),
    });
  }

  return Object.freeze({
    type: "brain.task_event.failed" as const,
    error: Object.freeze({
      message: String(error),
    }),
  });
}

/**
 * 创建 BrainWorker（大脑工作线程） 真实运行时。
 *
 * @param input brain（大脑） 队列和依赖注入集合
 * @returns 可启动和关闭的 BrainWorker（大脑工作线程） 运行时
 */
export function createBrainWorkerRuntime(input: {
  /** 待消费的 brain（大脑） 队列。 */
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
    await input.dependencies.eventSink?.(event);
  };

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    let task: BrainWorkerTask | undefined;

    try {
      task = cloneBrainWorkerTask(job.data);
      const embeddingText = createTaskEventEmbeddingText({
        owner_text: task.payload.owner_text,
      });
      const embedding = await input.dependencies.generateEmbedding(embeddingText);
      const draft = createTaskEventDraft({
        task_id: task.payload.task_card.task_id,
        bot_id: task.payload.bot_id,
        message_id: task.payload.message_id,
        owner_text: task.payload.owner_text,
        task_card: task.payload.task_card,
        embedding,
        ...(task.payload.log_ref === undefined ? {} : { log_ref: task.payload.log_ref }),
        created_at: now().toISOString(),
      });

      for (const action of createBrainWorkerActions({ draft })) {
        if (action.type === "persist_task_event") {
          await input.dependencies.persistTaskEvent(action.draft);
        }
      }
      await emitEvent(
        Object.freeze({
          type: "brain.task_event.persisted" as const,
          bot_id: draft.bot_id,
          message_id: draft.message_id,
          task_id: draft.task_id,
          event_id: draft.id,
          status: task.payload.status,
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
