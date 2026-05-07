import type {
  EvalAttemptJsonlLine,
  EvalCaseInput,
  EvalCaseJsonlLine,
  EvalJsonlLine,
  EvalRunConfigSummary,
} from "../../data/contracts/index.js";
import {
  createEvalAttemptJsonlLine,
  createEvalMetricJsonlLine,
  createEvalRunJsonlLine,
} from "../../diagnostics/eval-jsonl.js";
import { checkSandboxSourceStaticPolicy } from "../../sandbox/execution.js";
import type { ConversationCompositeTriage } from "../contracts.js";
import {
  createConversationChatMessages,
  createConversationPlanMessages,
  createConversationReportMessages,
  createConversationTriageMessages,
} from "./messages.js";
import type {
  ConversationLlmClient,
  ConversationLlmDiagnosticRecord,
  ConversationLlmPlanInput,
} from "./types.js";

/** 离线 LLM（大语言模型）评测 runner（执行器）输入。 */
export interface ConversationLlmEvalRunnerInput {
  readonly cases: readonly EvalCaseJsonlLine[];
  readonly client: ConversationLlmEvalClient;
  readonly run_id: string;
  readonly config: EvalRunConfigSummary;
  readonly now?: () => Date;
}

/** eval runner 只依赖 LLM client（客户端） 的四个阶段能力。 */
export type ConversationLlmEvalClient = Pick<
  ConversationLlmClient,
  "generateCompositeTriage" | "generateCodePlan" | "generateChatReply" | "generateReport"
>;

/** 执行一批 eval case，并产出完整本地 JSONL 行。 */
export async function runConversationLlmEvalCases(
  input: ConversationLlmEvalRunnerInput,
): Promise<readonly EvalJsonlLine[]> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const attempts: EvalAttemptJsonlLine[] = [];
  const lines: EvalJsonlLine[] = [
    createEvalRunJsonlLine({
      run_id: input.run_id,
      status: "started",
      started_at: startedAt,
      config: input.config,
      case_count: input.cases.length,
    }),
  ];

  for (const evalCase of input.cases) {
    const attempt = await runEvalCase({
      evalCase,
      client: input.client,
      run_id: input.run_id,
      now,
    });
    attempts.push(attempt);
    lines.push(attempt);
  }

  lines.push(...createEvalMetricLines(input.run_id, attempts));
  lines.push(
    createEvalRunJsonlLine({
      run_id: input.run_id,
      status: "completed",
      started_at: startedAt,
      finished_at: now().toISOString(),
      config: input.config,
      case_count: input.cases.length,
    }),
  );

  return Object.freeze(lines);
}

