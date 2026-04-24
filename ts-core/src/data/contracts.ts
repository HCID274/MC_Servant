/**
 * 数据契约与持久化模型转换。
 *
 * 1. 契约定义：定义所有可持久化到数据库的对象结构（Event Log, Task History, Config 等）。
 * 2. 状态映射：将运行时的动态对象（如 ExecJob, RuntimeEvent）映射为符合数据库 Schema 的持久化记录。
 * 3. 配置管理：提供 DataConfig 的解析、校验、以及 Bot 级配置（Overlay）的合并逻辑。
 * 4. 辅助校验：为持久化标识符、时间戳、日志引用等提供严格的类型检查与断言。
 */

import { ExecutionTaskKind, MessageSource } from "../domain/contracts.js";
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventLogEntry,
  type RuntimeEventType,
  type TaskFailedErrorSnapshot,
  type TaskLifecycleEvent,
  type TaskLifecycleEventPayloadByStatus,
  type TaskLifecycleEventTypeByStatus,
} from "../runtime/events.js";
import {
  type ExecJob,
  type InterruptedTaskRecord,
  TaskHistoryStatus,
  type TaskTerminalStatus,
} from "../runtime/tasking.js";
import {
  DEFAULT_LOGS_BASE_DIR,
  EVENT_LOG_RETENTION_DAYS,
  JSONL_RETENTION_DAYS,
  isValidStorageRef,
} from "./logs.js";

/** mc_servant 业务 schema 名称。 */
export const MC_SERVANT_SCHEMA_NAME = "mc_servant" as const;

/** mc_servant 持久化表名清单。 */
export const MC_SERVANT_TABLE_NAMES = [
  "owners",
  "bots",
  "owner_bots",
  "sessions",
  "chat_messages",
  "event_log",
  "task_history",
  "task_summaries",
  "session_summaries",
] as const;

/** 持久化层的表名联合类型。 */
export type McServantTableName = (typeof MC_SERVANT_TABLE_NAMES)[number];

/** chat_messages 表允许的角色值。 */
export const CHAT_MESSAGE_ROLES = ["user", "bot"] as const;

/** chat_messages 表角色联合类型。 */
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

/** 持久化层复用的消息来源清单。 */
export const PERSISTED_MESSAGE_SOURCES = [
  MessageSource.Web,
  MessageSource.Game,
  MessageSource.System,
] as const;

/** 持久化层消息来源联合类型。 */
export type PersistedMessageSource = (typeof PERSISTED_MESSAGE_SOURCES)[number];

/** event_log 表允许的事件类型清单。 */
export const PERSISTED_EVENT_TYPES = [...RUNTIME_EVENT_TYPES] as const;

/** event_log 表事件类型联合。 */
export type PersistedEventType = RuntimeEventType;

/** task_history 表允许的任务类型清单。 */
export const TASK_HISTORY_TASK_TYPES = [
  ExecutionTaskKind.SkillCall,
  ExecutionTaskKind.SandboxCode,
] as const;

/** task_history 表任务类型联合。 */
export type PersistedTaskType = ExecJob["type"];

/** task_history 表允许的状态清单。 */
export const TASK_HISTORY_STATUS_VALUES = [
  TaskHistoryStatus.Accepted,
  TaskHistoryStatus.Started,
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
  TaskHistoryStatus.Discarded,
] as const;

/** task_history 表状态联合。 */
export type PersistedTaskStatus = TaskHistoryStatus;

/** task_summaries 表允许的终态清单。 */
export const TASK_SUMMARY_STATUS_VALUES = [
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
] as const;

/** task_summaries 表终态联合。 */
export type TaskSummaryStatus = (typeof TASK_SUMMARY_STATUS_VALUES)[number];

/** task_history.interrupt_source 的持久化类型。 */
export type PersistedInterruptSource = InterruptedTaskRecord["interrupt_source"];

/** step.progress（步骤进度） 允许的状态清单。 */
export const TASK_PROGRESS_STATUSES = ["ok", "err", "abort"] as const;

/** step.progress（步骤进度） 状态联合类型。 */
export type TaskProgressStatus = (typeof TASK_PROGRESS_STATUSES)[number];

/** task.accepted / started / discarded / completed / failed / interrupted 事件类型联合。 */
export type PersistedTaskLifecycleEventType<TStatus extends TaskHistoryStatus = TaskHistoryStatus> =
  TaskLifecycleEventTypeByStatus<TStatus>;

/** task.completed / failed / interrupted 终态事件类型联合。 */
export type PersistedTaskTerminalEventType = PersistedTaskLifecycleEventType<TaskTerminalStatus>;

/** step.progress（步骤进度） 事件类型常量。 */
export const TASK_PROGRESS_EVENT_TYPE = "step.progress" as const satisfies PersistedEventType;

/** event_log（事件日志） 内的步骤进度载荷。 */
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

/** Embedding（向量） 默认维度。 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024 as const;

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

/** task_history（任务历史） accepted（已接受） 快照基类。 */
export interface PersistedTaskHistoryAcceptedRecordBase {
  /** 主键；与 job_id / message_id 对齐。 */
  readonly id: string;
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 执行任务类型。 */
  readonly type: PersistedTaskType;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 当前状态。 */
  readonly status: TaskHistoryStatus.Accepted;
  /** tasks/（任务执行日志） JSONL 相对路径。 */
  readonly log_ref: string;
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 创建时间。 */
  readonly created_at: string;
}

/** `skill_call`（技能调用） 的 task_history accepted（已接受） 记录。 */
export interface PersistedSkillCallTaskHistoryAcceptedRecord
  extends PersistedTaskHistoryAcceptedRecordBase {
  /** 固定为 `skill_call`。 */
  readonly type: ExecutionTaskKind.SkillCall;
  /** 技能名。 */
  readonly skill: string;
  /** 技能参数。 */
  readonly params: ExecJob extends infer TJob
    ? TJob extends { readonly type: ExecutionTaskKind.SkillCall; readonly params: infer TParams }
      ? Readonly<TParams>
      : never
    : never;
}

