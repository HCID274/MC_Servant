import type { TaskFailedErrorSnapshot } from "../../core-ports/events.js";
import type { ExecutionTaskKind } from "../../core-ports/foundation.js";
import type { ExecPriority, TaskHistoryStatus } from "../../core-ports/tasking.js";
import { assertNonEmptyString } from "../../domain/invariants.js";

/** BrainWorker（大脑工作线程） 可写入 task_events（任务事件） 的终态集合。 */
export type TaskEventStatus =
  | TaskHistoryStatus.Completed
  | TaskHistoryStatus.Failed
  | TaskHistoryStatus.Interrupted;

/** task_card（任务卡） 中的执行任务摘要。 */
export type BrainTaskCardExecution =
  | Readonly<{
      readonly type: ExecutionTaskKind.SkillCall;
      readonly skill: string;
      readonly params: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      readonly type: ExecutionTaskKind.SandboxCode;
      readonly code_ref?: string;
    }>;

/** task_card（任务卡） 中的终态结果摘要。 */
export type BrainTaskCardResult =
  | Readonly<{
      readonly status: TaskHistoryStatus.Completed;
      readonly total_steps: number;
      readonly duration_ms: number;
      readonly log_ref?: string;
    }>
  | Readonly<{
      readonly status: TaskHistoryStatus.Failed;
      readonly total_steps: number;
      readonly duration_ms: number;
      readonly error: TaskFailedErrorSnapshot;
      readonly last_step?: string;
      readonly log_ref?: string;
    }>
  | Readonly<{
      readonly status: TaskHistoryStatus.Interrupted;
      readonly total_steps: number;
      readonly duration_ms: number;
      readonly reason: string;
      readonly interrupt_source: Readonly<Record<string, unknown>>;
      readonly log_ref?: string;
    }>;

/** task_events.task_card（任务事件任务卡） 的结构化载荷。 */
export interface BrainTaskCard {
  /** task_history（任务历史） 主键。 */
  readonly task_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
  /** 执行队列优先级。 */
  readonly priority: ExecPriority;
  /** 主人原文。 */
  readonly owner_text: string;
  /** 执行任务摘要。 */
  readonly execution: BrainTaskCardExecution;
  /** 终态结果。 */
  readonly result: BrainTaskCardResult;
}

/** task_events（任务事件） 写入草案。 */
export interface TaskEventDraft {
  /** 稳定任务事件标识。 */
  readonly id: string;
  /** task_history（任务历史） 主键。 */
  readonly task_id: string;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 主人原文。 */
  readonly owner_text: string;
  /** 结构化任务卡。 */
  readonly task_card: BrainTaskCard;
  /** 触发式 takeaway（要点），普通成功任务为 undefined。 */
  readonly takeaway?: string;
  /** Embedding（向量嵌入）。 */
  readonly embedding: readonly number[];
  /** JSONL（结构化日志） 引用。 */
  readonly log_ref?: string;
  /** 创建时间。 */
  readonly created_at: string;
}

/** 创建稳定 task_events（任务事件） 标识；一条任务终态只写一张任务卡。 */
export function createTaskEventId(input: { bot_id: string; message_id: string }): string {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message_id, "message_id");

  return `task-event:${input.bot_id}:${input.message_id}`;
}

/** 创建 task_events.task_card（任务事件任务卡） 载荷。 */
export function createBrainTaskCard(input: BrainTaskCard): BrainTaskCard {
  assertNonEmptyString(input.task_id, "task_id");
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.owner_text, "owner_text");
  assertPositiveInteger(input.intent_epoch, "intent_epoch");
  assertFiniteNumber(input.snapshot_ts, "snapshot_ts");
  assertPositiveInteger(input.result.total_steps, "result.total_steps", { allowZero: true });
  assertPositiveInteger(input.result.duration_ms, "result.duration_ms", { allowZero: true });

  return Object.freeze({
    task_id: input.task_id,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    owner_text: input.owner_text,
    execution: Object.freeze({ ...input.execution }),
    result: Object.freeze({ ...input.result }),
  });
}

/** 创建 task_events（任务事件） 写入草案。 */
export function createTaskEventDraft(input: {
  id?: string;
  task_id: string;
  bot_id: string;
  message_id: string;
  owner_text: string;
  task_card: BrainTaskCard;
  takeaway?: string;
  embedding: readonly number[];
  log_ref?: string;
  created_at: string;
}): TaskEventDraft {
  assertNonEmptyString(input.task_id, "task_id");
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.owner_text, "owner_text");
  assertNonEmptyString(input.created_at, "created_at");

  const taskCard = createBrainTaskCard(input.task_card);
  const embedding = Object.freeze(validateEmbedding(input.embedding));

  return Object.freeze({
    id: input.id ?? createTaskEventId(input),
    task_id: input.task_id,
    bot_id: input.bot_id,
    message_id: input.message_id,
    owner_text: input.owner_text,
    task_card: taskCard,
    ...(input.takeaway === undefined ? {} : { takeaway: input.takeaway }),
    embedding,
    ...(input.log_ref === undefined ? {} : { log_ref: input.log_ref }),
    created_at: input.created_at,
  });
}

/** 创建 embedding API（向量接口） 的输入文本，严格按 §7-① 使用 owner_text + takeaway。 */
export function createTaskEventEmbeddingText(input: {
  readonly owner_text: string;
  readonly takeaway?: string;
}): string {
  assertNonEmptyString(input.owner_text, "owner_text");

  return [input.owner_text, input.takeaway].filter(isNonEmptyString).join("\n");
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function validateEmbedding(values: readonly number[]): readonly number[] {
  if (values.length === 0) {
    throw new Error("task_events.embedding must not be empty");
  }

  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error("task_events.embedding must contain only finite numbers");
    }
  }

  return [...values];
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function assertPositiveInteger(
  value: number,
  name: string,
  options: Readonly<{ allowZero?: boolean }> = {},
): void {
  const minimum = options.allowZero === true ? 0 : 1;

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
}
