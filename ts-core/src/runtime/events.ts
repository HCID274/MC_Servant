/**
 * 运行时事件定义与工厂。
 *
 * 1. 事件字典：维护系统所有运行时事件类型（bot.*, task.*, state.*, reflex.* 等）。
 * 2. 生命周期建模：定义任务在不同阶段（Accepted, Started, Discarded, Terminal）的详细事件载荷。
 * 3. 稳压适配：提供核心工厂函数，将运行时的 ExecJob 及其执行结果转换为标准化、不可变的 TaskLifecycleEvent。
 * 4. 统一入口：实现事件到 EventLogEntry 的包装逻辑，支撑系统的审计、追踪和实时推送功能。
 */

import { type EventLogEntry, EventLogLevel, type MessageSource } from "../domain/contracts.js";
import type { ThreatLevel, ThreatRuleId } from "../observation/contracts.js";
import type { BotStatus, InterruptSource } from "./contracts.js";
import {
  type ExecJob,
  type TaskDiscardReason,
  TaskHistoryStatus,
  type TaskTerminalStatus,
  isTaskTerminalStatus,
} from "./tasking.js";

/** 运行时事件类型常量表，用于集中收敛 event_log 名称。 */
export const RUNTIME_EVENT_TYPES = [
  "bot.ready",
  "bot.died",
  "bot.respawned",
  "bot.offline",
  "state.transition",
  "task.accepted",
  "task.started",
  "task.discarded",
  "step.progress",
  "task.completed",
  "task.failed",
  "task.interrupted",
  "reflex.triggered",
  "reflex.done",
  "intent.epoch_changed",
  "chat.reply",
] as const;

/** 运行时事件类型联合。 */
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/** 运行时事件日志结构。 */
export type RuntimeEventLogEntry = EventLogEntry<RuntimeEventType>;

/** 状态转换事件载荷。 */
export interface StateTransitionEventPayload {
  /** 起始状态。 */
  from: BotStatus;
  /** 目标状态。 */
  to: BotStatus;
}

/** 任务中断事件载荷。 */
export interface TaskInterruptedEventPayload {
  /** 任务标识。 */
  job_id: string;
  /** 中断来源。 */
  interrupt_source: InterruptSource;
  /** 中断原因。 */
  reason: string;
}

/** 任务状态事件载荷。 */
export interface TaskStatusEventPayload {
  /** 任务标识。 */
  job_id: string;
  /** 当前状态。 */
  status: TaskHistoryStatus;
}

/** 任务生命周期事件与状态之间的映射表。 */
export const TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS = Object.freeze({
  accepted: "task.accepted",
  started: "task.started",
  discarded: "task.discarded",
  completed: "task.completed",
  failed: "task.failed",
  interrupted: "task.interrupted",
} as const satisfies Record<TaskHistoryStatus, RuntimeEventType>);