/** `sandbox_code`（沙箱代码） 的 task_history accepted（已接受） 记录。 */
export interface PersistedSandboxCodeTaskHistoryAcceptedRecord
  extends PersistedTaskHistoryAcceptedRecordBase {
  /** 固定为 `sandbox_code`。 */
  readonly type: ExecutionTaskKind.SandboxCode;
  /** 原始代码引用。 */
  readonly code_ref: string;
}

/** task_history（任务历史） accepted（已接受） 快照联合。 */
export type PersistedTaskHistoryAcceptedRecord =
  | PersistedSkillCallTaskHistoryAcceptedRecord
  | PersistedSandboxCodeTaskHistoryAcceptedRecord;

/** task_history（任务历史） started（已开始） 更新结构。 */
export interface PersistedTaskHistoryStartedPatch {
  /** 任务标识。 */
  readonly id: string;
  /** 更新后的状态。 */
  readonly status: TaskHistoryStatus.Started;
  /** 开始时间。 */
  readonly started_at: string;
}

/** task_history（任务历史） 终态更新基类。 */
export interface PersistedTaskHistoryTerminalPatchBase<TStatus extends TaskTerminalStatus> {
  /** 任务标识。 */
  readonly id: string;
  /** 更新后的状态。 */
  readonly status: TStatus;
  /** 完成时间。 */
  readonly finished_at: string;
  /** 总耗时。 */
  readonly duration_ms: number;
  /** 总步骤数。 */
  readonly total_steps: number;
}

/** task_history（任务历史） completed（已完成） 更新结构。 */
export interface PersistedTaskHistoryCompletedPatch
  extends PersistedTaskHistoryTerminalPatchBase<TaskHistoryStatus.Completed> {}

/** task_history（任务历史） failed（已失败） 更新结构。 */
export interface PersistedTaskHistoryFailedPatch
  extends PersistedTaskHistoryTerminalPatchBase<TaskHistoryStatus.Failed> {
  /** 失败错误快照。 */
  readonly error: TaskFailedErrorSnapshot;
}

/** task_history（任务历史） interrupted（已中断） 更新结构。 */
export interface PersistedTaskHistoryInterruptedPatch
  extends PersistedTaskHistoryTerminalPatchBase<TaskHistoryStatus.Interrupted> {
  /** 中断来源。 */
  readonly interrupt_source: PersistedInterruptSource;
  /** 中断原因。 */
  readonly reason: string;
}

/** task_history（任务历史） 终态更新联合。 */
export type PersistedTaskHistoryTerminalPatch =
  | PersistedTaskHistoryCompletedPatch
  | PersistedTaskHistoryFailedPatch
  | PersistedTaskHistoryInterruptedPatch;

/** 崩溃恢复的未闭合任务检测默认上限。 */
export const DEFAULT_UNCLOSED_TASK_LIMIT = 5 as const;

/** 崩溃恢复的未闭合任务检测输入。 */
export interface UnclosedTaskDetectionInput {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 候选的 started（已开始） 事件集合。 */
  readonly started_events: readonly PersistedTaskStartedEventLogRecord[];
  /** 已闭合的终态事件集合。 */
  readonly terminal_events: readonly PersistedTaskTerminalEventLogRecord[];
  /** 最多返回条数。 */
  readonly limit: number;
}

/** 单条未闭合任务候选。 */
export interface UnclosedTaskCandidate {
  /** 任务标识。 */
  readonly job_id: string;
  /** 执行任务类型。 */
  readonly type: PersistedTaskType;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly epoch: number;
  /** 对应 started（已开始） 事件序号。 */
  readonly started_seq?: number;
  /** 对应 started（已开始） 时间。 */
  readonly started_at: string;
}

/** 未闭合任务检测结果。 */
export interface UnclosedTaskDetectionResult {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 实际使用上限。 */
  readonly limit: number;
  /** 未闭合任务列表。 */
  readonly open_tasks: readonly UnclosedTaskCandidate[];
}

/** 持久化写入阶段清单。 */
export const TASK_PERSISTENCE_PHASES = [
  "accepted",
  "started",
  "progress",
  "terminal",
  "brain_summary",
] as const;

/** 持久化写入阶段联合类型。 */
export type TaskPersistencePhase = (typeof TASK_PERSISTENCE_PHASES)[number];

/** 持久化写入目标清单。 */
export const PERSISTENCE_TARGETS = [
  "task_history",
  "event_log",
  "jsonl",
  "brain_queue",
  "task_summaries",
  "session_summaries",
] as const;

/** 持久化写入目标联合类型。 */
export type PersistenceTarget = (typeof PERSISTENCE_TARGETS)[number];

/** 持久化底座类型清单。 */
export const PERSISTENCE_STORES = ["postgres", "jsonl", "queue"] as const;

/** 持久化底座联合类型。 */
export type PersistenceStore = (typeof PERSISTENCE_STORES)[number];

/** 单步持久化顺序描述器。 */
export interface PersistenceWriteStep {
  /** 顺序号。 */
  readonly order: number;
  /** 所属阶段。 */
  readonly phase: TaskPersistencePhase;
  /** 写入目标。 */
  readonly target: PersistenceTarget;
  /** 底座类型。 */
  readonly store: PersistenceStore;
  /** 动作名。 */
  readonly operation: "insert" | "update" | "append" | "enqueue";
  /** 简要说明。 */
  readonly description: string;
}