function createEvalMetricLines(
  runId: string,
  attempts: readonly EvalAttemptJsonlLine[],
): readonly ReturnType<typeof createEvalMetricJsonlLine>[] {
  const planAttempts = attempts.filter((attempt) => attempt.stage === "plan");
  const triageAttempts = attempts.filter((attempt) => attempt.stage === "triage");
  const tokenSavingAttempts = attempts.filter((attempt) => attempt.token_saving !== undefined);
  const planGateFailures = planAttempts.filter(
    (attempt) =>
      attempt.static_precheck_failure_type !== undefined ||
      attempt.planner_gate_failure_type !== undefined,
  );
  const d3SavedTokens = sumBy(
    tokenSavingAttempts,
    (attempt) => attempt.token_saving?.avoided_input_tokens ?? 0,
  );
  const d3BaselineTokens = sumBy(tokenSavingAttempts, (attempt) => {
    const saving = attempt.token_saving;
    return saving === undefined ? 0 : saving.actual_input_tokens + saving.avoided_input_tokens;
  });

  return Object.freeze([
    createEvalMetricJsonlLine({
      run_id: runId,
      metric_id: "A1",
      name: "plan_code_strict_parse_success_rate",
      scope: "run",
      value: ratio(
        planAttempts.filter((attempt) => attempt.parse_ok && attempt.code_only_ok === true).length,
        planAttempts.length,
      ),
      numerator: planAttempts.filter((attempt) => attempt.parse_ok && attempt.code_only_ok === true)
        .length,
      denominator: planAttempts.length,
      unit: "ratio",
    }),
    createEvalMetricJsonlLine({
      run_id: runId,
      metric_id: "D1",
      name: "triage_average_latency_ms",
      scope: "run",
      value: average(triageAttempts.map((attempt) => attempt.latency_ms)),
      numerator: sumBy(triageAttempts, (attempt) => attempt.latency_ms),
      denominator: triageAttempts.length,
      unit: "ms",
    }),
    createEvalMetricJsonlLine({
      run_id: runId,
      metric_id: "D2",
      name: "plan_average_latency_ms",
      scope: "run",
      value: average(planAttempts.map((attempt) => attempt.latency_ms)),
      numerator: sumBy(planAttempts, (attempt) => attempt.latency_ms),
      denominator: planAttempts.length,
      unit: "ms",
    }),
    createEvalMetricJsonlLine({
      run_id: runId,
      metric_id: "D3",
      name: "two_stage_route_estimated_input_token_saving_ratio",
      scope: "run",
      value: ratio(d3SavedTokens, d3BaselineTokens),
      numerator: d3SavedTokens,
      denominator: d3BaselineTokens,
      unit: "ratio",
    }),
    createEvalMetricJsonlLine({
      run_id: runId,
      metric_id: "E2",
      name: "plan_static_precheck_or_planner_gate_failure_rate",
      scope: "run",
      value: ratio(planGateFailures.length, planAttempts.length),
      numerator: planGateFailures.length,
      denominator: planAttempts.length,
      unit: "ratio",
    }),
  ]);
}

async function runEvalCase(input: {
  readonly evalCase: EvalCaseJsonlLine;
  readonly client: ConversationLlmEvalClient;
  readonly run_id: string;
  readonly now: () => Date;
}): Promise<EvalAttemptJsonlLine> {
  const startedAt = input.now().getTime();
  const fallbackInputTokens = estimateEvalCaseInputTokens(input.evalCase);

  try {
    switch (input.evalCase.stage) {
      case "triage":
        return await runTriageCase(input, startedAt, fallbackInputTokens);
      case "plan":
        return await runPlanCase(input, startedAt, fallbackInputTokens);
      case "chat":
        return await runChatCase(input, startedAt, fallbackInputTokens);
      case "report":
        return await runReportCase(input, startedAt, fallbackInputTokens);
      default:
        throw new Error(`unsupported LLM eval stage: ${input.evalCase.stage}`);
    }
  } catch (error) {
    const diagnostics = extractDiagnostics(error);
    return createEvalAttemptFromFailure({
      evalCase: input.evalCase,
      run_id: input.run_id,
      diagnostics,
      error,
      started_at: startedAt,
      now: input.now,
      fallback_input_tokens: fallbackInputTokens,
    });
  }
}

async function runTriageCase(
  input: {
    readonly evalCase: EvalCaseJsonlLine;
    readonly client: ConversationLlmEvalClient;
    readonly run_id: string;
    readonly now: () => Date;
  },
  startedAt: number,
  fallbackInputTokens: number,
): Promise<EvalAttemptJsonlLine> {
  const result = await input.client.generateCompositeTriage({
    message_id: input.evalCase.input.message_id,
    message: requireString(input.evalCase.input.message, "input.message"),
    ...(input.evalCase.input.history === undefined
      ? {}
      : { history: input.evalCase.input.history }),
    ...(input.evalCase.input.bot_summary === undefined
      ? {}
      : { bot_summary: input.evalCase.input.bot_summary }),
  });
  const routeKind = classifyTriageRoute(result);
  const routeOk =
    input.evalCase.expect?.route_kind === undefined
      ? undefined
      : routeKind === input.evalCase.expect.route_kind;
  const tokenSaving = createTokenSavingSummary(input.evalCase, fallbackInputTokens);

  return createEvalAttemptFromSuccess({
    evalCase: input.evalCase,
    run_id: input.run_id,
    started_at: startedAt,
    now: input.now,
    fallback_input_tokens: fallbackInputTokens,
    route_kind: routeKind,
    ...(routeOk === undefined ? {} : { route_ok: routeOk }),
    ...(tokenSaving === undefined ? {} : { token_saving: tokenSaving }),
  });
}