/** 任务生命周期公共载荷。 */
export interface TaskLifecyclePayloadBase<TStatus extends TaskHistoryStatus> {
  /** 任务标识。 */
  readonly job_id: string;
  /** 任务状态。 */
  readonly status: TStatus;
  /** 执行任务类型。 */
  readonly type: ExecJob["type"];
  /** 原始用户消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly epoch: number;
}

/** 任务 accepted（已接受） 事件载荷。 */
export interface TaskAcceptedEventPayload
  extends TaskLifecyclePayloadBase<TaskHistoryStatus.Accepted> {
  /** 执行队列优先级。 */
  readonly priority: ExecJob["priority"];
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
}

/** 任务 started（已开始） 事件载荷。 */
export interface TaskStartedEventPayload
  extends TaskLifecyclePayloadBase<TaskHistoryStatus.Started> {}

/** 任务 discarded（已丢弃） 事件载荷。 */
export interface TaskDiscardedEventPayload
  extends TaskLifecyclePayloadBase<TaskHistoryStatus.Discarded> {
  /** 丢弃原因。 */
  readonly discard_reason: TaskDiscardReason;
  /** 当前最新意图纪元。 */
  readonly current_epoch?: number;
}

/** 任务终态公共载荷。 */
export interface TaskTerminalEventPayloadBase<TStatus extends TaskTerminalStatus>
  extends TaskLifecyclePayloadBase<TStatus> {
  /** 总步骤数。 */
  readonly total_steps: number;
  /** 总耗时。 */
  readonly duration_ms: number;
}

/** 任务 completed（已完成） 事件载荷。 */
export interface TaskCompletedEventPayload
  extends TaskTerminalEventPayloadBase<TaskHistoryStatus.Completed> {}

/** 任务 failed（已失败） 事件载荷中的错误快照。 */
export interface TaskFailedErrorSnapshot {
  /** 错误分类名。 */
  readonly name?: string;
  /** 错误消息。 */
  readonly message: string;
  /** 可选错误码。 */
  readonly error_code?: string;
}

/** 任务 failed（已失败） 事件载荷。 */
export interface TaskFailedEventPayload
  extends TaskTerminalEventPayloadBase<TaskHistoryStatus.Failed> {
  /** 失败错误快照。 */
  readonly error: TaskFailedErrorSnapshot;
  /** 最后一个已知步骤名。 */
  readonly last_step?: string;
}

/** 任务 interrupted（已中断） 事件载荷。 */
export interface TaskInterruptedLifecycleEventPayload
  extends TaskTerminalEventPayloadBase<TaskHistoryStatus.Interrupted> {
  /** 中断来源。 */
  readonly interrupt_source: InterruptSource;
  /** 中断原因。 */
  readonly reason: string;
}

/** 单条任务生命周期事件载荷联合。 */
export type TaskLifecycleEventPayload =
  | TaskAcceptedEventPayload
  | TaskStartedEventPayload
  | TaskDiscardedEventPayload
  | TaskCompletedEventPayload
  | TaskFailedEventPayload
  | TaskInterruptedLifecycleEventPayload;

/** 任务终态事件载荷联合。 */
export type TaskTerminalEventPayload =
  | TaskCompletedEventPayload
  | TaskFailedEventPayload
  | TaskInterruptedLifecycleEventPayload;

/** 按状态索引的任务生命周期事件载荷。 */
export type TaskLifecycleEventPayloadByStatus<TStatus extends TaskHistoryStatus> =
  TStatus extends TaskHistoryStatus.Accepted
    ? TaskAcceptedEventPayload
    : TStatus extends TaskHistoryStatus.Started
      ? TaskStartedEventPayload
      : TStatus extends TaskHistoryStatus.Discarded
        ? TaskDiscardedEventPayload
        : TStatus extends TaskHistoryStatus.Completed
          ? TaskCompletedEventPayload
          : TStatus extends TaskHistoryStatus.Failed
            ? TaskFailedEventPayload
            : TStatus extends TaskHistoryStatus.Interrupted
              ? TaskInterruptedLifecycleEventPayload
              : never;

/** 按状态索引的任务生命周期事件类型。 */
export type TaskLifecycleEventTypeByStatus<TStatus extends TaskHistoryStatus> =
  (typeof TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS)[TStatus];

/** 统一任务生命周期事件结构。 */
export interface TaskLifecycleEvent<TStatus extends TaskHistoryStatus = TaskHistoryStatus> {
  /** 生命周期状态。 */
  readonly status: TStatus;
  /** 对应的 runtime 事件类型。 */
  readonly event_type: TaskLifecycleEventTypeByStatus<TStatus>;
  /** 该状态对应的事件载荷。 */
  readonly payload: TaskLifecycleEventPayloadByStatus<TStatus>;
}

/** 反射触发事件载荷。 */
export interface ReflexTriggeredEventPayload {
  /** 规则标识。 */
  rule_id: ThreatRuleId;
  /** 威胁等级。 */
  threat_level: ThreatLevel;
  /** 参与评估的实体标识。 */
  entities: readonly string[];
}
/** 深度冻结任务相关数据对象。 */

function freezeTaskValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeTaskValue(item))) as T;
  }
  if (value && typeof value === "object") {
    const clonedEntries = Object.entries(value as Record<string, unknown>).map(
      ([key, entryValue]) => [key, freezeTaskValue(entryValue)],
    );

    return Object.freeze(Object.fromEntries(clonedEntries)) as T;
  }

  return value;
}
/** 创建任务生命周期事件载荷基类。 */

