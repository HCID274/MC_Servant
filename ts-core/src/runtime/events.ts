/**
 * 运行时事件工厂。
 *
 * 事件类型、载荷与生命周期结构已下沉到 core-ports（核心端口层）；本文件只保留运行时事件工厂函数。
 */

import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventLogEntry,
  type RuntimeEventType,
  TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS,
  type TaskFailedErrorSnapshot,
  type TaskLifecycleEvent,
  type TaskLifecycleEventTypeByStatus,
  type TaskLifecyclePayloadBase,
} from "../core-ports/events.js";
import { EventLogLevel, type MessageSource } from "../core-ports/foundation.js";
import type { InterruptSource } from "../core-ports/runtime.js";
import type { TaskResultSummary } from "../core-ports/task-result.js";
import type { TaskTerminalStatus } from "../core-ports/tasking.js";
import {
  type ExecJob,
  type TaskDiscardReason,
  TaskHistoryStatus,
  isTaskTerminalStatus,
} from "../core-ports/tasking.js";

export {
  RUNTIME_EVENT_TYPES,
  TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS,
  type ReflexTriggeredEventPayload,
  type RuntimeEventLogEntry,
  type RuntimeEventType,
  type StateTransitionEventPayload,
  type TaskAcceptedEventPayload,
  type TaskCompletedEventPayload,
  type TaskDiscardedEventPayload,
  type TaskFailedErrorSnapshot,
  type TaskFailedEventPayload,
  type TaskInterruptedEventPayload,
  type TaskInterruptedLifecycleEventPayload,
  type TaskLifecycleEvent,
  type TaskLifecycleEventPayload,
  type TaskLifecyclePayloadBase,
  type TaskLifecycleEventPayloadByStatus,
  type TaskLifecycleEventTypeByStatus,
  type TaskStartedEventPayload,
  type TaskStatusEventPayload,
  type TaskTerminalEventPayload,
  type TaskTerminalEventPayloadBase,
} from "../core-ports/events.js";

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

/** 创建最小运行时事件日志。 */
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

/** 创建任务已接受（Accepted） 生命周期事件。 */
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

/** 创建任务已开始（Started） 生命周期事件。 */
export function createTaskStartedLifecycleEvent(
  job: ExecJob,
): TaskLifecycleEvent<TaskHistoryStatus.Started> {
  return Object.freeze({
    status: TaskHistoryStatus.Started,
    event_type: TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS.started,
    payload: createTaskLifecyclePayloadBase(job, TaskHistoryStatus.Started),
  }) as TaskLifecycleEvent<TaskHistoryStatus.Started>;
}

/** 创建任务已丢弃（Discarded） 生命周期事件。 */
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

/** 创建任务终态（Terminal） 生命周期事件。 */
export function createTaskTerminalLifecycleEvent(
  input:
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Completed;
        total_steps: number;
        duration_ms: number;
        result_summary?: TaskResultSummary;
      }
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Failed;
        total_steps: number;
        duration_ms: number;
        error: TaskFailedErrorSnapshot;
        last_step?: string;
        result_summary?: TaskResultSummary;
      }
    | {
        job: ExecJob;
        status: TaskHistoryStatus.Interrupted;
        total_steps: number;
        duration_ms: number;
        interrupt_source: InterruptSource;
        reason: string;
        result_summary?: TaskResultSummary;
      },
): TaskLifecycleEvent<TaskTerminalStatus> {
  if (!isTaskTerminalStatus(input.status)) {
    throw new Error(`Status ${input.status} is not a terminal task status`);
  }

  const basePayload = {
    ...createTaskLifecyclePayloadBase(input.job, input.status),
    total_steps: input.total_steps,
    duration_ms: input.duration_ms,
    ...(input.result_summary === undefined
      ? {}
      : { result_summary: freezeTaskValue(input.result_summary) }),
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
}

/** 将任务生命周期事件包裹为运行时事件日志条目。 */
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
