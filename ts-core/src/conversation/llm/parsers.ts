import type { ConversationCompositeTriage } from "../contracts.js";
import { createConversationCompositeTriageFromRecord, createMessageTriage } from "../triage.js";
import { ConversationLlmPlanError, ConversationLlmSkillNotEnabledError } from "./errors.js";
import type { OpenAiCompatibleChatCompletionResponse } from "./http.js";
import { createConversationSkillPlanFromTable } from "./skill-plan-table.js";
import type { ConversationLlmPlanResult } from "./types.js";

/** 提取 OpenAI 兼容返回中的回复文本。 */
export function extractAssistantReply(payload: OpenAiCompatibleChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("LLM response does not contain assistant text");
}

/** 解析分诊阶段返回。 */
export function parseConversationTriage(content: string): ReturnType<typeof createMessageTriage> {
  const record = parseJsonRecord(content);

  return createMessageTriage({
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    ...(typeof record.priority === "string" ? { priority: record.priority } : {}),
    ...(typeof record.reason === "string"
      ? { reason: record.reason }
      : { reason: "llm_triage_fallback" }),
  });
}

/** 解析复合分诊阶段返回，兼容旧 `{intent, priority, reason}`（旧分诊结构）。 */
export function parseConversationCompositeTriage(content: string): ConversationCompositeTriage {
  return createConversationCompositeTriageFromRecord(parseJsonRecord(content));
}

/** 解析最小单技能 `skill_call`（技能调用） 规划返回。 */
export function parseConversationSkillPlan(content: string): ConversationLlmPlanResult {
  const record = parseJsonRecord(content);

  if (record.type === "cannot_plan") {
    if (isSkillNotEnabledCannotPlan(record)) {
      throw new ConversationLlmSkillNotEnabledError("skill is not enabled for online execution");
    }

    throw new ConversationLlmPlanError(
      typeof record.reason === "string" && record.reason.trim().length > 0
        ? record.reason
        : "planner cannot determine a valid executable skill",
    );
  }

  if (record.type !== "skill_call") {
    throw new ConversationLlmPlanError("planner must return type=skill_call or type=cannot_plan");
  }

  if (typeof record.reply !== "string" || record.reply.trim().length === 0) {
    throw new ConversationLlmPlanError("planner reply must be a non-empty string");
  }

  return createConversationSkillPlanFromTable({
    reply: record.reply,
    skill: record.skill,
    params: record.params,
  });
}

/** 从 assistant（助手） 文本中提取 JSON（结构化数据） 对象。 */
export function parseJsonRecord(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const normalized = fencedMatch?.[1]?.trim() ?? extractBraceWrappedJson(trimmed) ?? trimmed;
  const parsed = JSON.parse(normalized) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM response must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

/** 尝试从混合文本中截取首尾大括号包裹的 JSON（结构化数据） 对象。 */
export function extractBraceWrappedJson(content: string): string | undefined {
  const firstBraceIndex = content.indexOf("{");
  const lastBraceIndex = content.lastIndexOf("}");

  if (firstBraceIndex === -1 || lastBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) {
    return undefined;
  }

  return content.slice(firstBraceIndex, lastBraceIndex + 1);
}

function isSkillNotEnabledCannotPlan(record: Record<string, unknown>): boolean {
  return (
    record.reason === "skill_not_enabled" ||
    record.code === "skill_not_enabled" ||
    record.reason === "技能未启用" ||
    record.reason === "未通过单技能验收"
  );
}