/** 文档收口后的任务生命周期写入顺序。 */
export const TASK_PERSISTENCE_WRITE_SEQUENCE = Object.freeze([
  Object.freeze({
    order: 1,
    phase: "accepted",
    target: "task_history",
    store: "postgres",
    operation: "insert",
    description: "msg 队列入队时先创建 accepted 任务索引",
  }),
  Object.freeze({
    order: 2,
    phase: "accepted",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "accepted 生命周期事件作为 append-only 真理源补齐",
  }),
  Object.freeze({
    order: 3,
    phase: "started",
    target: "task_history",
    store: "postgres",
    operation: "update",
    description: "BotWorker 取出任务时把状态推进到 started",
  }),
  Object.freeze({
    order: 4,
    phase: "started",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "started 生命周期事件进入 event_log",
  }),
  Object.freeze({
    order: 5,
    phase: "progress",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "每步进度先写 event_log 保持审计连续性",
  }),
  Object.freeze({
    order: 6,
    phase: "progress",
    target: "jsonl",
    store: "jsonl",
    operation: "append",
    description: "冷日志按相同步骤追加 JSONL 细节",
  }),
  Object.freeze({
    order: 7,
    phase: "terminal",
    target: "task_history",
    store: "postgres",
    operation: "update",
    description: "真实终态先更新 task_history，failed / interrupted 必须带完整原因",
  }),
  Object.freeze({
    order: 8,
    phase: "terminal",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "终态事件写入 event_log，供 replay 与恢复复用",
  }),
  Object.freeze({
    order: 9,
    phase: "terminal",
    target: "brain_queue",
    store: "queue",
    operation: "enqueue",
    description: "真实终态之后异步触发 BrainWorker 摘要链路",
  }),
  Object.freeze({
    order: 10,
    phase: "brain_summary",
    target: "task_summaries",
    store: "postgres",
    operation: "insert",
    description: "BrainWorker 异步生成 task_summaries",
  }),
] as const satisfies readonly PersistenceWriteStep[]);

/** 读取指定阶段的持久化写入计划。 */
export function createTaskPersistencePlan(input: {
  phase: Exclude<TaskPersistencePhase, "brain_summary">;
}): readonly PersistenceWriteStep[];
/** 读取 BrainWorker（摘要工作线程） 阶段的持久化写入计划。 */
export function createTaskPersistencePlan(input: {
  phase: "brain_summary";
  includeSessionAggregation?: boolean;
}): readonly PersistenceWriteStep[];
/**
 * 获取任务持久化写入计划。
 *
 * 1. 计划分发（Plan Dispatching）：根据任务的生命周期阶段，动态生成对应的数据库写入序列。
 *
 * 1. 顺序一致性：确保全系统（Worker、Brain 等）遵循统一的写入步骤（如先写 event_log 再写 task_history），防止由于竞争导致的审计断档。
 * 2. 扩展性：通过 includeSessionAggregation 标志支持 BrainWorker 阶段的可选会话聚合。
 *
 * @param input 包含阶段和可选聚合标志的输入
 * @returns 经过筛选的持久化写入步骤
 */
export function createTaskPersistencePlan(input: {
  phase: TaskPersistencePhase;
  includeSessionAggregation?: boolean;
}): readonly PersistenceWriteStep[] {
  const selectedSteps = TASK_PERSISTENCE_WRITE_SEQUENCE.filter(
    (step) => step.phase === input.phase,
  );

  if (input.phase !== "brain_summary" || input.includeSessionAggregation !== true) {
    return Object.freeze(selectedSteps);
  }

  return Object.freeze([
    ...selectedSteps,
    Object.freeze({
      order: 11,
      phase: "brain_summary",
      target: "session_summaries",
      store: "postgres",
      operation: "insert",
      description: "满足聚合条件后异步写入 session_summaries",
    }),
  ]);
}

/**
 * 创建持久化事件日志记录。
 *
 * 事件对象工厂（Event Object Factory）：验证并创建符合数据库 Schema 的只读事件日志对象。
 *
 * 数据校验：在持久化前强制进行标识符、时间戳和序号的合法性校验，作为数据写入的第一道防线。
 *
 * @param input 包含 seq, bot_id, session_id, type, payload 和 created_at 的输入
 * @returns 经过验证和克隆的只读记录
 */
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
  });
}

/**
 * 创建任务历史已接受（Accepted）记录。
 *
 * 1. 初始快照工厂（Initial Snapshot Factory）：在任务被接受时，创建其初始持久化快照并进行严格的分层校验.
 * 2. 存储隔离：校验 log_ref 的频道一致性，确保 sandbox 与普通任务的日志存储在物理上隔离.
 * 3. 类型分发：针对 SandboxCode 和 SkillCall 强制执行不同的字段约束.
 *
 * @param input 包含 bot_id, job, log_ref, code_ref 和 created_at 的输入
 * @returns 初始化的任务历史记录
 */
export function createPersistedTaskHistoryAcceptedRecord(input: {
  bot_id: string;
  job: ExecJob;
  log_ref: string;
  code_ref?: string;
  created_at: string;
}): PersistedTaskHistoryAcceptedRecord {
  assertPersistedIdentifier(input.bot_id, "bot_id");
  assertPersistedTimestamp(input.created_at, "created_at");

  if (input.job.type === ExecutionTaskKind.SandboxCode) {
    assertTaskHistoryLogRef(input.log_ref, "sandbox");

    if (input.code_ref === undefined) {
      throw new Error("sandbox_code task history requires code_ref");
    }

    assertSandboxCodeRef(input.code_ref);

    return Object.freeze({
      id: input.job.message_id,
      bot_id: input.bot_id,
      type: ExecutionTaskKind.SandboxCode,
      intent_epoch: input.job.intent_epoch,
      status: TaskHistoryStatus.Accepted,
      log_ref: input.log_ref,
      code_ref: input.code_ref,
      snapshot_ts: input.job.snapshot_ts,
      message_id: input.job.message_id,
      created_at: input.created_at,
    });
  }

  if (input.code_ref !== undefined) {
    throw new Error("skill_call task history must not include code_ref");
  }

  assertTaskHistoryLogRef(input.log_ref, "tasks");

  return Object.freeze({
    id: input.job.message_id,
    bot_id: input.bot_id,
    type: ExecutionTaskKind.SkillCall,
    intent_epoch: input.job.intent_epoch,
    status: TaskHistoryStatus.Accepted,
    skill: input.job.skill,
    params: clonePersistedValue(input.job.params),
    log_ref: input.log_ref,
    snapshot_ts: input.job.snapshot_ts,
    message_id: input.job.message_id,
    created_at: input.created_at,
  });
}

