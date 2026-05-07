import type { ConversationCompositeTriage } from "../contracts.js";
import { createCodePlanDraft } from "../planning.js";
import { createConversationCompositeTriageFromRecord } from "../triage.js";
import { ConversationLlmPlanError } from "./errors.js";
import type { OpenAiCompatibleChatCompletionResponse } from "./http.js";
import type {
  ConversationLlmPlanGateFailureType,
  ConversationLlmPlanResult,
  ConversationLlmToolCall,
} from "./types.js";

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

/** 提取 OpenAI compatible（OpenAI 兼容） assistant（助手） tool calls（工具调用）。 */
export function extractAssistantToolCalls(
  payload: OpenAiCompatibleChatCompletionResponse,
): readonly ConversationLlmToolCall[] {
  return payload.choices?.[0]?.message?.tool_calls ?? [];
}

/** 解析复合分诊阶段返回。 */
export function parseConversationCompositeTriage(content: string): ConversationCompositeTriage {
  return createConversationCompositeTriageFromRecord(parseJsonRecord(content));
}

/** 解析 Stage 2-Plan（第二阶段规划） 的唯一 TS（TypeScript）代码输出。 */
export function parseConversationCodePlan(content: string): ConversationLlmPlanResult {
  const record = parseStrictPlanJsonRecord(content);
  const keys = Object.keys(record);
  const forbiddenKey = keys.find((key) => PLAN_FORBIDDEN_KEYS.has(key));

  if (forbiddenKey !== undefined) {
    throw createCodeOnlyPlanError(`planner output field ${forbiddenKey} is not allowed`);
  }
  if (keys.length !== 1 || keys[0] !== "code") {
    throw createCodeOnlyPlanError("planner output must be a JSON object with only code field");
  }
  if (typeof record.code !== "string" || record.code.trim().length === 0) {
    throw createCodeOnlyPlanError("planner code must be a non-empty string");
  }
  validatePlanCode(record.code);

  return createCodePlanDraft({ code: record.code });
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

/** 严格解析 JSON（结构化数据）对象：禁止 Markdown（标记文本）围栏和 JSON 外自然语言。 */
export function parseStrictJsonRecord(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const parsed = JSON.parse(trimmed) as unknown;

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

/**
 * code（代码） 是任务闭环入口：解析层只做与规划契约直接相关的最低门禁，
 * 具体 TypeScript（类型脚本） 语义仍交给 sandbox（沙箱） 编译和执行层处理。
 */
function validatePlanCode(code: string): void {
  if (code.includes("demoMineIron")) {
    throw createPlanGateError(
      "planner code must not call demoMineIron",
      "forbidden_demo_mine_iron",
    );
  }

  if (/\bapi\.(?:bot|chat)\b/.test(code)) {
    throw createPlanGateError(
      "planner code must use semantic API, not api.bot/api.chat",
      "forbidden_low_level_api",
    );
  }

  if (!/\brunGoal\s*\(/.test(code)) {
    throw createPlanGateError("planner code must call runGoal", "missing_run_goal");
  }

  if (!/\breport\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code)) {
    throw createPlanGateError("planner code must call report(task)", "missing_report_task");
  }
}

const PLAN_FORBIDDEN_KEYS = new Set(["type", "skill", "params", "skill_call", "sandbox_code"]);

function parseStrictPlanJsonRecord(content: string): Record<string, unknown> {
  try {
    return parseStrictJsonRecord(content);
  } catch (error) {
    throw new ConversationLlmPlanError("planner output must be a strict JSON object", {
      cause: error,
      plan_metric: {
        plan_parse_ok: false,
        plan_code_only_ok: false,
      },
    });
  }
}

function createCodeOnlyPlanError(message: string): ConversationLlmPlanError {
  return new ConversationLlmPlanError(message, {
    plan_metric: {
      plan_parse_ok: true,
      plan_code_only_ok: false,
    },
  });
}

function createPlanGateError(
  message: string,
  failureType: ConversationLlmPlanGateFailureType,
): ConversationLlmPlanError {
  return new ConversationLlmPlanError(message, {
    plan_metric: {
      plan_parse_ok: true,
      plan_code_only_ok: true,
      plan_gate_failure_type: failureType,
    },
  });
}