async function runPlanCase(
  input: {
    readonly evalCase: EvalCaseJsonlLine;
    readonly client: ConversationLlmEvalClient;
    readonly run_id: string;
    readonly now: () => Date;
  },
  startedAt: number,
  fallbackInputTokens: number,
): Promise<EvalAttemptJsonlLine> {
  const result = await input.client.generateCodePlan(createPlanInput(input.evalCase.input));
  const staticCheckError = checkSandboxSourceStaticPolicy(result.code);
  const diagnostics = result.diagnostics;

  return createEvalAttemptJsonlLine({
    run_id: input.run_id,
    case_id: input.evalCase.case_id,
    stage: input.evalCase.stage,
    status: staticCheckError === null ? "passed" : "failed",
    ok: staticCheckError === null,
    parse_ok: true,
    code_only_ok: true,
    expected_route_kind: input.evalCase.expect?.route_kind,
    ...(staticCheckError === null
      ? {}
      : { static_precheck_failure_type: staticCheckError.violation }),
    latency_ms: getLatencyMs(diagnostics, startedAt, input.now),
    input_tokens: diagnostics?.metrics.input_tokens ?? fallbackInputTokens,
    output_tokens: diagnostics?.metrics.output_tokens ?? 0,
  });
}

async function runChatCase(
  input: {
    readonly evalCase: EvalCaseJsonlLine;
    readonly client: ConversationLlmEvalClient;
    readonly run_id: string;
    readonly now: () => Date;
  },
  startedAt: number,
  fallbackInputTokens: number,
): Promise<EvalAttemptJsonlLine> {
  const result = await input.client.generateChatReply({
    message_id: input.evalCase.input.message_id,
    message: requireString(input.evalCase.input.message, "input.message"),
    ...(input.evalCase.input.history === undefined
      ? {}
      : { history: input.evalCase.input.history }),
    ...(input.evalCase.input.snapshot_context_for_chat === undefined
      ? {}
      : { snapshot_context: input.evalCase.input.snapshot_context_for_chat }),
  });

  return createEvalAttemptFromSuccess({
    evalCase: input.evalCase,
    run_id: input.run_id,
    started_at: startedAt,
    now: input.now,
    fallback_input_tokens: fallbackInputTokens,
    diagnostics: result.diagnostics,
  });
}

async function runReportCase(
  input: {
    readonly evalCase: EvalCaseJsonlLine;
    readonly client: ConversationLlmEvalClient;
    readonly run_id: string;
    readonly now: () => Date;
  },
  startedAt: number,
  fallbackInputTokens: number,
): Promise<EvalAttemptJsonlLine> {
  const result = await input.client.generateReport({
    message_id: input.evalCase.input.message_id,
    owner_text: requireString(input.evalCase.input.owner_text, "input.owner_text"),
    status: requireReportStatus(input.evalCase.input.status),
    deterministic_report: requireString(
      input.evalCase.input.deterministic_report,
      "input.deterministic_report",
    ),
    fact_summary: requireString(input.evalCase.input.fact_summary, "input.fact_summary"),
    required_facts: input.evalCase.input.required_facts ?? [],
    tone: requireString(input.evalCase.input.tone, "input.tone"),
  });

  return createEvalAttemptJsonlLine({
    run_id: input.run_id,
    case_id: input.evalCase.case_id,
    stage: input.evalCase.stage,
    status: result.diagnostics.ok ? "passed" : "failed",
    ok: result.diagnostics.ok,
    parse_ok: result.diagnostics.ok,
    latency_ms: getLatencyMs(result.diagnostics, startedAt, input.now),
    input_tokens: result.diagnostics.metrics.input_tokens || fallbackInputTokens,
    output_tokens: result.diagnostics.metrics.output_tokens,
    ...(result.diagnostics.error_summary === undefined
      ? {}
      : { error_summary: result.diagnostics.error_summary }),
  });
}

