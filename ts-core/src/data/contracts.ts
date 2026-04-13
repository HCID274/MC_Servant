import { ExecutionTaskKind, MessageSource } from "../domain/contracts.js";
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventLogEntry,
  type RuntimeEventType,
} from "../runtime/events.js";
import { type ExecJob, type InterruptedTaskRecord, TaskHistoryStatus } from "../runtime/tasking.js";

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

/** event_log 表 payload 结构。 */
export type PersistedEventPayload = RuntimeEventLogEntry["payload"];

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
