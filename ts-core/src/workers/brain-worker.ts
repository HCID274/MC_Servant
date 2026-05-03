/**
 * BrainWorker 真实运行时。
 *
 * 1. 任务卡消费：从 `brain` 队列消费 BotWorker（机器人工作线程） 终态任务卡。
 * 2. B 层写入：调用 embedding API（向量接口） 后一次写入 task_events（任务事件）。
 * 3. 边界收口：BrainWorker（大脑工作线程） 只依赖任务卡、embedding（向量）和持久化端口。
 */

import { Worker, type WorkerOptions } from "bullmq";

import {
  type BotRollingSummaryRecord,
  type TaskEventDraft,
  countRollingSummaryChars,
  createTaskEventDraft,
  createTaskEventEmbeddingText,
  isPersistedTaskSummaryStatus,
} from "../data/contracts.js";
import type { RedisClientLike } from "../db/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import type { BrainWorkerLlmClient } from "./brain-llm.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import {
  type BrainWorkerTask,
  createBrainWorkerActions,
  createBrainWorkerTask,
} from "./contracts.js";
import { type BrainQueueName, createBrainQueueName } from "./queues.js";

const ROLLING_SUMMARY_COMPRESS_THRESHOLD_CHARS = 2000;
const ROLLING_SUMMARY_COMPRESSED_MAX_CHARS = 1000;
const DEFAULT_SESSION_SILENCE_MS = 5 * 60 * 1000;

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
      readonly type: "brain.takeaway.updated";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** task_events（任务事件） 主键。 */
      readonly event_id: string;
      /** takeaway（要点） 类型。 */
      readonly takeaway_kind: "failure" | "session";
    }
  | {
      /** 事件类型。 */
      readonly type: "brain.rolling_summary.updated";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 当前字符数。 */
      readonly char_count: number;
      /** 是否触发了 LLM（大语言模型） 重压。 */
      readonly compressed: boolean;
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
  /** BrainWorker（大脑工作线程） 专属 LLM（大语言模型） 端口。 */
  readonly llm?: BrainWorkerLlmClient;
  /** 读取 bot_rolling_summary（滚动摘要）。 */
  readonly loadRollingSummary?: (botId: string) => Promise<BotRollingSummaryRecord | undefined>;
  /** 写入 bot_rolling_summary（滚动摘要）。 */
  readonly writeRollingSummary?: (input: {
    readonly bot_id: string;
    readonly content: string;
    readonly llm_model?: string;
    readonly updated_at: string;
  }) => Promise<unknown>;
  /** 更新 task_events.takeaway（任务事件要点）。 */
  readonly updateTaskEventTakeaway?: (input: {
    readonly event_id: string;
    readonly takeaway: string;
    readonly updated_at: string;
  }) => Promise<unknown>;
  /** 读取任务 JSONL（结构化日志） 前 50 行；缺省时用 task_card（任务卡） 兜底。 */
  readonly readTaskLogExcerpt?: (logRef: string) => Promise<string | undefined>;
  /** 会话静默 takeaway（要点） 调度配置。 */
  readonly sessionSilence?: Readonly<{
    /** 静默阈值；生产默认 5 分钟，测试可注入更短值。 */
    readonly delay_ms?: number;
    /** 当前 brain（大脑） 队列是否空闲。 */
    readonly isBrainQueueIdle?: () => Promise<boolean> | boolean;
    /** 当前是否仍有活跃执行任务。 */
    readonly hasActiveTask?: () => Promise<boolean> | boolean;
    /** 最近一次主人消息时间。 */
    readonly getLastOwnerMessageAt?: (botId: string) => Date | undefined;
  }>;
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
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
      await updateFailureTakeawayIfNeeded({
        task,
        draft,
        dependencies: input.dependencies,
        emitEvent,
        now,
      });
      await updateRollingSummary({
        task,
        dependencies: input.dependencies,
        emitEvent,
        now,
      });
      scheduleSessionTakeaway({
        task,
        dependencies: input.dependencies,
        timers: sessionTimers,
        emitEvent,
        now,
      });
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
      for (const timer of sessionTimers.values()) {
        clearTimeout(timer);
      }
      sessionTimers.clear();
      await currentWorker?.close();
    },
    getEvents(): readonly BrainWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}