/**
 * 创建任务历史开始执行（Started）更新补丁。
 *
 * 性能统计基准：记录任务真实的开始时间，为后续计算执行耗时提供精准基准点。
 *
 * @param input 任务 ID 和开始时间
 * @returns 状态更新补丁
 */
export function createPersistedTaskHistoryStartedPatch(input: {
  id: string;
  started_at: string;
}): PersistedTaskHistoryStartedPatch {
  assertPersistedIdentifier(input.id, "id");
  assertPersistedTimestamp(input.started_at, "started_at");

  return Object.freeze({
    id: input.id,
    status: TaskHistoryStatus.Started,
    started_at: input.started_at,
  });
}

/** 创建 task_history completed（已完成） 更新。 */
export function createPersistedTaskHistoryTerminalPatch(input: {
  id: string;
  status: TaskHistoryStatus.Completed;
  finished_at: string;
  duration_ms: number;
  total_steps: number;
}): PersistedTaskHistoryCompletedPatch;
/** 创建 task_history failed（已失败） 更新。 */
export function createPersistedTaskHistoryTerminalPatch(input: {
  id: string;
  status: TaskHistoryStatus.Failed;
  finished_at: string;
  duration_ms: number;
  total_steps: number;
  error: TaskFailedErrorSnapshot;
}): PersistedTaskHistoryFailedPatch;
/** 创建 task_history interrupted（已中断） 更新。 */
export function createPersistedTaskHistoryTerminalPatch(input: {
  id: string;
  status: TaskHistoryStatus.Interrupted;
  finished_at: string;
  duration_ms: number;
  total_steps: number;
  interrupt_source: PersistedInterruptSource;
  reason: string;
}): PersistedTaskHistoryInterruptedPatch;
/**
 * 创建任务历史终态（Terminal）更新补丁。
 *
 * 终态补丁工厂（Terminal Patch Factory）：统一处理任务进入 Completed, Failed 或 Interrupted 终态时的持久化数据补丁。
 *
 * 完整性约束：在数据库写入前强制校验终态特有字段（如 Failed 必须有 error，Interrupted 必须有 source），确保历史数据的可回溯性。
 *
 * @param input 包含任务 ID, 终态类型, 完成时间, 耗时, 总步数及相关信息的输入
 * @returns 终态更新补丁
 */
export function createPersistedTaskHistoryTerminalPatch(input: {
  id: string;
  status: TaskTerminalStatus;
  finished_at: string;
  duration_ms: number;
  total_steps: number;
  error?: TaskFailedErrorSnapshot;
  interrupt_source?: PersistedInterruptSource;
  reason?: string;
}): PersistedTaskHistoryTerminalPatch {
  assertPersistedIdentifier(input.id, "id");
  assertPersistedTimestamp(input.finished_at, "finished_at");
  assertNonNegativeInteger(input.duration_ms, "duration_ms");
  assertNonNegativeInteger(input.total_steps, "total_steps");

  switch (input.status) {
    case TaskHistoryStatus.Completed:
      return Object.freeze({
        id: input.id,
        status: TaskHistoryStatus.Completed,
        finished_at: input.finished_at,
        duration_ms: input.duration_ms,
        total_steps: input.total_steps,
      });
    case TaskHistoryStatus.Failed:
      if (input.error === undefined) {
        throw new Error("failed task history patch requires error");
      }
      return Object.freeze({
        id: input.id,
        status: TaskHistoryStatus.Failed,
        finished_at: input.finished_at,
        duration_ms: input.duration_ms,
        total_steps: input.total_steps,
        error: clonePersistedValue(input.error),
      });
    case TaskHistoryStatus.Interrupted:
      if (input.interrupt_source === undefined) {
        throw new Error("interrupted task history patch requires interrupt_source");
      }
      if (!input.reason || input.reason.trim().length === 0) {
        throw new Error("interrupted task history patch requires reason");
      }
      return Object.freeze({
        id: input.id,
        status: TaskHistoryStatus.Interrupted,
        finished_at: input.finished_at,
        duration_ms: input.duration_ms,
        total_steps: input.total_steps,
        interrupt_source: clonePersistedValue(input.interrupt_source),
        reason: input.reason,
      });
  }
}

/**
 * 创建崩溃恢复用的未闭合任务检测输入。
 *
 * 恢复准备：封装 Bot 标识和相关的历史事件集合，为检测崩溃后的残留任务提供数据底座。
 *
 * @param input 包含 bot_id, started_events, terminal_events 等信息的输入
 * @returns 经过校验的检测输入对象
 */
export function createUnclosedTaskDetectionInput(input: {
  bot_id: string;
  started_events: readonly PersistedTaskStartedEventLogRecord[];
  terminal_events: readonly PersistedTaskTerminalEventLogRecord[];
  limit?: number;
}): UnclosedTaskDetectionInput {
  assertPersistedIdentifier(input.bot_id, "bot_id");

  const limit = normalizeUnclosedTaskLimit(input.limit);
  const startedEvents = input.started_events.map((event) => {
    assertReplayBotBinding(input.bot_id, event.bot_id, "started_events.bot_id");
    return createPersistedEventLogRecord(event);
  }) as readonly PersistedTaskStartedEventLogRecord[];
  const terminalEvents = input.terminal_events.map((event) => {
    assertReplayBotBinding(input.bot_id, event.bot_id, "terminal_events.bot_id");
    return createPersistedEventLogRecord(event);
  }) as readonly PersistedTaskTerminalEventLogRecord[];

  return Object.freeze({
    bot_id: input.bot_id,
    started_events: Object.freeze(startedEvents),
    terminal_events: Object.freeze(terminalEvents),
    limit,
  });
}

