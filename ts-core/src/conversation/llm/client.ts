import {
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
  ConversationLlmTriageError,
  isConversationLlmSkillNotEnabledError,
} from "./errors.js";
import {
  createConversationChatMessages,
  createConversationPlanMessages,
  createConversationTriageMessages,
} from "./messages.js";
import { parseConversationCodePlan, parseConversationCompositeTriage } from "./parsers.js";
import { executeStage } from "./stage.js";
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
  const monotonicNow = dependencies.monotonicNow ?? createDefaultMonotonicNow;

  return Object.freeze({
    async generateCompositeTriage(input: ConversationLlmTriageInput) {
      const promptBuildStartedAt = monotonicNow();
      const messages = createConversationTriageMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        monotonicNow,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "triage",
        message_id: input.message_id,
        messages,
        ...(input.queue_wait_ms === undefined ? {} : { queue_wait_ms: input.queue_wait_ms }),
        prompt_build_ms: promptBuildMs,
        parse: parseConversationCompositeTriage,
        onFailure: ({ error, diagnostics, errorSnapshot }) => {
          throw new ConversationLlmTriageError(errorSnapshot.message, diagnostics, {
            cause: error,
          });
        },
      });

      return result.value;
    },
    async generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult> {
      const promptBuildStartedAt = monotonicNow();
      const messages = createConversationChatMessages({
        ...input,
        bot_name: input.bot_name ?? config.bot_name,
        owner_name: input.owner_name ?? config.owner_name,
      });
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        monotonicNow,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "chat",
        message_id: input.message_id,
        messages,
        ...(input.queue_wait_ms === undefined ? {} : { queue_wait_ms: input.queue_wait_ms }),
        prompt_build_ms: promptBuildMs,
        parse: (content) => content,
        ...(input.search_tool === undefined ? {} : { searchTool: input.search_tool }),
        ...(input.bot_id === undefined ? {} : { searchToolBotId: input.bot_id }),
        onFailure: ({ error, diagnostics, errorSnapshot }) => {
          throw new ConversationLlmChatError(errorSnapshot.message, diagnostics, {
            cause: error,
          });
        },
      });

      return Object.freeze({
        mode: "llm",
        reply: result.value,
        diagnostics: result.diagnostics,
      });
    },
    async generateCodePlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult> {
      const promptBuildStartedAt = monotonicNow();
      const messages = createConversationPlanMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        monotonicNow,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "plan",
        message_id: input.message_id,
        messages,
        ...(input.queue_wait_ms === undefined ? {} : { queue_wait_ms: input.queue_wait_ms }),
        prompt_build_ms: promptBuildMs,
        parse: parseConversationCodePlan,
        ...(input.search_tool === undefined ? {} : { searchTool: input.search_tool }),
        ...(input.search_tool === undefined ? {} : { searchToolMaxCalls: 1 }),
        ...(input.bot_id === undefined ? {} : { searchToolBotId: input.bot_id }),
        onFailure: ({ error, diagnostics, errorSnapshot }) => {
          if (isConversationLlmSkillNotEnabledError(error)) {
            throw new ConversationLlmSkillNotEnabledError(
              errorSnapshot.message,
              {
                ...(error.skill === undefined ? {} : { skill: error.skill }),
                diagnostics,
              },
              { cause: error },
            );
          }
          throw new ConversationLlmPlanError(errorSnapshot.message, {
            cause: error,
            diagnostics,
          });
        },
      });

      return Object.freeze({
        ...result.value,
        diagnostics: result.diagnostics,
      });
    },
  });
}

function createDefaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsedMs(now: () => number, startedAt: number): number {
  const value = now() - startedAt;

  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
