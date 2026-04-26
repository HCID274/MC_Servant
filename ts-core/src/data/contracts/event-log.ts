import type {
  RuntimeEventLogEntry,
  TaskFailedErrorSnapshot,
  TaskLifecycleEvent,
  TaskLifecycleEventPayloadByStatus,
  TaskLifecycleEventTypeByStatus,
} from "../../core-ports/events.js";
import type { ExecJob, TaskHistoryStatus } from "../../core-ports/tasking.js";
import {
  type PersistedEventType,
  type PersistedTaskLifecycleEventType,
  type PersistedTaskType,
  TASK_PROGRESS_EVENT_TYPE,
  type TaskProgressStatus,
} from "./tables.js";
import {
  assertNonNegativeInteger,
  assertPersistedIdentifier,
  assertPersistedTimestamp,
  assertPositiveInteger,
  clonePersistedValue,
} from "./utils.js";

export interface TaskProgressPersistedEventPayload {
  /** 任务标识。 */
  readonly job_id: string;
  /** 执行任务类型。 */
  readonly type: PersistedTaskType;
  /** 原始用户消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly epoch: number;
  /** 步骤索引。 */
  readonly step_index: number;
  /** 动作名。 */
  readonly action: string;
  /** 步骤状态。 */
  readonly status: TaskProgressStatus;
  /** 步骤参数快照。 */
  readonly params?: Readonly<Record<string, unknown>>;
  /** 步骤结果快照。 */
  readonly result?: Readonly<Record<string, unknown>>;
  /** 步骤耗时。 */
  readonly duration_ms?: number;
  /** 错误快照。 */
  readonly error?: TaskFailedErrorSnapshot;
}

/** 按 event_log（事件日志） 类型索引的 payload（载荷） 联合。 */
export type PersistedEventPayloadByType<TType extends PersistedEventType> =
  TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Accepted>
    ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Accepted>
    : TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Started>
      ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Started>
      : TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Discarded>
        ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Discarded>
        : TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Completed>
          ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Completed>
          : TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Failed>
            ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Failed>
            : TType extends PersistedTaskLifecycleEventType<TaskHistoryStatus.Interrupted>
              ? TaskLifecycleEventPayloadByStatus<TaskHistoryStatus.Interrupted>
              : TType extends typeof TASK_PROGRESS_EVENT_TYPE
                ? TaskProgressPersistedEventPayload
                : NonNullable<RuntimeEventLogEntry["payload"]>;

/** event_log 表 payload 结构。 */
export type PersistedEventPayload = PersistedEventPayloadByType<PersistedEventType>;

/** event_log（事件日志） 的纯记录结构。 */
export interface PersistedEventLogRecord<TType extends PersistedEventType = PersistedEventType> {
  /** 自增序号。 */
  readonly seq?: number;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 关联会话标识。 */
  readonly session_id?: string;
  /** 事件类型。 */
  readonly type: TType;
  /** 事件载荷。 */
  readonly payload: PersistedEventPayloadByType<TType>;
  /** 创建时间。 */
  readonly created_at: string;
}

/** 基于 task.* 生命周期构造的 event_log（事件日志） 记录。 */
export type PersistedTaskLifecycleEventLogRecord<TStatus extends TaskHistoryStatus> =
  PersistedEventLogRecord<PersistedTaskLifecycleEventType<TStatus>>;

/** task.started（任务开始） 的持久化事件记录。 */
export type PersistedTaskStartedEventLogRecord =
  PersistedTaskLifecycleEventLogRecord<TaskHistoryStatus.Started>;

/** task.completed / failed / interrupted 的持久化终态事件记录。 */
export type PersistedTaskTerminalEventLogRecord =
  | PersistedTaskLifecycleEventLogRecord<TaskHistoryStatus.Completed>
  | PersistedTaskLifecycleEventLogRecord<TaskHistoryStatus.Failed>
  | PersistedTaskLifecycleEventLogRecord<TaskHistoryStatus.Interrupted>;

/** step.progress（步骤进度） 的持久化事件记录。 */
export type PersistedTaskProgressEventLogRecord = PersistedEventLogRecord<
  typeof TASK_PROGRESS_EVENT_TYPE
>;

