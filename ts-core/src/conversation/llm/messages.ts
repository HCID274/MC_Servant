import { assertNonEmptyString } from "../../domain/invariants.js";
import { createChatSystemPrompt } from "./prompts/chat.js";
import { createPlanSystemPrompt } from "./prompts/plan.js";
import { TRIAGE_SYSTEM_PROMPT } from "./prompts/triage.js";
import type {
  ConversationLlmChatInput,
  ConversationLlmConfig,
  ConversationLlmMessage,
  ConversationLlmPlanInput,
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
        ...(input.memory_context === undefined ? {} : { memoryContext: input.memory_context }),
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
        "---",
        ...(historyLines.length > 0 ? historyLines : ["[无最近对话]"]),
        "---",
        `[主人] ${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 组装最小单技能 `skill_call`（技能调用） 规划消息列表。 */
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
        ...(input.interrupted_task === undefined
          ? []
          : [
              `被中断任务：message_id=${input.interrupted_task.message_id}; summary=${input.interrupted_task.intent_summary}${input.interrupted_task.last_step === undefined ? "" : `; last_step=${input.interrupted_task.last_step}`}`,
            ]),
        `主人的指令：${input.message}`,
      ].join("\n"),
    }),
  ]);
}
