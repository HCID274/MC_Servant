/**
 * 运行时事件端口契约。
 *
 * 运行时事件类型与生命周期载荷会被 runtime（运行时）、workers（工作线程）、
 * diagnostics（诊断）、interfaces（接口） 与 data（数据层） 共同消费，因此集中在端口层。
 */

import type { EventLogEntry } from "./foundation.js";
import type { ThreatLevel, ThreatRuleId } from "./observation.js";
import type { BotStatus, InterruptSource } from "./runtime.js";
import type { TaskResultSummary } from "./task-result.js";
import type {
  ExecJob,
  TaskDiscardReason,
  TaskHistoryStatus,
  TaskTerminalStatus,
} from "./tasking.js";

/** 运行时事件类型常量表，用于集中收敛 event_log（事件日志） 名称。 */
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
  /** 恢复链路 ID；非恢复任务为空。 */
  readonly recovery_chain_id?: string;
  /** 当前恢复链路内的重规划次数。 */
  readonly replan_count?: number;
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
  /** 任务终态结果摘要，用于 UI（用户界面） 和聊天模板展示。 */
  readonly result_summary?: TaskResultSummary;
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
  /** 可选结构化诊断上下文。 */
  readonly details?: Readonly<Record<string, unknown>>;
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
  /** 对应的 runtime（运行时） 事件类型。 */
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
