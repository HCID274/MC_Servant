import type { ConversationLlmDiagnosticRecord } from "../../conversation/llm.js";
import type { ConversationWorkerRuntimeEvent } from "./types.js";

export function appendLlmDiagnosticEvent(
  events: ConversationWorkerRuntimeEvent[],
  botId: string,
  diagnostics: ConversationLlmDiagnosticRecord,
): void {
  events.push(
    Object.freeze({
      type: "llm.chat.diagnostic",
      bot_id: botId,
      stage: diagnostics.stage,
      message_id: diagnostics.message_id,
      model: diagnostics.model,
      log_ref: diagnostics.log_ref,
      created_at: diagnostics.created_at,
      ok: diagnostics.ok,
      ...(diagnostics.error_summary === undefined
        ? {}
        : { error_summary: diagnostics.error_summary }),
    }),
  );
}
