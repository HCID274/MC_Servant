/**
 * 运行时任务建模与工厂。
 *
 * 架构职责：
 * 1. 任务全生命周期定义：通过 TaskHistoryStatus 定义任务从接受、开始到完成、失败、中断或丢弃的完整状态机。
 * 2. 执行任务建模：定义 ExecJob 及其子类（SkillCallJob, SandboxCodeJob），封装任务执行所需的全部元数据。
 * 3. 优先级映射：实现对话优先级到执行队列优先级的转换逻辑。
 * 4. 任务工厂：提供标准化的工厂函数，确保生成的任务对象是强类型、不可变且符合执行契约的。
 */

import { ConversationPriority, ExecutionTaskKind } from "../domain/contracts.js";
import {
  type SkillCall,
  type SkillCallInput,
  type SkillName,
  createSkillCall,
} from "../skills/index.js";
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
export interface SkillCallJobFor<TName extends SkillName> extends ExecJobBase {
  /** 固定为 skill_call。 */
  type: ExecutionTaskKind.SkillCall;
  /** 与技能目录对齐的 skill_call 结构。 */
  readonly skillCall: SkillCall<TName>;
  /** 技能名。 */
  readonly skill: TName;
  /** 技能参数。 */
  readonly params: SkillCall<TName>["params"];
}

/** BotActor 可消费的 `skill_call`（技能调用） 执行任务联合。 */
export type SkillCallJob = {
  [TName in SkillName]: SkillCallJobFor<TName>;
}[SkillName];

/** 创建 `skill_call`（技能调用） 执行任务时允许的输入联合。 */
export type SkillCallJobInput = {
  [TName in SkillName]: {
    message_id: string;
    intent_epoch: number;
    snapshot_ts: number;
    priority: ExecPriority;
  } & SkillCall<TName>;
}[SkillName];

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

/**
 * 由对话优先级推导执行队列优先级。
 *
 * 1. 优先级映射：建立用户对话感知的紧迫度与底层调度引擎优先级之间的映射。
 * 2. 行为区分：Interrupt 优先级返回 null，因其代表立即执行的信号而非排队权重。
 *
 * @param priority 对话优先级
 * @returns 对应的执行优先级或 null
 */
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

/**
 * 创建技能调用执行任务。
 *
 * 1. 契约聚合：将技能目录中的业务逻辑与运行时的调度元数据（纪元、优先级等）相结合。
 * 2. 强类型保障：产出可被 BotActor 直接消费的任务对象，并确保其满足特定技能的参数契约。
 *
 * @param input 包含调度元数据和技能调用详情的输入
 * @returns 强类型的技能调用任务对象
 */
export function createSkillCallJob<TInput extends SkillCallJobInput>(
  input: TInput,
): Extract<SkillCallJob, { skill: TInput["skill"] }> {
  const skillCall = createSkillCall({
    skill: input.skill,
    params: input.params,
  } as Extract<SkillCallInput, { skill: TInput["skill"] }>);

  return Object.freeze({
    type: ExecutionTaskKind.SkillCall,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    skillCall,
    skill: skillCall.skill,
    params: skillCall.params,
  }) as unknown as Extract<SkillCallJob, { skill: TInput["skill"] }>;
}

/**
 * 创建沙箱代码执行任务。
 *
 * 1. 模型统一：将待执行源码包装为标准任务，使其与技能调用共享一致的调度与生命周期管理模型。
 *
 * @param input 包含调度元数据和源代码的输入
 * @returns 经过冻结的沙箱代码任务对象
 */
export function createSandboxCodeJob(input: {
  message_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  priority: ExecPriority;
  code: string;
}): SandboxCodeJob {
  return Object.freeze({
    type: ExecutionTaskKind.SandboxCode,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: input.code,
  });
}