/**
 * 计算未闭合任务列表。
 *
 * 崩溃恢复计算（Crash Recovery Calculation）：利用 event_log 的真理源推断哪些任务已被接受但未正常结束。
 *
 * 纯函数恢复逻辑：通过对比 started_events 和 terminal_events，在不依赖复杂数据库查询的情况下，计算出需要恢复或标记失败的任务清单。
 *
 * @param input 包含检测输入和限制的输入
 * @returns 检测出的未闭合任务结果
 */
export function detectUnclosedTasks(
  input: UnclosedTaskDetectionInput,
): UnclosedTaskDetectionResult {
  const closedJobIds = new Set(input.terminal_events.map((event) => event.payload.job_id));
  const openTasks = input.started_events
    .filter((event) => !closedJobIds.has(event.payload.job_id))
    .sort(compareUnclosedTaskCandidates)
    .slice(0, input.limit)
    .map((event) =>
      Object.freeze({
        job_id: event.payload.job_id,
        type: event.payload.type,
        message_id: event.payload.message_id,
        epoch: event.payload.epoch,
        ...(event.seq === undefined ? {} : { started_seq: event.seq }),
        started_at: event.created_at,
      }),
    );

  return Object.freeze({
    bot_id: input.bot_id,
    limit: input.limit,
    open_tasks: Object.freeze(openTasks),
  });
}
/** 克隆持久化数据值。 */

function clonePersistedValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => clonePersistedValue(item))) as TValue;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      clonePersistedValue(entryValue),
    ]);

    return Object.freeze(Object.fromEntries(entries)) as TValue;
  }

  return value;
}
/** 断言持久化标识符的合法性。 */

function assertPersistedIdentifier(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
/** 断言持久化时间戳的合法性。 */

function assertPersistedTimestamp(value: string, fieldName: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
}
/** 断言数值是否为正整数。 */

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}
/** 断言数值是否为非负整数。 */

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}
/** 断言任务历史日志引用的合法性。 */

function assertTaskHistoryLogRef(value: string, channel: "tasks" | "sandbox"): void {
  if (!isValidStorageRef(value) || !value.startsWith(`${channel}/`) || !value.endsWith(".jsonl")) {
    throw new Error(`task_history.log_ref must point to ${channel}/*.jsonl: ${value}`);
  }
}
/** 断言沙箱代码引用的合法性。 */

function assertSandboxCodeRef(value: string): void {
  if (!isValidStorageRef(value) || !value.startsWith("sandbox/") || !value.endsWith(".code.ts")) {
    throw new Error(`task_history.code_ref must point to sandbox/*.code.ts: ${value}`);
  }
}
/** 归一化未关闭任务的数量限制。 */

function normalizeUnclosedTaskLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_UNCLOSED_TASK_LIMIT;
  }

  assertPositiveInteger(limit, "limit");
  return limit;
}
/** 断言重放请求的 Bot 绑定是否匹配。 */

function assertReplayBotBinding(
  expectedBotId: string,
  actualBotId: string,
  fieldName: string,
): void {
  if (expectedBotId !== actualBotId) {
    throw new Error(`${fieldName} must match bot_id`);
  }
}
/** 比较未关闭任务候选者的优先级。 */

function compareUnclosedTaskCandidates(
  left: PersistedTaskStartedEventLogRecord,
  right: PersistedTaskStartedEventLogRecord,
): number {
  if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) {
    return right.seq - left.seq;
  }

  return Date.parse(right.created_at) - Date.parse(left.created_at);
}

/** 配置环境变量绑定定义。 */
export interface ConfigEnvBinding<
  TValue extends string | number | undefined = string | number | undefined,
> {
  /** 规范环境变量名。 */
  readonly envVar: string;
  /** 兼容读取的历史别名。 */
  readonly aliases: readonly string[];
  /** 省略时采用的默认值。 */
  readonly defaultValue: TValue;
}

/** PostgreSQL（关系型数据库） 连接池配置。 */
export interface PostgresPoolConfig {
  /** 最小连接数。 */
  readonly min: number;
  /** 最大连接数。 */
  readonly max: number;
}

/** PostgreSQL（关系型数据库） 连接参数。 */
export interface PostgresConfig {
  /** 主机名。 */
  readonly host: string;
  /** 端口。 */
  readonly port: number;
  /** 数据库名。 */
  readonly database: string;
  /** 用户名。 */
  readonly user: string;
  /** 密码。 */
  readonly password?: string;
  /** 连接池参数。 */
  readonly pool: PostgresPoolConfig;
}

/** Redis（缓存） 连接参数。 */
export interface RedisConfig {
  /** Redis URL。 */
  readonly url: string;
}

/** 日志保留期配置。 */
export interface LogRetentionConfig {
  /** PostgreSQL event_log 保留天数。 */
  readonly eventLogDays: number;
  /** tasks JSONL 保留天数。 */
  readonly taskLogDays: number;
  /** sandbox JSONL 保留天数。 */
  readonly sandboxLogDays: number;
  /** llm JSONL 保留天数。 */
  readonly llmLogDays: number;
}

/** JSONL（结构化日志） 根目录配置。 */
export interface LogsConfig {
  /** 日志根目录。 */
  readonly baseDir: string;
  /** 保留期配置。 */
  readonly retention: LogRetentionConfig;
}

/** Embedding（向量） 相关配置。 */
export interface EmbeddingConfig {
  /** 向量维度。 */
  readonly dimensions: number;
}

