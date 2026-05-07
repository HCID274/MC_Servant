import { assertNonEmptyString } from "../../domain/invariants.js";
import { createChatSystemPrompt } from "./prompts/chat.js";
import { createPlanSystemPrompt } from "./prompts/plan.js";
import { REPORT_SYSTEM_PROMPT } from "./prompts/report.js";
import { TRIAGE_SYSTEM_PROMPT } from "./prompts/triage.js";
import type {
  ConversationLlmChatInput,
  ConversationLlmConfig,
  ConversationLlmMessage,
  ConversationLlmPlanInput,
  ConversationLlmReportInput,
  ConversationLlmTriageInput,
} from "./types.js";

export function createConversationChatMessages(
  input: ConversationLlmChatInput & Pick<ConversationLlmConfig, "bot_name" | "owner_name">,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const botName = input.bot_name.trim();
  const ownerName = input.owner_name.trim();
  const historyMessages =
    input.history?.flatMap<ConversationLlmMessage>((turn) => {
      const role = turn.role === "bot" ? "assistant" : "user";
      const content =
        turn.role === "bot" ? `[${botName}] ${turn.content}` : `[${ownerName}] ${turn.content}`;

      return Object.freeze([
        Object.freeze({
          role,
          content,
        }),
      ]);
    }) ?? [];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: createChatSystemPrompt({
        botName,
        ownerName,
        ...(input.snapshot_context === undefined
          ? {}
          : { snapshotContext: input.snapshot_context }),
        ...(input.memory_context === undefined ? {} : { memoryContext: input.memory_context }),
        ...(input.brain_context === undefined ? {} : { brainContext: input.brain_context }),
        ...(input.state_context === undefined ? {} : { stateContext: input.state_context }),
      }),
    }),
    ...historyMessages,
    Object.freeze({
      role: "user",
      content: `[${ownerName}] ${input.message}`,
    }),
  ]);
}

/** 组装 Stage 1-Triage（分诊） 的最小消息列表。 */
export function createConversationTriageMessages(
  input: ConversationLlmTriageInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const historyLines =
    input.history?.map((turn) =>
      turn.role === "bot" ? `[Bot] ${turn.content}` : `[主人] ${turn.content}`,
    ) ?? [];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: TRIAGE_SYSTEM_PROMPT,
    }),
    Object.freeze({
      role: "user",
      content: [
        `Bot 状态：${input.bot_summary?.trim() || "idle"}`,
        ...(input.brain_context === undefined ? [] : [`Brain上下文：\n${input.brain_context}`]),
        "---",
        ...(historyLines.length > 0 ? historyLines : ["[无最近对话]"]),
        "---",
        `[主人] ${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 组装 Stage 2-Plan（第二阶段规划） 的 TS（TypeScript）代码规划消息列表。 */
export function createConversationPlanMessages(
  input: ConversationLlmPlanInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");
  assertNonEmptyString(input.snapshot_context, "snapshot_context");

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: createPlanSystemPrompt(),
    }),
    Object.freeze({
      role: "user",
      content: [
        `环境快照：${input.snapshot_context}`,
        ...(input.triage_reason === undefined ? [] : [`分诊理由：${input.triage_reason}`]),
        ...(input.task_history_context === undefined
          ? []
          : [`任务历史：${input.task_history_context}`]),
        ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
        ...(input.brain_context === undefined ? [] : [`Brain上下文：\n${input.brain_context}`]),
        `主人的指令：${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 组装 ReportLLM 终态润色消息列表。 */
export function createConversationReportMessages(
  input: ConversationLlmReportInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.owner_text, "owner_text");
  assertNonEmptyString(input.deterministic_report, "deterministic_report");
  assertNonEmptyString(input.fact_summary, "fact_summary");
  assertNonEmptyString(input.tone, "tone");

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: REPORT_SYSTEM_PROMPT,
    }),
    Object.freeze({
      role: "user",
      content: [
        `任务原文：${input.owner_text}`,
        `终态：${input.status}`,
        `确定性模板：${input.deterministic_report}`,
        `事实摘要：${input.fact_summary}`,
        "必须保留以下片段，逐字出现在输出中：",
        ...input.required_facts.map((fact) => `- ${fact}`),
        `语气：${input.tone}`,
      ].join("\n"),
    }),
  ]);
}
