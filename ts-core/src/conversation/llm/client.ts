import { createLlmLogLine, createLlmLogRef } from "../../diagnostics/logs.js";
import { createMessageTriage } from "../triage.js";
import {
  createConversationLlmDiagnosticRecord,
  createErrorSnapshot,
  createLlmInvocationLines,
  createUnixSeconds,
} from "./diagnostics.js";
import { ConversationLlmChatError, ConversationLlmPlanError } from "./errors.js";
import { requestChatCompletionPayload } from "./http.js";
import {
  createConversationChatMessages,
  createConversationPlanMessages,
  createConversationTriageMessages,
} from "./messages.js";
import {
  extractAssistantReply,
  parseConversationSkillPlan,
  parseConversationTriage,
} from "./parsers.js";
import type {
  ConversationLlmChatInput,
  ConversationLlmChatResult,
  ConversationLlmClient,
  ConversationLlmConfig,
  ConversationLlmDependencies,
  ConversationLlmPlanInput,
  ConversationLlmPlanResult,
  ConversationLlmTriageInput,
} from "./types.js";

export function createConversationLlmClient(
  config: ConversationLlmConfig,
  dependencies: ConversationLlmDependencies = {},
): ConversationLlmClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async generateTriage(
      input: ConversationLlmTriageInput,
    ): Promise<ReturnType<typeof createMessageTriage>> {
      const startedAt = now();
      const startedAtMs = startedAt.getTime();
      const messages = createConversationTriageMessages(input);
      const logRef = createLlmLogRef({
        date: startedAt.toISOString().slice(0, 10),
        stage: "triage",
        message_id: input.message_id,
      });
      const invocationLines = createLlmInvocationLines({
        t: createUnixSeconds(startedAt),
        stage: "triage",
        model: config.model,
        message_id: input.message_id,
        messages,
      });

      try {
        const payload = await requestChatCompletionPayload({
          fetchImpl,
          config,
          messages,
        });
        const finishedAt = now();
        const triage = parseConversationTriage(extractAssistantReply(payload));

        await dependencies.onDiagnostic?.(
          createConversationLlmDiagnosticRecord({
            stage: "triage",
            model: config.model,
            message_id: input.message_id,
            log_ref: logRef,
            created_at: finishedAt.toISOString(),
            ok: true,
            lines: [
              ...invocationLines,
              createLlmLogLine({
                t: createUnixSeconds(finishedAt),
                meta: {
                  input_tokens: payload.usage?.prompt_tokens ?? 0,
                  output_tokens: payload.usage?.completion_tokens ?? 0,
                  ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                  ok: true,
                },
              }),
            ],
          }),
        );

        return triage;
      } catch (error) {
        const finishedAt = now();
        const errorSnapshot = createErrorSnapshot(error);

        await dependencies.onDiagnostic?.(
          createConversationLlmDiagnosticRecord({
            stage: "triage",
            model: config.model,
            message_id: input.message_id,
            log_ref: logRef,
            created_at: finishedAt.toISOString(),
            ok: false,
            error_summary: errorSnapshot.message,
            lines: [
              ...invocationLines,
              createLlmLogLine({
                t: createUnixSeconds(finishedAt),
                meta: {
                  input_tokens: 0,
                  output_tokens: 0,
                  ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                  ok: false,
                },
                err: errorSnapshot,
              }),
            ],
          }),
        );

        return createMessageTriage({
          intent: "chat",
          priority: "normal",
          reason: "llm_triage_fallback",
        });
      }
    },
    async generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult> {
      const startedAt = now();
      const startedAtMs = startedAt.getTime();
      const messages = createConversationChatMessages({
        ...input,
        bot_name: input.bot_name ?? config.bot_name,
        owner_name: input.owner_name ?? config.owner_name,
      });
      const logRef = createLlmLogRef({
        date: startedAt.toISOString().slice(0, 10),
        stage: "chat",
        message_id: input.message_id,
      });
      const invocationLines = Object.freeze([
        ...createLlmInvocationLines({
          t: createUnixSeconds(startedAt),
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          messages,
        }),
      ]);

      try {
        const payload = await requestChatCompletionPayload({
          fetchImpl,
          config,
          messages,
        });

        const reply = extractAssistantReply(payload);
        const finishedAt = now();
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
          created_at: finishedAt.toISOString(),
          ok: true,
          lines: [
            ...invocationLines,
            createLlmLogLine({
              t: createUnixSeconds(finishedAt),
              meta: {
                input_tokens: payload.usage?.prompt_tokens ?? 0,
                output_tokens: payload.usage?.completion_tokens ?? 0,
                ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                ok: true,
              },
            }),
          ],
        });

        await dependencies.onDiagnostic?.(diagnostics);

        return Object.freeze({
          mode: "llm",
          reply,
          diagnostics,
        });
      } catch (error) {
        const finishedAt = now();
        const errorSnapshot = createErrorSnapshot(error);
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
          created_at: finishedAt.toISOString(),
          ok: false,
          error_summary: errorSnapshot.message,
          lines: [
            ...invocationLines,
            createLlmLogLine({
              t: createUnixSeconds(finishedAt),
              meta: {
                input_tokens: 0,
                output_tokens: 0,
                ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                ok: false,
              },
              err: errorSnapshot,
            }),
          ],
        });

        await dependencies.onDiagnostic?.(diagnostics);

        throw new ConversationLlmChatError(errorSnapshot.message, diagnostics, {
          cause: error,
        });
      }
    },
    async generateSkillPlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult> {
      const startedAt = now();
      const startedAtMs = startedAt.getTime();
      const messages = createConversationPlanMessages(input);
      const logRef = createLlmLogRef({
        date: startedAt.toISOString().slice(0, 10),
        stage: "plan",
        message_id: input.message_id,
      });
      const invocationLines = createLlmInvocationLines({
        t: createUnixSeconds(startedAt),
        stage: "plan",
        model: config.model,
        message_id: input.message_id,
        messages,
      });

      try {
        const payload = await requestChatCompletionPayload({
          fetchImpl,
          config,
          messages,
        });
        const plan = parseConversationSkillPlan(extractAssistantReply(payload));
        const finishedAt = now();

        await dependencies.onDiagnostic?.(
          createConversationLlmDiagnosticRecord({
            stage: "plan",
            model: config.model,
            message_id: input.message_id,
            log_ref: logRef,
            created_at: finishedAt.toISOString(),
            ok: true,
            lines: [
              ...invocationLines,
              createLlmLogLine({
                t: createUnixSeconds(finishedAt),
                meta: {
                  input_tokens: payload.usage?.prompt_tokens ?? 0,
                  output_tokens: payload.usage?.completion_tokens ?? 0,
                  ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                  ok: true,
                },
              }),
            ],
          }),
        );

        return plan;
      } catch (error) {
        const finishedAt = now();
        const errorSnapshot = createErrorSnapshot(error);

        await dependencies.onDiagnostic?.(
          createConversationLlmDiagnosticRecord({
            stage: "plan",
            model: config.model,
            message_id: input.message_id,
            log_ref: logRef,
            created_at: finishedAt.toISOString(),
            ok: false,
            error_summary: errorSnapshot.message,
            lines: [
              ...invocationLines,
              createLlmLogLine({
                t: createUnixSeconds(finishedAt),
                meta: {
                  input_tokens: 0,
                  output_tokens: 0,
                  ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                  ok: false,
                },
                err: errorSnapshot,
              }),
            ],
          }),
        );

        throw new ConversationLlmPlanError(errorSnapshot.message, { cause: error });
      }
    },
  });
}