export function createPersistedEventLogRecord<TType extends PersistedEventType>(input: {
  seq?: number;
  bot_id: string;
  session_id?: string;
  type: TType;
  payload: PersistedEventPayloadByType<TType>;
  created_at: string;
}): PersistedEventLogRecord<TType> {
  assertPersistedIdentifier(input.bot_id, "bot_id");
  assertPersistedTimestamp(input.created_at, "created_at");

  if (input.seq !== undefined) {
    assertPositiveInteger(input.seq, "seq");
  }

  if (input.session_id !== undefined) {
    assertPersistedIdentifier(input.session_id, "session_id");
  }

  return Object.freeze({
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    bot_id: input.bot_id,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    type: input.type,
    payload: clonePersistedValue(input.payload),
    created_at: input.created_at,
  });
}

/**
 * 从运行时生命周期事件创建持久化事件日志记录。
 *
 * 领域适配（Domain Adaptation）：将运行时的 TaskLifecycleEvent 无损转换为持久化层记录。
 *
 * 契约映射：确保运行时状态机的每个关键迁移事件都能在持久化流水线中找到对应的位置，支撑 Replay 与系统回溯。
 *
 * @param input 包含 seq, bot_id, session_id, lifecycle 事件和 created_at 的输入
 * @returns 对应的生命周期持久化记录
 */
export function createPersistedTaskLifecycleEventLogRecord<
  TStatus extends TaskHistoryStatus,
>(input: {
  seq?: number;
  bot_id: string;
  session_id?: string;
  lifecycle: TaskLifecycleEvent<TStatus>;
  created_at: string;
}): PersistedTaskLifecycleEventLogRecord<TStatus> {
  return createPersistedEventLogRecord({
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    bot_id: input.bot_id,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    type: input.lifecycle.event_type,
    payload: input.lifecycle.payload as unknown as PersistedEventPayloadByType<
      PersistedTaskLifecycleEventType<TStatus>
    >,
    created_at: input.created_at,
  }) as PersistedTaskLifecycleEventLogRecord<TStatus>;
}

/**
 * 创建步骤进度（step.progress）的持久化事件记录。
 *
 * 进度追踪（Progress Tracking）：专门用于记录任务执行过程中每一个原子步骤的执行状态、参数及结果。
 *
 * 细粒度审计：从运行时的 ExecJob 中提取核心元数据（job_id, type, message_id, epoch），结合当前步骤的动态信息生成可回溯记录。
 *
 * @param input 包含 job, step_index, action, status 等执行细节的输入
 * @returns 步骤进度持久化记录
 */
export function createPersistedTaskProgressEventLogRecord(input: {
  seq?: number;
  bot_id: string;
  session_id?: string;
  job: ExecJob;
  created_at: string;
  step_index: number;
  action: string;
  status: TaskProgressStatus;
  params?: Readonly<Record<string, unknown>>;
  result?: Readonly<Record<string, unknown>>;
  duration_ms?: number;
  error?: TaskFailedErrorSnapshot;
}): PersistedTaskProgressEventLogRecord {
  assertPersistedIdentifier(input.bot_id, "bot_id");
  assertPersistedTimestamp(input.created_at, "created_at");
  assertNonNegativeInteger(input.step_index, "step_index");
  assertPersistedIdentifier(input.action, "action");

  if (input.seq !== undefined) {
    assertPositiveInteger(input.seq, "seq");
  }
  if (input.session_id !== undefined) {
    assertPersistedIdentifier(input.session_id, "session_id");
  }
  if (input.duration_ms !== undefined) {
    assertNonNegativeInteger(input.duration_ms, "duration_ms");
  }
  if (input.status === "err" && input.error === undefined) {
    throw new Error("step.progress with err status requires error");
  }

  return createPersistedEventLogRecord({
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    bot_id: input.bot_id,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    type: TASK_PROGRESS_EVENT_TYPE,
    payload: {
      job_id: input.job.message_id,
      type: input.job.type,
      message_id: input.job.message_id,
      epoch: input.job.intent_epoch,
      step_index: input.step_index,
      action: input.action,
      status: input.status,
      ...(input.params === undefined ? {} : { params: clonePersistedValue(input.params) }),
      ...(input.result === undefined ? {} : { result: clonePersistedValue(input.result) }),
      ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
      ...(input.error === undefined ? {} : { error: clonePersistedValue(input.error) }),
    },
    created_at: input.created_at,
  } as {
    seq?: number;
    bot_id: string;
    session_id?: string;
    type: typeof TASK_PROGRESS_EVENT_TYPE;
    payload: TaskProgressPersistedEventPayload;
    created_at: string;
  });
}
