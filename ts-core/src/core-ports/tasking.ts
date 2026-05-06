/**
 * 执行任务端口契约。
 *
 * ExecJob（执行任务）、任务历史状态与任务工厂被 conversation（对话）、workers（工作线程）、
 * runtime（运行时）、sandbox（沙箱）、diagnostics（诊断） 和 data（数据层） 共享，统一放在端口层。
 */

import { ConversationPriority, ExecutionTaskKind } from "./foundation.js";
import type { InterruptSource } from "./runtime.js";

/** 执行队列可接受的优先级枚举。 */
export enum ExecPriority {
  Urgent = "urgent",
  Normal = "normal",
  Background = "background",
}

/** 任务历史状态枚举，用于对齐 task_history（任务历史） 的单向状态流转。 */
export enum TaskHistoryStatus {
  Accepted = "accepted",
  Started = "started",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
  Discarded = "discarded",
}

/** 任务生命周期状态清单，用于集中维护 task_history（任务历史） 六态。 */
export const TASK_HISTORY_STATUSES = [
  TaskHistoryStatus.Accepted,
  TaskHistoryStatus.Started,
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
  TaskHistoryStatus.Discarded,
] as const;

/** 可进入 BrainWorker（摘要工作线程） 的真实终态清单。 */
export const TASK_TERMINAL_STATUSES = [
  TaskHistoryStatus.Completed,
  TaskHistoryStatus.Failed,
  TaskHistoryStatus.Interrupted,
] as const;

/** 任务被丢弃时允许的原因枚举。 */
export const TASK_DISCARD_REASONS = ["intent_epoch_stale", "snapshot_stale"] as const;

/** 可进入 BrainWorker（摘要工作线程） 的真实终态联合。 */
export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

/** 任务被丢弃时的原因联合。 */
export type TaskDiscardReason = (typeof TASK_DISCARD_REASONS)[number];

/** 判断给定状态是否属于真实终态（已完成、已失败或已中断）。 */
export function isTaskTerminalStatus(status: TaskHistoryStatus): status is TaskTerminalStatus {
  return TASK_TERMINAL_STATUSES.includes(status as TaskTerminalStatus);
}

/** 代码执行任务结构。 */
export interface CodeJob {
  /** 固定为 code（代码）。 */
  readonly type: ExecutionTaskKind.Code;
  /** 原始用户消息标识。 */
  readonly message_id: string;
  /** 意图纪元。 */
  readonly intent_epoch: number;
  /** 规划时快照时间戳。 */
  readonly snapshot_ts: number;
  /** 执行队列优先级。 */
  readonly priority: ExecPriority;
  /** 待执行 TS（TypeScript）代码。 */
  readonly code: string;
}

/** BotActor（机器人执行代理） 可消费的唯一执行任务。 */
export type ExecJob = CodeJob;

/** 任务被中断后的最小记录结构。 */
export interface InterruptedTaskRecord {
  /** 任务标识。 */
  message_id: string;
  /** 任务历史状态。 */
  status: TaskHistoryStatus.Interrupted;
  /** 中断来源。 */
  interrupt_source: InterruptSource;
}

/** 由对话优先级推导执行队列优先级。 */
export function toExecPriority(priority: ConversationPriority): ExecPriority | null {
  switch (priority) {
    case ConversationPriority.Interrupt:
      return null;
    case ConversationPriority.Urgent:
      return ExecPriority.Urgent;
    case ConversationPriority.Normal:
      return ExecPriority.Normal;
    case ConversationPriority.Background:
      return ExecPriority.Background;
  }
}

/** 创建代码执行任务。 */
export function createCodeJob(input: {
  message_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  priority: ExecPriority;
  code: string;
}): CodeJob {
  return Object.freeze({
    type: ExecutionTaskKind.Code,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: input.code,
  });
}