function createEvalAttemptFromSuccess(input: {
  readonly evalCase: EvalCaseJsonlLine;
  readonly run_id: string;
  readonly started_at: number;
  readonly now: () => Date;
  readonly fallback_input_tokens: number;
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
  readonly route_kind?: EvalAttemptJsonlLine["route_kind"];
  readonly route_ok?: boolean;
  readonly token_saving?: EvalAttemptJsonlLine["token_saving"];
}): EvalAttemptJsonlLine {
  return createEvalAttemptJsonlLine({
    run_id: input.run_id,
    case_id: input.evalCase.case_id,
    stage: input.evalCase.stage,
    status: input.route_ok === false ? "failed" : "passed",
    ok: input.route_ok !== false,
    parse_ok: true,
    expected_route_kind: input.evalCase.expect?.route_kind,
    ...(input.route_kind === undefined ? {} : { route_kind: input.route_kind }),
    ...(input.route_ok === undefined ? {} : { route_ok: input.route_ok }),
    latency_ms: getLatencyMs(input.diagnostics, input.started_at, input.now),
    input_tokens: selectInputTokens(input.diagnostics, input.fallback_input_tokens),
    output_tokens: input.diagnostics?.metrics.output_tokens ?? 0,
    ...(input.token_saving === undefined ? {} : { token_saving: input.token_saving }),
  });
}

function createEvalAttemptFromFailure(input: {
  readonly evalCase: EvalCaseJsonlLine;
  readonly run_id: string;
  readonly diagnostics: ConversationLlmDiagnosticRecord | undefined;
  readonly error: unknown;
  readonly started_at: number;
  readonly now: () => Date;
  readonly fallback_input_tokens: number;
}): EvalAttemptJsonlLine {
  return createEvalAttemptJsonlLine({
    run_id: input.run_id,
    case_id: input.evalCase.case_id,
    stage: input.evalCase.stage,
    status: input.diagnostics === undefined ? "error" : "failed",
    ok: false,
    parse_ok: false,
    expected_route_kind: input.evalCase.expect?.route_kind,
    ...(input.evalCase.stage === "plan"
      ? { planner_gate_failure_type: summarizePlannerGateFailure(input.error) }
      : {}),
    latency_ms: getLatencyMs(input.diagnostics, input.started_at, input.now),
    input_tokens: selectInputTokens(input.diagnostics, input.fallback_input_tokens),
    output_tokens: input.diagnostics?.metrics.output_tokens ?? 0,
    error_summary: summarizeError(input.error),
  });
}

function selectInputTokens(
  diagnostics: ConversationLlmDiagnosticRecord | undefined,
  fallbackInputTokens: number,
): number {
  const usageInputTokens = diagnostics?.metrics.input_tokens;

  if (usageInputTokens !== undefined && usageInputTokens > 0) {
    return usageInputTokens;
  }

  return fallbackInputTokens;
}

function createTokenSavingSummary(
  evalCase: EvalCaseJsonlLine,
  actualInputTokens: number,
): EvalAttemptJsonlLine["token_saving"] {
  if (evalCase.token_saving_probe?.avoided_stage !== "plan") {
    return undefined;
  }

  const avoidedInputTokens = estimateTokenCount(
    createConversationPlanMessages(evalCase.token_saving_probe.plan_input)
      .map((message) => message.content)
      .join("\n"),
  );

  return {
    avoided_stage: "plan",
    avoided_input_tokens: avoidedInputTokens,
    actual_input_tokens: actualInputTokens,
    saved_ratio: ratio(avoidedInputTokens, avoidedInputTokens + actualInputTokens),
  };
}

