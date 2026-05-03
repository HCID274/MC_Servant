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
import { parseConversationCompositeTriage, parseConversationSkillPlan } from "./parsers.js";
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

  return Object.freeze({
    async generateCompositeTriage(input: ConversationLlmTriageInput) {
      const messages = createConversationTriageMessages(input);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "triage",
        message_id: input.message_id,
        messages,
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
      const messages = createConversationChatMessages({
        ...input,
        bot_name: input.bot_name ?? config.bot_name,
        owner_name: input.owner_name ?? config.owner_name,
      });

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "chat",
        message_id: input.message_id,
        messages,
        parse: (content) => content,
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
    async generateSkillPlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult> {
      const messages = createConversationPlanMessages(input);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "plan",
        message_id: input.message_id,
        messages,
        parse: parseConversationSkillPlan,
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