async function updateFailureTakeawayIfNeeded(input: {
  readonly task: BrainWorkerTask;
  readonly draft: TaskEventDraft;
  readonly dependencies: BrainWorkerRuntimeDependencies;
  readonly emitEvent: (event: BrainWorkerRuntimeEvent) => Promise<void>;
  readonly now: () => Date;
}): Promise<void> {
  if (input.task.payload.status !== "failed") {
    return;
  }
  if (
    input.dependencies.llm === undefined ||
    input.dependencies.updateTaskEventTakeaway === undefined
  ) {
    return;
  }

  const logExcerpt = await createFailureLogExcerpt({
    task: input.task,
    ...(input.dependencies.readTaskLogExcerpt === undefined
      ? {}
      : { readTaskLogExcerpt: input.dependencies.readTaskLogExcerpt }),
  });
  const takeaway = await input.dependencies.llm.generateFailureTakeaway({
    task_card: input.task.payload.task_card,
    log_excerpt: logExcerpt,
  });

  await input.dependencies.updateTaskEventTakeaway({
    event_id: input.draft.id,
    takeaway,
    updated_at: input.now().toISOString(),
  });
  await input.emitEvent(
    Object.freeze({
      type: "brain.takeaway.updated" as const,
      bot_id: input.task.payload.bot_id,
      message_id: input.task.payload.message_id,
      event_id: input.draft.id,
      takeaway_kind: "failure" as const,
    }),
  );
}

async function updateRollingSummary(input: {
  readonly task: BrainWorkerTask;
  readonly dependencies: BrainWorkerRuntimeDependencies;
  readonly emitEvent: (event: BrainWorkerRuntimeEvent) => Promise<void>;
  readonly now: () => Date;
}): Promise<void> {
  if (
    input.dependencies.loadRollingSummary === undefined ||
    input.dependencies.writeRollingSummary === undefined
  ) {
    return;
  }

  const existing = await input.dependencies.loadRollingSummary(input.task.payload.bot_id);
  const appendedContent = appendRollingSummaryLine(
    existing?.content ?? "",
    createRollingSummaryLine(input.task.payload.task_card),
  );
  const needsCompression =
    countRollingSummaryChars(appendedContent) > ROLLING_SUMMARY_COMPRESS_THRESHOLD_CHARS;
  const content =
    needsCompression && input.dependencies.llm !== undefined
      ? clampByChars(
          await input.dependencies.llm.compressRollingSummary(appendedContent),
          ROLLING_SUMMARY_COMPRESSED_MAX_CHARS,
        )
      : appendedContent;

  await input.dependencies.writeRollingSummary({
    bot_id: input.task.payload.bot_id,
    content,
    ...(needsCompression && input.dependencies.llm !== undefined
      ? { llm_model: input.dependencies.llm.model }
      : {}),
    updated_at: input.now().toISOString(),
  });
  await input.emitEvent(
    Object.freeze({
      type: "brain.rolling_summary.updated" as const,
      bot_id: input.task.payload.bot_id,
      char_count: countRollingSummaryChars(content),
      compressed: needsCompression && input.dependencies.llm !== undefined,
    }),
  );
}

function scheduleSessionTakeaway(input: {
  readonly task: BrainWorkerTask;
  readonly dependencies: BrainWorkerRuntimeDependencies;
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  readonly emitEvent: (event: BrainWorkerRuntimeEvent) => Promise<void>;
  readonly now: () => Date;
}): void {
  const llm = input.dependencies.llm;
  const loadRollingSummary = input.dependencies.loadRollingSummary;
  const updateTaskEventTakeaway = input.dependencies.updateTaskEventTakeaway;

  if (
    llm === undefined ||
    loadRollingSummary === undefined ||
    updateTaskEventTakeaway === undefined
  ) {
    return;
  }

  const botId = input.task.payload.bot_id;
  const messageId = input.task.payload.message_id;
  const eventId = `task-event:${botId}:${messageId}`;
  const scheduledAt = input.now();
  const delayMs = input.dependencies.sessionSilence?.delay_ms ?? DEFAULT_SESSION_SILENCE_MS;
  const existingTimer = input.timers.get(botId);

  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    input.timers.delete(botId);
    void runSessionTakeawayIfStillSilent({
      bot_id: botId,
      message_id: messageId,
      event_id: eventId,
      scheduled_at: scheduledAt,
      dependencies: input.dependencies,
      emitEvent: input.emitEvent,
      now: input.now,
    });
  }, delayMs);

  input.timers.set(botId, timer);
}

