/**
 * 对话规划与任务转换逻辑。
 *
 * 1. 规划上下文构建：封装并校验进入 LLM 规划阶段所需的上下文信息。
 * 2. 规划产物工厂：提供唯一 TS（TypeScript）代码规划草案生成函数。
 * 3. 跨层对接：负责将对话层的规划产物（PlanDraft）转换为执行层可直接消费的任务对象（ExecJob）。
 */

import type { ExecJob, ExecPriority } from "../core-ports/tasking.js";
import { createCodeJob } from "../core-ports/tasking.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import type {
  ConversationCodePlanDraft,
  ConversationPlanDraft,
  ConversationPlanningContext,
  ConversationPlanningTriage,
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
 * 创建沙箱代码执行路径的规划产物。
 *
 * 代码草案工厂（Code Draft Factory）：将 LLM（大语言模型） 生成的待执行源码封装为标准化的 CodeDraft。
 *
 * 安全封装：将原始代码片段包装为符合执行契约的草案对象。
 *
 * @param input 包含代码的输入
 * @returns 代码规划草案
 */
export function createCodePlanDraft(input: {
  code: string;
}): ConversationCodePlanDraft {
  assertNonEmptyString(input.code, "code");

  return cloneReadonlyValue({
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
  recovery_chain_id?: string;
  replan_count?: number;
}): ExecJob {
  assertNonEmptyString(input.message_id, "message_id");

  return createCodeJob({
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: input.plan.code,
    ...(input.recovery_chain_id === undefined
      ? {}
      : { recovery_chain_id: input.recovery_chain_id }),
    ...(input.replan_count === undefined ? {} : { replan_count: input.replan_count }),
  });
}

export type { ConversationPlanningTriage };