function estimateEvalCaseInputTokens(evalCase: EvalCaseJsonlLine): number {
  switch (evalCase.stage) {
    case "triage":
      return estimateMessageTokens(
        createConversationTriageMessages({
          message_id: evalCase.input.message_id,
          message: evalCase.input.message ?? "",
          ...(evalCase.input.history === undefined ? {} : { history: evalCase.input.history }),
          ...(evalCase.input.bot_summary === undefined
            ? {}
            : { bot_summary: evalCase.input.bot_summary }),
        }),
      );
    case "plan":
      return estimateMessageTokens(createConversationPlanMessages(createPlanInput(evalCase.input)));
    case "chat":
      return estimateMessageTokens(
        createConversationChatMessages({
          message_id: evalCase.input.message_id,
          message: evalCase.input.message ?? "",
          bot_name: "Bot",
          owner_name: "主人",
          ...(evalCase.input.history === undefined ? {} : { history: evalCase.input.history }),
          ...(evalCase.input.snapshot_context_for_chat === undefined
            ? {}
            : { snapshot_context: evalCase.input.snapshot_context_for_chat }),
        }),
      );
    case "report":
      return estimateMessageTokens(
        createConversationReportMessages({
          message_id: evalCase.input.message_id,
          owner_text: evalCase.input.owner_text ?? "",
          status: evalCase.input.status ?? "completed",
          deterministic_report: evalCase.input.deterministic_report ?? "",
          fact_summary: evalCase.input.fact_summary ?? "",
          required_facts: evalCase.input.required_facts ?? [],
          tone: evalCase.input.tone ?? "自然简短",
        }),
      );
    default:
      throw new Error(`unsupported LLM eval stage: ${evalCase.stage}`);
  }
}

function estimateMessageTokens(messages: readonly { readonly content: string }[]): number {
  return estimateTokenCount(messages.map((message) => message.content).join("\n"));
}

/** 本地近似 token 计数只用于无 usage 回退和 D3 离线路由节省估算。 */
export function estimateTokenCount(content: string): number {
  const asciiChars = [...content].filter((char) => char.charCodeAt(0) <= 0x7f).length;
  const nonAsciiChars = [...content].length - asciiChars;
  return Math.max(1, Math.ceil(asciiChars / 4 + nonAsciiChars * 1.5));
}

function createPlanInput(input: EvalCaseInput): ConversationLlmPlanInput {
  return {
    message_id: input.message_id,
    message: requireString(input.message, "input.message"),
    snapshot_context: requireString(input.snapshot_context, "input.snapshot_context"),
    ...(input.triage_reason === undefined ? {} : { triage_reason: input.triage_reason }),
  };
}

function classifyTriageRoute(
  value: ConversationCompositeTriage,
): EvalAttemptJsonlLine["route_kind"] {
  if (value.action !== undefined) {
    return "plan_exec";
  }
  if (value.cancel !== undefined) {
    return "cancel_interrupt";
  }
  return "chat_reply";
}

function getLatencyMs(
  diagnostics: ConversationLlmDiagnosticRecord | undefined,
  startedAt: number,
  now: () => Date,
): number {
  return diagnostics?.metrics.request_total_ms ?? Math.max(0, now().getTime() - startedAt);
}

function extractDiagnostics(error: unknown): ConversationLlmDiagnosticRecord | undefined {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) {
    return undefined;
  }

  const diagnostics = (error as { readonly diagnostics?: unknown }).diagnostics;
  if (
    typeof diagnostics !== "object" ||
    diagnostics === null ||
    !("metrics" in diagnostics) ||
    !("stage" in diagnostics)
  ) {
    return undefined;
  }

  return diagnostics as ConversationLlmDiagnosticRecord;
}

function summarizePlannerGateFailure(error: unknown): string {
  return summarizeError(error)
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 80);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown_error";
}

function requireString(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireReportStatus(
  value: EvalCaseInput["status"],
): "completed" | "failed" | "interrupted" {
  if (value === undefined) {
    throw new Error("input.status must be configured for report eval case");
  }
  return value;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return sumBy(values, (value) => value) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function sumBy<TValue>(values: readonly TValue[], select: (value: TValue) => number): number {
  return values.reduce((sum, value) => sum + select(value), 0);
}