function createTaskLifecyclePayloadBase<TStatus extends TaskHistoryStatus>(
  job: ExecJob,
  status: TStatus,
): TaskLifecyclePayloadBase<TStatus> {
  return Object.freeze({
    job_id: job.message_id,
    status,
    type: job.type,
    message_id: job.message_id,
    epoch: job.intent_epoch,
  });
}

/** 判断给定字符串是否为合法运行时事件类型。 */
export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return RUNTIME_EVENT_TYPES.includes(value as RuntimeEventType);
}

/**
 * 创建最小运行时事件日志。
 *
 * 1. 系统适配：作为事件总线的“入站包装器”，负责将各种原子事件统一收口为符合领域模型的 RuntimeEventLogEntry。
 * 2. 追踪支持：默认使用 Info 级别，并支持可选的任务 ID 和 Bot ID 关联，为全链路日志追踪提供基础。
 *
 * @param input 包含事件 ID, 类型, 来源, 时间戳及可选属性的输入
 * @returns 标准化的运行时事件日志条目
 */
export function createRuntimeEventLogEntry(input: {
  eventId: string;
  type: RuntimeEventType;
  source: MessageSource;
  timestamp: string;
  payload?: Readonly<Record<string, unknown>>;
  taskId?: string;
  botId?: string;
}): RuntimeEventLogEntry {
  return {
    eventId: input.eventId,
    type: input.type,
    level: EventLogLevel.Info,
    source: input.source,
    timestamp: input.timestamp,
    ...(input.payload ? { payload: input.payload } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.botId ? { botId: input.botId } : {}),
  };
}

/**
 * 创建任务已接受（Accepted）生命周期事件。
 *
 * 1. 状态流转标识：标志着一个任务已成功通过初步校验并进入执行队列。
 * 2. 元数据补齐：专门记录任务的执行优先级和规划时的快照时间戳。
 *
 * @param job 待执行的任务对象
 * @returns 初始化的生命周期事件
 */
export function createTaskAcceptedLifecycleEvent(
  job: ExecJob,
): TaskLifecycleEvent<TaskHistoryStatus.Accepted> {
  return Object.freeze({
    status: TaskHistoryStatus.Accepted,
    event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.accepted,
    payload: Object.freeze({
      ...createTaskLifecyclePayloadBase(job, TaskHistoryStatus.Accepted),
      priority: job.priority,
      snapshot_ts: job.snapshot_ts,
    }),
  }) as TaskLifecycleEvent<TaskHistoryStatus.Accepted>;
}

/**
 * 创建任务已开始（Started）生命周期事件。
 *
 * 1. 运行时切换：当任务正式被 BotActor 认领并启动执行时触发。
 * 2. 状态锚点：标志着任务从“待处理”转为“运行中”，为性能统计提供起始点。
 *
 * @param job 正在执行的任务对象
 * @returns 状态更新后的生命周期事件
 */
export function createTaskStartedLifecycleEvent(
  job: ExecJob,
): TaskLifecycleEvent<TaskHistoryStatus.Started> {
  return Object.freeze({
    status: TaskHistoryStatus.Started,
    event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.started,
    payload: createTaskLifecyclePayloadBase(job, TaskHistoryStatus.Started),
  }) as TaskLifecycleEvent<TaskHistoryStatus.Started>;
}

/**
 * 创建任务已丢弃（Discarded）生命周期事件。
 *
 * 1. 异常处理：当任务因为意图纪元过期或环境快照失效而被拒绝执行时触发。
 * 2. 冲突诊断：包含具体的丢弃原因，并可选记录当前的最新纪元。
 *
 * @param input 包含任务、丢弃原因和当前纪元的输入
 * @returns 经过归类的生命周期事件
 */
