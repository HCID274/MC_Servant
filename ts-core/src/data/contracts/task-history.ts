import type { TaskFailedErrorSnapshot } from "../../core-ports/events.js";
import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import {
  type ExecJob,
  TaskHistoryStatus,
  type TaskTerminalStatus,
} from "../../core-ports/tasking.js";
import {
  type PersistedTaskStartedEventLogRecord,
  type PersistedTaskTerminalEventLogRecord,
  createPersistedEventLogRecord,
} from "./event-log.js";
import type { PersistedInterruptSource, PersistedTaskType } from "./tables.js";
import {
  assertNonNegativeInteger,
  assertPersistedIdentifier,
  assertPersistedTimestamp,
  assertPositiveInteger,
  assertReplayBotBinding,
  assertSandboxCodeRef,
  assertTaskHistoryLogRef,
  clonePersistedValue,
  compareUnclosedTaskCandidates,
  normalizeUnclosedTaskLimit,
} from "./utils.js";

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
