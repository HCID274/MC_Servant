/**
 * 对话规划与任务转换逻辑。
 * 
 * 架构职责：
 * 1. 规划上下文构建：封装并校验进入 LLM 规划阶段所需的上下文信息，确保 modify 等特殊意图的完整性。
 * 2. 规划产物工厂：提供标准化的技能调用（SkillCall）和沙箱代码（SandboxCode）规划草案生成函数。
 * 3. 跨层对接：负责将对话层的规划产物（PlanDraft）转换为执行层可直接消费的任务对象（ExecJob）。
 */

import { ExecutionTaskKind } from "../domain/contracts.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import type { ExecJob, ExecPriority, SkillCallJob, SkillCallJobInput } from "../runtime/tasking.js";
import { createSandboxCodeJob, createSkillCallJob } from "../runtime/tasking.js";
import type { SkillCallInput } from "../skills/contracts.js";
import { ensureReplyEndsWithMeow } from "./chat.js";
import type {
  ConversationPlanDraft,
  ConversationPlanningContext,
  ConversationPlanningTriage,
  ConversationSandboxCodePlanDraft,
  ConversationSkillCallPlanDraft,
} from "./contracts.js";

/**
 * 创建对话规划上下文。
 * 
 * 架构意图：
 * 1. 数据校验：确保进入 LLM 规划阶段的基础元数据（Bot ID, Message ID, Content）完整。
 * 2. 状态约束：强制要求 modify 意图必须携带被中断任务的信息。
 * 
 * @param input 规划上下文输入
 * @returns 经过校验和克隆的只读上下文
 */
export function createConversationPlanningContext(
  input: ConversationPlanningContext,
): ConversationPlanningContext {
  assertNonEmptyString(input.message.bot_id, "message.bot_id");
  assertNonEmptyString(input.message.message_id, "message.message_id");
  assertNonEmptyString(input.message.content, "message.content");
  assertNonEmptyString(input.snapshot_context, "snapshot_context");
  assertNonEmptyString(input.triage.reason, "triage.reason");

  if (input.triage.intent === "modify" && input.interrupted_task === undefined) {
    throw new Error("modify planning context must include interrupted_task");
  }

  return cloneReadonlyValue(input);
}

/**
 * 创建技能调用路径的规划产物。
 * 
 * 架构意图：
 * 将 LLM 生成的回复和技能参数封装为标准化的 SkillCallDraft。
 * 
 * @param input 包含回复、技能名和参数的输入
 * @returns 技能调用规划草案
 */
export function createSkillCallPlanDraft<TInput extends SkillCallInput>(input: {
  reply: string;
  skill: TInput["skill"];
  params: TInput["params"];
}): Extract<ConversationSkillCallPlanDraft, { skill: TInput["skill"] }> {
  assertNonEmptyString(input.reply, "reply");

  return cloneReadonlyValue({
    type: ExecutionTaskKind.SkillCall,
    reply: ensureReplyEndsWithMeow(input.reply),
    skill: input.skill,
    params: input.params,
  }) as Extract<ConversationSkillCallPlanDraft, { skill: TInput["skill"] }>;
}

/**
 * 创建沙箱代码执行路径的规划产物。
 * 
 * 架构意图：
 * 将 LLM 生成的回复和待执行源码封装为标准化的 SandboxCodeDraft。
 * 
 * @param input 包含回复和代码的输入
 * @returns 沙箱代码规划草案
 */
export function createSandboxCodePlanDraft(input: {
  reply: string;
  code: string;
}): ConversationSandboxCodePlanDraft {
  assertNonEmptyString(input.reply, "reply");
  assertNonEmptyString(input.code, "code");

  return cloneReadonlyValue({
    type: ExecutionTaskKind.SandboxCode,
    reply: ensureReplyEndsWithMeow(input.reply),
    code: input.code,
  });
}

/**
 * 将规划产物包装成运行时可消费的执行任务。
 * 
 * 架构意图：
 * 负责将对话层的“规划构想”转换为执行层的“可执行单元（Job）”，
 * 建立对话消息元数据（Message ID, Epoch, Snapshot TS）与任务实例之间的关联。
 * 
 * @param input 包含规划草案、消息 ID、纪元、时间戳和优先级的输入
 * @returns 对应的运行时任务对象
 */
export function createExecJobFromPlan(input: {
  plan: ConversationPlanDraft;
  message_id: string;
  intent_epoch: number;
  snapshot_ts: number;
  priority: ExecPriority;
}): ExecJob {
  assertNonEmptyString(input.message_id, "message_id");

  if (input.plan.type === ExecutionTaskKind.SkillCall) {
    return createSkillCallJob({
      message_id: input.message_id,
      intent_epoch: input.intent_epoch,
      snapshot_ts: input.snapshot_ts,
      priority: input.priority,
      skill: input.plan.skill,
      params: input.plan.params,
    } as SkillCallJobInput) as SkillCallJob;
  }

  return createSandboxCodeJob({
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: input.plan.code,
  });
}

export type { ConversationPlanningTriage };
