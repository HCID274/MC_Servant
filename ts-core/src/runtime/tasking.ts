import { ConversationPriority, ExecutionTaskKind } from "../domain/contracts.js";
import type { InterruptSource } from "./contracts.js";

/** 执行队列可接受的优先级枚举。 */
export enum ExecPriority {
  Urgent = "urgent",
  Normal = "normal",
  Background = "background",
}

/** 任务历史状态枚举，用于对齐 task_history 的单向状态流转。 */
export enum TaskHistoryStatus {
  Accepted = "accepted",
  Started = "started",
  Completed = "completed",
  Failed = "failed",
  Interrupted = "interrupted",
  Discarded = "discarded",
}

/** 执行任务公共字段。 */
export interface ExecJobBase {
  /** 执行任务类型。 */
  type: ExecutionTaskKind;
  /** 原始用户消息标识。 */
  message_id: string;
  /** 意图纪元。 */
  intent_epoch: number;
  /** 规划时快照时间戳。 */
  snapshot_ts: number;
  /** 执行队列优先级。 */
  priority: ExecPriority;
}

/** skill_call 执行任务结构。 */
export interface SkillCallJob extends ExecJobBase {
  /** 固定为 skill_call。 */
  type: ExecutionTaskKind.SkillCall;
  /** 技能名。 */
  skill: string;
  /** 技能参数。 */
  params: Readonly<Record<string, unknown>>;
}

/** sandbox_code 执行任务结构。 */
export interface SandboxCodeJob extends ExecJobBase {
  /** 固定为 sandbox_code。 */
  type: ExecutionTaskKind.SandboxCode;
  /** 沙箱代码。 */
  code: string;
}

/** BotActor 可消费的执行任务联合。 */
export type ExecJob = SkillCallJob | SandboxCodeJob;

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

/** 创建 skill_call 执行任务。 */
export function createSkillCallJob(input: {
  message_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  priority: ExecPriority;
  skill: string;
  params: Readonly<Record<string, unknown>>;
}): SkillCallJob {
  return {
    type: ExecutionTaskKind.SkillCall,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    skill: input.skill,
    params: input.params,
  };
}

/** 创建 sandbox_code 执行任务。 */
export function createSandboxCodeJob(input: {
  message_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  priority: ExecPriority;
  code: string;
}): SandboxCodeJob {
  return {
    type: ExecutionTaskKind.SandboxCode,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: input.code,
  };
}