/** 运行时可消费的基础设施配置。 */
export interface DataConfig {
  /** PostgreSQL（关系型数据库） 配置。 */
  readonly postgres: PostgresConfig;
  /** Redis（缓存） 配置。 */
  readonly redis: RedisConfig;
  /** 日志配置。 */
  readonly logs: LogsConfig;
  /** Embedding（向量） 配置。 */
  readonly embedding: EmbeddingConfig;
}

/** Bot 级日志覆盖配置。 */
export interface BotLogsConfigOverlay {
  /** 可选日志根目录覆盖。 */
  readonly baseDir?: string;
  /** 可选日志保留期覆盖。 */
  readonly retention?: Partial<LogRetentionConfig>;
}

/** Bot 级 Embedding（向量） 覆盖配置。 */
export interface BotEmbeddingConfigOverlay {
  /** 可选维度覆盖。 */
  readonly dimensions?: number;
}

/** `bots.config`（机器人配置） 的强类型覆盖结构。 */
export interface BotConfigOverlay {
  /** 日志配置覆盖。 */
  readonly logs?: BotLogsConfigOverlay;
  /** Embedding（向量） 配置覆盖。 */
  readonly embedding?: BotEmbeddingConfigOverlay;
}

/** `PG_HOST` 配置绑定。 */
export const PG_HOST_ENV_BINDING = {
  envVar: "PG_HOST",
  aliases: [],
  defaultValue: "localhost",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_PORT` 配置绑定。 */
export const PG_PORT_ENV_BINDING = {
  envVar: "PG_PORT",
  aliases: [],
  defaultValue: 5432,
} as const satisfies ConfigEnvBinding<number>;

/** `PG_DATABASE` 配置绑定。 */
export const PG_DATABASE_ENV_BINDING = {
  envVar: "PG_DATABASE",
  aliases: [],
  defaultValue: "ts_core",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_USER` 配置绑定。 */
export const PG_USER_ENV_BINDING = {
  envVar: "PG_USER",
  aliases: [],
  defaultValue: "ts_core",
} as const satisfies ConfigEnvBinding<string>;

/** `PG_PASSWORD` 配置绑定。 */
export const PG_PASSWORD_ENV_BINDING = {
  envVar: "PG_PASSWORD",
  aliases: [],
  defaultValue: undefined,
} as const satisfies ConfigEnvBinding<string | undefined>;

/** `PG_POOL_MIN` 配置绑定。 */
export const PG_POOL_MIN_ENV_BINDING = {
  envVar: "PG_POOL_MIN",
  aliases: [],
  defaultValue: 2,
} as const satisfies ConfigEnvBinding<number>;

/** `PG_POOL_MAX` 配置绑定。 */
export const PG_POOL_MAX_ENV_BINDING = {
  envVar: "PG_POOL_MAX",
  aliases: [],
  defaultValue: 10,
} as const satisfies ConfigEnvBinding<number>;

/** `REDIS_URL` 配置绑定。 */
export const REDIS_URL_ENV_BINDING = {
  envVar: "REDIS_URL",
  aliases: [],
  defaultValue: "redis://localhost:6379",
} as const satisfies ConfigEnvBinding<string>;

/** `LOGS_BASE_DIR` 配置绑定。 */
export const LOGS_BASE_DIR_ENV_BINDING = {
  envVar: "LOGS_BASE_DIR",
  aliases: ["LOGS_DIR"],
  defaultValue: DEFAULT_LOGS_BASE_DIR,
} as const satisfies ConfigEnvBinding<string>;

/** `EVENT_LOG_RETENTION_DAYS` 配置绑定。 */
export const EVENT_LOG_RETENTION_ENV_BINDING = {
  envVar: "EVENT_LOG_RETENTION_DAYS",
  aliases: ["EVENT_RETENTION"],
  defaultValue: EVENT_LOG_RETENTION_DAYS,
} as const satisfies ConfigEnvBinding<number>;

/** `TASK_LOG_RETENTION_DAYS` 配置绑定。 */
export const TASK_LOG_RETENTION_ENV_BINDING = {
  envVar: "TASK_LOG_RETENTION_DAYS",
  aliases: ["TASK_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.tasks,
} as const satisfies ConfigEnvBinding<number>;

/** `SANDBOX_LOG_RETENTION_DAYS` 配置绑定。 */
export const SANDBOX_LOG_RETENTION_ENV_BINDING = {
  envVar: "SANDBOX_LOG_RETENTION_DAYS",
  aliases: ["SANDBOX_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.sandbox,
} as const satisfies ConfigEnvBinding<number>;

/** `LLM_LOG_RETENTION_DAYS` 配置绑定。 */
export const LLM_LOG_RETENTION_ENV_BINDING = {
  envVar: "LLM_LOG_RETENTION_DAYS",
  aliases: ["LLM_LOG_RETENTION"],
  defaultValue: JSONL_RETENTION_DAYS.llm,
} as const satisfies ConfigEnvBinding<number>;

/** `EMBEDDING_DIMENSIONS` 配置绑定。 */
export const EMBEDDING_DIMENSIONS_ENV_BINDING = {
  envVar: "EMBEDDING_DIMENSIONS",
  aliases: ["EMBED_DIM"],
  defaultValue: DEFAULT_EMBEDDING_DIMENSIONS,
} as const satisfies ConfigEnvBinding<number>;

/** 基础设施配置环境变量目录。 */
export const DATA_CONFIG_ENV_BINDINGS = Object.freeze({
  postgresHost: PG_HOST_ENV_BINDING,
  postgresPort: PG_PORT_ENV_BINDING,
  postgresDatabase: PG_DATABASE_ENV_BINDING,
  postgresUser: PG_USER_ENV_BINDING,
  postgresPassword: PG_PASSWORD_ENV_BINDING,
  postgresPoolMin: PG_POOL_MIN_ENV_BINDING,
  postgresPoolMax: PG_POOL_MAX_ENV_BINDING,
  redisUrl: REDIS_URL_ENV_BINDING,
  logsBaseDir: LOGS_BASE_DIR_ENV_BINDING,
  eventLogRetentionDays: EVENT_LOG_RETENTION_ENV_BINDING,
  taskLogRetentionDays: TASK_LOG_RETENTION_ENV_BINDING,
  sandboxLogRetentionDays: SANDBOX_LOG_RETENTION_ENV_BINDING,
  llmLogRetentionDays: LLM_LOG_RETENTION_ENV_BINDING,
  embeddingDimensions: EMBEDDING_DIMENSIONS_ENV_BINDING,
});

/** 可注入的环境变量快照。 */
export type DataConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * 创建基础设施配置（DataConfig）。
 *
 * 配置组合（Configuration Composition）：作为配置加载的组合根，统一环境变量与 Bot 级覆盖。
 *
 * 声明式配置：从环境变量快照和 Bot 配置中加载配置，提供一致的 DataConfig 视图。
 *
 * @param input 包含环境变量和 Bot 级覆盖配置的可选输入
 * @returns 最终生效的 DataConfig
 */
export function createDataConfig(
  input: {
    env?: DataConfigEnvironment;
    botConfig?: unknown;
  } = {},
): DataConfig {
  const baseConfig = createBaseDataConfig(input.env ?? {});
  const botConfig = createBotConfigOverlay(input.botConfig);

  return applyBotConfigOverlay(baseConfig, botConfig);
}

/**
 * 解析并校验 Bot 级覆盖配置。
 *
 * 动态配置守门员（Dynamic Config Gatekeeper）：校验非结构化输入并清洗为强类型的覆盖对象。
 *
 * 安全边界：通过白名单机制清洗 Bot 配置，防止非法或未知的 Key 干扰系统关键路径。
 *
 * @param input 原始 Bot 配置对象
 * @returns 经过校验和清洗的覆盖对象
 */
export function createBotConfigOverlay(input: unknown): BotConfigOverlay {
  if (input === undefined) {
    return Object.freeze({});
  }

  const overlay = asPlainObject(input, "botConfig");
  assertAllowedKeys(overlay, ["logs", "embedding"], "botConfig");

  const logsValue = overlay.logs;
  const embeddingValue = overlay.embedding;

  const normalizedLogs = logsValue === undefined ? undefined : normalizeBotLogsConfig(logsValue);
  const normalizedEmbedding =
    embeddingValue === undefined ? undefined : normalizeBotEmbeddingConfig(embeddingValue);

  return Object.freeze({
    ...(normalizedLogs === undefined ? {} : { logs: normalizedLogs }),
    ...(normalizedEmbedding === undefined ? {} : { embedding: normalizedEmbedding }),
  });
}

/**
 * 将 Bot 级覆盖合并到基础配置。
 *
 * 1. 配置合并策略（Merge Strategy）：实现“环境配置为底，Bot 配置覆盖”的级联合并。
 * 2. 运行时不可变性：确保生成的最终配置（DataConfig）是完全冻结的，防止运行时状态污染。
 * 3. 合并逻辑：例如，日志根目录（baseDir）和各目录的保留期（retention）会优先使用 Overlay 中的值。
 *
 * @param baseConfig 基础配置
 * @param overlay 覆盖配置
 * @returns 合并后的 DataConfig
 */
export function applyBotConfigOverlay(
  baseConfig: DataConfig,
  overlay: BotConfigOverlay,
): DataConfig {
  const mergedRetention = Object.freeze({
    eventLogDays: overlay.logs?.retention?.eventLogDays ?? baseConfig.logs.retention.eventLogDays,
    taskLogDays: overlay.logs?.retention?.taskLogDays ?? baseConfig.logs.retention.taskLogDays,
    sandboxLogDays:
      overlay.logs?.retention?.sandboxLogDays ?? baseConfig.logs.retention.sandboxLogDays,
    llmLogDays: overlay.logs?.retention?.llmLogDays ?? baseConfig.logs.retention.llmLogDays,
  });

  return Object.freeze({
    postgres: Object.freeze({
      host: baseConfig.postgres.host,
      port: baseConfig.postgres.port,
      database: baseConfig.postgres.database,
      user: baseConfig.postgres.user,
      ...(baseConfig.postgres.password === undefined
        ? {}
        : {
            password: baseConfig.postgres.password,
          }),
      pool: Object.freeze({
        min: baseConfig.postgres.pool.min,
        max: baseConfig.postgres.pool.max,
      }),
    }),
    redis: Object.freeze({
      url: baseConfig.redis.url,
    }),
    logs: Object.freeze({
      baseDir: overlay.logs?.baseDir ?? baseConfig.logs.baseDir,
      retention: mergedRetention,
    }),
    embedding: Object.freeze({
      dimensions: overlay.embedding?.dimensions ?? baseConfig.embedding.dimensions,
    }),
  });
}
/** 基于环境变量创建基础数据配置。 */

function createBaseDataConfig(env: DataConfigEnvironment): DataConfig {
  const poolMin = readPositiveInteger(env, PG_POOL_MIN_ENV_BINDING);
  const poolMax = readPositiveInteger(env, PG_POOL_MAX_ENV_BINDING);
  const password = readOptionalString(env, PG_PASSWORD_ENV_BINDING);

  if (poolMin > poolMax) {
    throw new Error("PG_POOL_MIN must be less than or equal to PG_POOL_MAX");
  }

  return Object.freeze({
    postgres: Object.freeze({
      host: readRequiredString(env, PG_HOST_ENV_BINDING),
      port: readPort(env, PG_PORT_ENV_BINDING),
      database: readRequiredString(env, PG_DATABASE_ENV_BINDING),
      user: readRequiredString(env, PG_USER_ENV_BINDING),
      ...(password === undefined
        ? {}
        : {
            password,
          }),
      pool: Object.freeze({
        min: poolMin,
        max: poolMax,
      }),
    }),
    redis: Object.freeze({
      url: readRequiredString(env, REDIS_URL_ENV_BINDING),
    }),
    logs: Object.freeze({
      baseDir: readRequiredString(env, LOGS_BASE_DIR_ENV_BINDING),
      retention: Object.freeze({
        eventLogDays: readPositiveInteger(env, EVENT_LOG_RETENTION_ENV_BINDING),
        taskLogDays: readPositiveInteger(env, TASK_LOG_RETENTION_ENV_BINDING),
        sandboxLogDays: readPositiveInteger(env, SANDBOX_LOG_RETENTION_ENV_BINDING),
        llmLogDays: readPositiveInteger(env, LLM_LOG_RETENTION_ENV_BINDING),
      }),
    }),
    embedding: Object.freeze({
      dimensions: readPositiveInteger(env, EMBEDDING_DIMENSIONS_ENV_BINDING),
    }),
  });
}
/** 归一化机器人日志配置参数。 */

function normalizeBotLogsConfig(input: unknown): BotLogsConfigOverlay {
  const logsConfig = asPlainObject(input, "botConfig.logs");
  assertAllowedKeys(logsConfig, ["baseDir", "retention"], "botConfig.logs");

  const retentionValue = logsConfig.retention;
  const normalizedRetention =
    retentionValue === undefined ? undefined : normalizeRetentionOverlay(retentionValue);
  const baseDir =
    logsConfig.baseDir === undefined
      ? undefined
      : normalizeRequiredString(logsConfig.baseDir, "botConfig.logs.baseDir");

  return Object.freeze({
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(normalizedRetention === undefined ? {} : { retention: normalizedRetention }),
  });
}
/** 归一化机器人向量模型配置参数。 */

function normalizeBotEmbeddingConfig(input: unknown): BotEmbeddingConfigOverlay {
  const embeddingConfig = asPlainObject(input, "botConfig.embedding");
  assertAllowedKeys(embeddingConfig, ["dimensions"], "botConfig.embedding");

  if (embeddingConfig.dimensions === undefined) {
    return Object.freeze({});
  }

  return Object.freeze({
    dimensions: normalizePositiveInteger(
      embeddingConfig.dimensions,
      "botConfig.embedding.dimensions",
    ),
  });
}
/** 归一化日志保留时长配置。 */

function normalizeRetentionOverlay(input: unknown): Partial<LogRetentionConfig> | undefined {
  const retention = asPlainObject(input, "botConfig.logs.retention");
  assertAllowedKeys(
    retention,
    ["eventLogDays", "taskLogDays", "sandboxLogDays", "llmLogDays"],
    "botConfig.logs.retention",
  );

  if (Object.keys(retention).length === 0) {
    return undefined;
  }

  return Object.freeze({
    ...(retention.eventLogDays === undefined
      ? {}
      : {
          eventLogDays: normalizePositiveInteger(
            retention.eventLogDays,
            "botConfig.logs.retention.eventLogDays",
          ),
        }),
    ...(retention.taskLogDays === undefined
      ? {}
      : {
          taskLogDays: normalizePositiveInteger(
            retention.taskLogDays,
            "botConfig.logs.retention.taskLogDays",
          ),
        }),
    ...(retention.sandboxLogDays === undefined
      ? {}
      : {
          sandboxLogDays: normalizePositiveInteger(
            retention.sandboxLogDays,
            "botConfig.logs.retention.sandboxLogDays",
          ),
        }),
    ...(retention.llmLogDays === undefined
      ? {}
      : {
          llmLogDays: normalizePositiveInteger(
            retention.llmLogDays,
            "botConfig.logs.retention.llmLogDays",
          ),
        }),
  });
}
/** 读取必填的字符串环境变量。 */

function readRequiredString(env: DataConfigEnvironment, binding: ConfigEnvBinding<string>): string {
  const value = readBindingValue(env, binding);

  if (typeof value !== "string") {
    throw new Error(`${binding.envVar} must resolve to a string value`);
  }

  return normalizeRequiredString(value, binding.envVar);
}
/** 读取可选的字符串环境变量。 */

function readOptionalString(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding<string | undefined>,
): string | undefined {
  const value = readBindingValue(env, binding);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${binding.envVar} must resolve to a string value`);
  }

  return normalizeRequiredString(value, binding.envVar);
}
/** 读取正整数类型的环境变量。 */

function readPositiveInteger(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding<number>,
): number {
  return normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);
}
/** 读取网络端口环境变量。 */

function readPort(env: DataConfigEnvironment, binding: ConfigEnvBinding<number>): number {
  const port = normalizePositiveInteger(readBindingValue(env, binding), binding.envVar);

  if (port > 65_535) {
    throw new Error(`${binding.envVar} must be a valid TCP port`);
  }

  return port;
}
/** 读取环境绑定的泛型值。 */

function readBindingValue(
  env: DataConfigEnvironment,
  binding: ConfigEnvBinding,
): string | number | undefined {
  const lookupKeys = [binding.envVar, ...binding.aliases];

  for (const key of lookupKeys) {
    const value = env[key];

    if (value !== undefined) {
      return value;
    }
  }

  return binding.defaultValue;
}
/** 归一化并校验必填字符串。 */

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return normalizedValue;
}
/** 归一化并校验正整数。 */

function normalizePositiveInteger(value: unknown, fieldName: string): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/.test(value.trim())
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return numericValue;
}
/** 将输入值转换为只读对象类型。 */

function asPlainObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}
/** 断言对象是否只包含允许的键名。 */

function assertAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  fieldName: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unsupported ${fieldName} key: ${key}`);
    }
  }
}
