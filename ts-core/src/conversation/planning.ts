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

/** 创建 Stage 2（第二阶段） 规划上下文，并锁死 `modify`（修改） 的补充信息要求。 */
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

/** 创建 `skill_call`（技能调用） 路径的只读规划产物。 */
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

/** 创建 `sandbox_code`（沙箱代码） 路径的只读规划产物。 */
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

/** 将规划产物包装成运行时可消费的 ExecJob（执行任务）。 */
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
