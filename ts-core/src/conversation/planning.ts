/**
 * 对话规划与任务转换逻辑。
 *
 * 1. 规划上下文构建：封装并校验进入 LLM 规划阶段所需的上下文信息。
 * 2. 规划产物工厂：提供标准化的技能调用（SkillCall）和沙箱代码（SandboxCode）规划草案生成函数。
 * 3. 跨层对接：负责将对话层的规划产物（PlanDraft）转换为执行层可直接消费的任务对象（ExecJob）。
 */

import { ExecutionTaskKind } from "../core-ports/foundation.js";
import type { SkillCallInput } from "../core-ports/skills.js";
import type {
  ExecJob,
  ExecPriority,
  SkillCallJob,
  SkillCallJobInput,
} from "../core-ports/tasking.js";
import { createSandboxCodeJob, createSkillCallJob } from "../core-ports/tasking.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
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
 * 1. 规划边界校验（Planning Boundary Validation）：封装并校验进入 LLM 规划阶段所需的上下文信息。
 * 2. 数据完整性：确保规划输入满足 Stage 2-Plan（第二阶段规划） 的最小契约。
 * 3. 状态约束：强制要求所有规划输入必须经过克隆（Readonly），防止规划过程中意外修改原始消息状态。
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

  return cloneReadonlyValue(input);
}

/**
 * 创建技能调用路径的规划产物。
 *
 * 技能草案工厂（Skill Draft Factory）：将 LLM 生成的回复和技能参数封装为标准化的 SkillCallDraft。
 *
 * 模式对齐：确保回复文本已完成性格化处理（ensureReplyEndsWithMeow），且技能参数符合技能目录的契约要求。
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
 * 代码草案工厂（Code Draft Factory）：将 LLM 生成的回复和待执行源码封装为标准化的 SandboxCodeDraft。
 *
 * 安全封装：将原始代码片段包装为符合执行契约的草案对象，并应用性格化回复。
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
 * 跨层翻译（Cross-Layer Translation）：负责将对话层的“规划草案”转换为执行层可直接消费的任务对象（ExecJob）。
 *
 * 任务关联：建立对话消息元数据（Message ID, Epoch, Snapshot TS）与任务实例之间的强关联，确保任务执行的可追溯性。
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
