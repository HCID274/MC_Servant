import type { JsonlErrorSnapshot, LlmJsonlLine, LlmLogStage } from "../../diagnostics/contracts.js";
import { createLlmLogLine } from "../../diagnostics/logs.js";
import { cloneReadonlyValue } from "../../domain/invariants.js";
import type { ConversationLlmDiagnosticRecord, ConversationLlmMessage } from "./types.js";

/** 创建只读诊断摘要。 */
export function createConversationLlmDiagnosticRecord(
  input: ConversationLlmDiagnosticRecord,
): ConversationLlmDiagnosticRecord {
  return cloneReadonlyValue(input);
}

/** 创建 LLM（大语言模型） 调用头与 transcript（原始对话记录） 行。 */
export function createLlmInvocationLines(input: {
  t: number;
  stage: LlmLogStage;
  model: string;
  message_id: string;
  messages: readonly ConversationLlmMessage[];
}): readonly LlmJsonlLine[] {
  return Object.freeze([
    createLlmLogLine({
      t: input.t,
      stage: input.stage,
      model: input.model,
      msg_id: input.message_id,
    }),
    ...input.messages.map((message) =>
      createLlmLogLine({
        t: input.t,
        role: message.role,
        content: renderDiagnosticMessageContent(message),
      }),
    ),
  ]);
}

function renderDiagnosticMessageContent(message: ConversationLlmMessage): string {
  const toolCalls =
    message.tool_calls === undefined ? "" : `\ntool_calls=${JSON.stringify(message.tool_calls)}`;
  const toolCallId =
    message.tool_call_id === undefined ? "" : `\ntool_call_id=${message.tool_call_id}`;

  return `${message.content}${toolCalls}${toolCallId}`;
}

/** 将未知错误转换为 JSONL（结构化日志） 错误快照。 */
export function createErrorSnapshot(error: unknown): JsonlErrorSnapshot {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name,
      message: error.message,
    });
  }

  return Object.freeze({
    name: "UnknownError",
    message: "Unknown LLM request error",
  });
}

/** 创建 Unix 时间戳（秒）。 */
export function createUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}
