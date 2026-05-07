import { checkSandboxSourceStaticPolicy } from "../../sandbox/execution.js";
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
  createConversationReportMessages,
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
  ConversationLlmReportInput,
  ConversationLlmReportResult,
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
        diagnosticMeta: {
          onSuccess: ({ value }) => {
            const staticCheckError = checkSandboxSourceStaticPolicy(value.code);

            return {
              plan_parse_ok: true,
              plan_code_only_ok: true,
              plan_gate_failure_type: null,
              plan_static_precheck_failure_type: staticCheckError?.violation ?? null,
            };
          },
          onFailure: ({ error }) => createPlanFailureDiagnosticMeta(error),
        },
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
    async generateReport(input: ConversationLlmReportInput): Promise<ConversationLlmReportResult> {
      const promptBuildStartedAt = monotonicNow();
      const messages = createConversationReportMessages(input);
      const promptBuildMs = elapsedMs(monotonicNow, promptBuildStartedAt);

      const result = await executeStage({
        config,
        fetchImpl,
        now,
        monotonicNow,
        onDiagnostic: dependencies.onDiagnostic,
        stage: "report",
        message_id: input.message_id,
        messages,
        ...(input.queue_wait_ms === undefined ? {} : { queue_wait_ms: input.queue_wait_ms }),
        prompt_build_ms: promptBuildMs,
        parse: (content) => parseConversationReport(content, input.required_facts),
        diagnosticMeta: {
          onSuccess: ({ value }) => ({
            input_fact_summary: input.fact_summary,
            output_summary: summarizeReportOutput(value),
            fallback: false,
            fallback_reason: null,
          }),
          onFailure: ({ error, assistantContent }) => ({
            input_fact_summary: input.fact_summary,
            ...(assistantContent === undefined
              ? {}
              : { output_summary: summarizeReportOutput(assistantContent) }),
            fallback: true,
            fallback_reason: error instanceof Error ? error.message : "report_llm_failed",
          }),
        },
        onFailure: () => input.deterministic_report,
      });

      return Object.freeze({
        reply: result.value,
        diagnostics: result.diagnostics,
      });
    },
  });
}

function parseConversationReport(content: string, requiredFacts: readonly string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new Error("ReportLLM output is empty");
  }
  if (normalized.length > 160) {
    throw new Error("ReportLLM output is too long");
  }
  if (normalized.startsWith("{") || normalized.includes("```")) {
    throw new Error("ReportLLM output must be plain short text");
  }
  const missingFact = requiredFacts.find((fact) => !normalized.includes(fact));
  if (missingFact !== undefined) {
    throw new Error(`ReportLLM output missing fact:${missingFact}`);
  }

  return normalized;
}

function summarizeReportOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function createDefaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsedMs(now: () => number, startedAt: number): number {
  const value = now() - startedAt;

  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function createPlanFailureDiagnosticMeta(
  error: unknown,
): Readonly<Record<string, string | number | boolean | null>> {
  if (error instanceof ConversationLlmPlanError && error.plan_metric !== undefined) {
    return {
      plan_parse_ok: error.plan_metric.plan_parse_ok,
      plan_code_only_ok: error.plan_metric.plan_code_only_ok,
      plan_gate_failure_type: error.plan_metric.plan_gate_failure_type ?? null,
      plan_static_precheck_failure_type: null,
    };
  }

  return {
    plan_parse_ok: false,
    plan_code_only_ok: false,
    plan_gate_failure_type: null,
    plan_static_precheck_failure_type: null,
  };
}