export function createTaskDiscardedLifecycleEvent(input: {
  job: ExecJob;
  discard_reason: TaskDiscardReason;
  current_epoch?: number;
}): TaskLifecycleEvent<TaskHistoryStatus.Discarded> {
  if (input.discard_reason === "intent_epoch_stale" && input.current_epoch === undefined) {
    throw new Error("intent_epoch_stale discarded event requires current_epoch");
  }

  return Object.freeze({
    status: TaskHistoryStatus.Discarded,
    event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.discarded,
    payload: Object.freeze({
      ...createTaskLifecyclePayloadBase(input.job, TaskHistoryStatus.Discarded),
      discard_reason: input.discard_reason,
      ...(input.current_epoch !== undefined ? { current_epoch: input.current_epoch } : {}),
    }),
  }) as TaskLifecycleEvent<TaskHistoryStatus.Discarded>;
}

/**
 * 创建任务终态（Terminal）生命周期事件。
 *
 * 1. 结果收口：统一处理任务进入 Completed, Failed 或 Interrupted 终态时的事件生成。
 * 2. 效能审计：强制要求包含总步数和执行耗时，确保所有结束的任务都具备性能评估数据。
 * 3. 数据稳定性：对错误快照或中断来源数据执行深层冻结，防止后续变动。
 *
 * @param input 包含任务、终态、步数、耗时及状态特定信息的判别联合输入
 * @returns 终态生命周期事件
 */
export function createTaskTerminalLifecycleEvent(
  input:
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Completed;
        total_steps: number;
        duration_ms: number;
      }
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Failed;
        total_steps: number;
        duration_ms: number;
        error: TaskFailedErrorSnapshot;
        last_step?: string;
      }
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Interrupted;
        total_steps: number;
        duration_ms: number;
        interrupt_source: InterruptSource;
        reason: string;
      },
): TaskLifecycleEvent<TaskTerminalStatus> {
  if (!isTaskTerminalStatus(input.status)) {
    throw new Error(`Status ${input.status} is not a terminal task status`);
  }

  const basePayload = {
    ...createTaskLifecyclePayloadBase(input.job, input.status),
    total_steps: input.total_steps,
    duration_ms: input.duration_ms,
  };

  switch (input.status) {
    case TaskHistoryStatus.Completed:
      return Object.freeze({
        status: TaskHistoryStatus.Completed,
        event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.completed,
        payload: Object.freeze(basePayload),
      }) as TaskLifecycleEvent<TaskTerminalStatus>;
    case TaskHistoryStatus.Failed:
      return Object.freeze({
        status: TaskHistoryStatus.Failed,
        event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.failed,
        payload: Object.freeze({
          ...basePayload,
          error: freezeTaskValue(input.error),
          ...(input.last_step ? { last_step: input.last_step } : {}),
        }),
      }) as TaskLifecycleEvent<TaskTerminalStatus>;
    case TaskHistoryStatus.Interrupted:
      return Object.freeze({
        status: TaskHistoryStatus.Interrupted,
        event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.interrupted,
        payload: Object.freeze({
          ...basePayload,
          interrupt_source: freezeTaskValue(input.interrupt_source),
          reason: input.reason,
        }),
      }) as TaskLifecycleEvent<TaskTerminalStatus>;
  }

  throw new Error("Unhandled terminal task status");
}

/**
 * 将任务生命周期事件包裹为运行时事件日志条目。
 *
 * 1. 逻辑桥接：作为生命周期事件到系统通用日志条目的转换层。
 * 2. 全链路关联：解构载荷并投影到 EventLogEntry，显式建立 taskId 关联。
 *
 * @param input 包含事件 ID, 生命周期对象, 来源, 时间戳及 Bot ID 的输入
 * @returns 包装后的运行时事件日志
 */
export function createTaskLifecycleEventLogEntry<TStatus extends TaskHistoryStatus>(input: {
  eventId: string;
  lifecycle: TaskLifecycleEvent<TStatus>;
  source: MessageSource;
  timestamp: string;
  botId?: string;
}): RuntimeEventLogEntry {
  return createRuntimeEventLogEntry({
    eventId: input.eventId,
    type: input.lifecycle.event_type,
    source: input.source,
    timestamp: input.timestamp,
    payload: input.lifecycle.payload as unknown as Readonly<Record<string, unknown>>,
    taskId: input.lifecycle.payload.job_id,
    ...(input.botId ? { botId: input.botId } : {}),
  });
}