async function runSessionTakeawayIfStillSilent(input: {
  readonly bot_id: string;
  readonly message_id: string;
  readonly event_id: string;
  readonly scheduled_at: Date;
  readonly dependencies: BrainWorkerRuntimeDependencies;
  readonly emitEvent: (event: BrainWorkerRuntimeEvent) => Promise<void>;
  readonly now: () => Date;
}): Promise<void> {
  const lastOwnerMessageAt = input.dependencies.sessionSilence?.getLastOwnerMessageAt?.(
    input.bot_id,
  );
  if (
    lastOwnerMessageAt !== undefined &&
    lastOwnerMessageAt.getTime() > input.scheduled_at.getTime()
  ) {
    return;
  }
  if ((await input.dependencies.sessionSilence?.isBrainQueueIdle?.()) === false) {
    return;
  }
  if ((await input.dependencies.sessionSilence?.hasActiveTask?.()) === true) {
    return;
  }

  const rollingSummary = await input.dependencies.loadRollingSummary?.(input.bot_id);
  if (rollingSummary === undefined || rollingSummary.content.trim().length === 0) {
    return;
  }

  const takeaway = await input.dependencies.llm?.generateSessionTakeaway({
    bot_id: input.bot_id,
    rolling_summary: rollingSummary.content,
  });
  if (takeaway === undefined || takeaway.trim().length === 0) {
    return;
  }

  await input.dependencies.updateTaskEventTakeaway?.({
    event_id: input.event_id,
    takeaway,
    updated_at: input.now().toISOString(),
  });
  await input.emitEvent(
    Object.freeze({
      type: "brain.takeaway.updated" as const,
      bot_id: input.bot_id,
      message_id: input.message_id,
      event_id: input.event_id,
      takeaway_kind: "session" as const,
    }),
  );
}

async function createFailureLogExcerpt(input: {
  readonly task: BrainWorkerTask;
  readonly readTaskLogExcerpt?: (logRef: string) => Promise<string | undefined>;
}): Promise<string> {
  const logRef = input.task.payload.log_ref ?? input.task.payload.task_card.result.log_ref;
  const logExcerpt = logRef === undefined ? undefined : await input.readTaskLogExcerpt?.(logRef);

  return logExcerpt ?? JSON.stringify(input.task.payload.task_card);
}

function appendRollingSummaryLine(content: string, line: string): string {
  const trimmedContent = content.trim();

  return trimmedContent.length === 0 ? line : `${trimmedContent}\n${line}`;
}

function createRollingSummaryLine(taskCard: BrainWorkerTask["payload"]["task_card"]): string {
  const statusText =
    taskCard.result.status === "completed"
      ? "完成"
      : taskCard.result.status === "failed"
        ? "失败"
        : "中断";
  const executionText =
    taskCard.execution.type === "skill_call" ? `技能 ${taskCard.execution.skill}` : "沙盒代码";
  const detailText =
    taskCard.result.status === "failed"
      ? `，原因 ${taskCard.result.error.message}`
      : taskCard.result.status === "interrupted"
        ? `，原因 ${taskCard.result.reason}`
        : "";

  return normalizeRollingSummaryLineLength(
    `主人要求“${taskCard.owner_text}”，Bot 执行${executionText}${statusText}${detailText}。`,
  );
}

function normalizeRollingSummaryLineLength(value: string): string {
  const trimmed = value.trim();

  if (countRollingSummaryChars(trimmed) >= 50) {
    return clampByChars(trimmed, 100);
  }

  return clampByChars(`${trimmed} 后续应保留该结果供下轮对话引用。`, 100);
}

function clampByChars(value: string, maxChars: number): string {
  const chars = Array.from(value);

  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}
