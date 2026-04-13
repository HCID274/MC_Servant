import { type EventLogEntry, EventLogLevel, type MessageSource } from "../domain/contracts.js";
import type { ThreatLevel, ThreatRuleId } from "../observation/contracts.js";
import type { BotStatus, InterruptSource } from "./contracts.js";
import type { TaskHistoryStatus } from "./tasking.js";

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

/** 反射触发事件载荷。 */
export interface ReflexTriggeredEventPayload {
  /** 规则标识。 */
  rule_id: ThreatRuleId;
  /** 威胁等级。 */
  threat_level: ThreatLevel;
  /** 参与评估的实体标识。 */
  entities: readonly string[];
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
