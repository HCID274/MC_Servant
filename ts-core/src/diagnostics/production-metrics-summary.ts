import type { ProductionMetricEventJsonlLine } from "../data/contracts/index.js";

export const PRODUCTION_LLM_METRIC_NAMES = [
  "plan_code_strict_parse_success_rate",
  "plan_code_only_success_rate",
  "plan_gate_failure_rate",
  "plan_static_precheck_failure_rate",
  "triage_average_latency_ms",
  "plan_average_latency_ms",
  "chat_average_latency_ms",
  "report_average_latency_ms",
  "llm_input_tokens_total",
  "llm_output_tokens_total",
] as const;

export type ProductionLlmMetricName = (typeof PRODUCTION_LLM_METRIC_NAMES)[number];

export const PRODUCTION_EXECUTION_METRIC_NAMES = [
  "execution_task_run_count",
  "execution_no_manual_completion_rate",
  "execution_average_duration_minutes",
  "execution_average_step_count",
  "execution_failed_count",
  "execution_interrupted_count",
  "execution_failure_code_count_by_code",
] as const;

export type ProductionExecutionMetricName = (typeof PRODUCTION_EXECUTION_METRIC_NAMES)[number];

export const PRODUCTION_RECOVERY_METRIC_NAMES = [
  "recoverable_failure_count",
  "recoverable_replan_success_rate",
  "average_replan_count_to_success",
  "implementation_blocker_count",
  "unknown_failure_count",
] as const;

export type ProductionRecoveryMetricName = (typeof PRODUCTION_RECOVERY_METRIC_NAMES)[number];

export interface ProductionLlmMetricSummary {
  readonly name: ProductionLlmMetricName;
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export interface ProductionExecutionMetricSummary {
  readonly name: ProductionExecutionMetricName;
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly breakdown?: Readonly<Record<string, number>>;
}

export interface ProductionRecoveryMetricSummary {
  readonly name: ProductionRecoveryMetricName;
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

/** 从生产指标 JSONL 事件汇总 T-075R 的 LLM 与 Plan 输出指标。 */
export function createProductionLlmMetricSummaries(
  events: readonly ProductionMetricEventJsonlLine[],
): readonly ProductionLlmMetricSummary[] {
  const llmEvents = events.filter((event) => event.event_type === "llm.stage");
  const planEvents = llmEvents.filter((event) => event.stage === "plan");

  return Object.freeze([
    createRatioMetric({
      name: "plan_code_strict_parse_success_rate",
      numerator: planEvents.filter((event) => event.plan_parse_ok === true).length,
      denominator: planEvents.length,
    }),
    createRatioMetric({
      name: "plan_code_only_success_rate",
      numerator: planEvents.filter((event) => event.plan_code_only_ok === true).length,
      denominator: planEvents.length,
    }),
    createRatioMetric({
      name: "plan_gate_failure_rate",
      numerator: planEvents.filter((event) => event.plan_gate_failure_type !== null).length,
      denominator: planEvents.length,
    }),
    createRatioMetric({
      name: "plan_static_precheck_failure_rate",
      numerator: planEvents.filter((event) => event.plan_static_precheck_failure_type !== null)
        .length,
      denominator: planEvents.length,
    }),
    createAverageLatencyMetric("triage_average_latency_ms", llmEvents, "triage"),
    createAverageLatencyMetric("plan_average_latency_ms", llmEvents, "plan"),
    createAverageLatencyMetric("chat_average_latency_ms", llmEvents, "chat"),
    createAverageLatencyMetric("report_average_latency_ms", llmEvents, "report"),
    createTotalMetric({
      name: "llm_input_tokens_total",
      value: sumNullable(llmEvents.map((event) => event.input_tokens)),
      denominator: llmEvents.length,
    }),
    createTotalMetric({
      name: "llm_output_tokens_total",
      value: sumNullable(llmEvents.map((event) => event.output_tokens)),
      denominator: llmEvents.length,
    }),
  ]);
}

/** 从生产指标 JSONL 事件汇总 T-076R 的执行链路指标。 */
export function createProductionExecutionMetricSummaries(
  events: readonly ProductionMetricEventJsonlLine[],
): readonly ProductionExecutionMetricSummary[] {
  const terminalEvents = events.filter(isExecutionTerminalMetricEvent);
  const durations = terminalEvents.flatMap((event) =>
    event.duration_ms === null ? [] : [event.duration_ms / 60_000],
  );
  const stepCounts = terminalEvents.flatMap((event) =>
    event.step_count === null ? [] : [event.step_count],
  );
  const failureCodeCounts = countFailureCodes(terminalEvents);
  const failureCodeTotal = Object.values(failureCodeCounts).reduce((sum, count) => sum + count, 0);

  return Object.freeze([
    createExecutionCountMetric({
      name: "execution_task_run_count",
      value: terminalEvents.length,
      denominator: terminalEvents.length,
    }),
    createExecutionRatioMetric({
      name: "execution_no_manual_completion_rate",
      numerator: terminalEvents.filter(
        (event) => event.terminal_status === "completed" && event.is_manual_intervention !== true,
      ).length,
      denominator: terminalEvents.length,
    }),
    createExecutionAverageMetric({
      name: "execution_average_duration_minutes",
      values: durations,
    }),
    createExecutionAverageMetric({
      name: "execution_average_step_count",
      values: stepCounts,
    }),
    createExecutionCountMetric({
      name: "execution_failed_count",
      value: terminalEvents.filter((event) => event.terminal_status === "failed").length,
      denominator: terminalEvents.length,
    }),
    createExecutionCountMetric({
      name: "execution_interrupted_count",
      value: terminalEvents.filter((event) => event.terminal_status === "interrupted").length,
      denominator: terminalEvents.length,
    }),
    Object.freeze({
      name: "execution_failure_code_count_by_code",
      value: failureCodeTotal,
      numerator: failureCodeTotal,
      denominator: terminalEvents.length,
      breakdown: failureCodeCounts,
    }),
  ]);
}

/** 从生产指标 JSONL 事件汇总 T-077R 的失败恢复链路指标。 */
export function createProductionRecoveryMetricSummaries(
  events: readonly ProductionMetricEventJsonlLine[],
): readonly ProductionRecoveryMetricSummary[] {
  const rootFailures = events.filter(isRecoveryRootFailureMetricEvent);
  const recoverableFailures = rootFailures.filter(
    (event) => event.recovery_class === "recoverable",
  );
  const successfulRecoveries = recoverableFailures.flatMap((failure) =>
    readSuccessfulRecoveryReplanCount(events, failure.recovery_chain_id),
  );
  const successfulReplanTotal = successfulRecoveries.reduce((sum, count) => sum + count, 0);

  return Object.freeze([
    createRecoveryCountMetric({
      name: "recoverable_failure_count",
      value: recoverableFailures.length,
      denominator: rootFailures.length,
    }),
    createRecoveryRatioMetric({
      name: "recoverable_replan_success_rate",
      numerator: successfulRecoveries.length,
      denominator: recoverableFailures.length,
    }),
    createRecoveryAverageMetric({
      name: "average_replan_count_to_success",
      numerator: successfulReplanTotal,
      denominator: successfulRecoveries.length,
    }),
    createRecoveryCountMetric({
      name: "implementation_blocker_count",
      value: rootFailures.filter((event) => event.recovery_class === "implementation_blocker")
        .length,
      denominator: rootFailures.length,
    }),
    createRecoveryCountMetric({
      name: "unknown_failure_count",
      value: rootFailures.filter((event) => event.recovery_class === "unknown").length,
      denominator: rootFailures.length,
    }),
  ]);
}

function createRatioMetric(input: {
  readonly name: ProductionLlmMetricName;
  readonly numerator: number;
  readonly denominator: number;
}): ProductionLlmMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.denominator === 0 ? null : input.numerator / input.denominator,
    numerator: input.numerator,
    denominator: input.denominator,
  });
}

function createAverageLatencyMetric(
  name: ProductionLlmMetricName,
  events: readonly ProductionMetricEventJsonlLine[],
  stage: ProductionMetricEventJsonlLine["stage"],
): ProductionLlmMetricSummary {
  const latencies = events
    .filter((event) => event.stage === stage && event.duration_ms !== null)
    .map((event) => event.duration_ms as number);
  const total = latencies.reduce((sum, value) => sum + value, 0);

  return Object.freeze({
    name,
    value: latencies.length === 0 ? null : total / latencies.length,
    numerator: total,
    denominator: latencies.length,
  });
}

function createTotalMetric(input: {
  readonly name: ProductionLlmMetricName;
  readonly value: number;
  readonly denominator: number;
}): ProductionLlmMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.value,
    numerator: input.value,
    denominator: input.denominator,
  });
}

function sumNullable(values: readonly (number | null)[]): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function isExecutionTerminalMetricEvent(event: ProductionMetricEventJsonlLine): boolean {
  return (
    event.source === "bot_worker" && event.stage === "execution" && event.terminal_status !== null
  );
}

function isRecoveryRootFailureMetricEvent(event: ProductionMetricEventJsonlLine): boolean {
  return (
    isExecutionTerminalMetricEvent(event) &&
    event.terminal_status === "failed" &&
    event.recovery_chain_id !== null &&
    (event.replan_count ?? 0) === 0
  );
}

function readSuccessfulRecoveryReplanCount(
  events: readonly ProductionMetricEventJsonlLine[],
  recoveryChainId: string | null,
): readonly number[] {
  if (recoveryChainId === null) {
    return [];
  }

  const completed = events
    .filter(
      (event) =>
        isExecutionTerminalMetricEvent(event) &&
        event.terminal_status === "completed" &&
        event.recovery_chain_id === recoveryChainId &&
        event.replan_count !== null &&
        event.replan_count > 0,
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .at(0);

  return completed?.replan_count === undefined || completed.replan_count === null
    ? []
    : [completed.replan_count];
}

function createExecutionRatioMetric(input: {
  readonly name: ProductionExecutionMetricName;
  readonly numerator: number;
  readonly denominator: number;
}): ProductionExecutionMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.denominator === 0 ? null : input.numerator / input.denominator,
    numerator: input.numerator,
    denominator: input.denominator,
  });
}

function createExecutionAverageMetric(input: {
  readonly name: ProductionExecutionMetricName;
  readonly values: readonly number[];
}): ProductionExecutionMetricSummary {
  const total = input.values.reduce((sum, value) => sum + value, 0);

  return Object.freeze({
    name: input.name,
    value: input.values.length === 0 ? null : total / input.values.length,
    numerator: total,
    denominator: input.values.length,
  });
}

function createExecutionCountMetric(input: {
  readonly name: ProductionExecutionMetricName;
  readonly value: number;
  readonly denominator: number;
}): ProductionExecutionMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.value,
    numerator: input.value,
    denominator: input.denominator,
  });
}

function countFailureCodes(
  events: readonly ProductionMetricEventJsonlLine[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    if (event.terminal_status !== "failed") {
      continue;
    }

    const code = event.error_code ?? "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }

  return Object.freeze(
    Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function createRecoveryRatioMetric(input: {
  readonly name: ProductionRecoveryMetricName;
  readonly numerator: number;
  readonly denominator: number;
}): ProductionRecoveryMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.denominator === 0 ? null : input.numerator / input.denominator,
    numerator: input.numerator,
    denominator: input.denominator,
  });
}

function createRecoveryAverageMetric(input: {
  readonly name: ProductionRecoveryMetricName;
  readonly numerator: number;
  readonly denominator: number;
}): ProductionRecoveryMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.denominator === 0 ? null : input.numerator / input.denominator,
    numerator: input.numerator,
    denominator: input.denominator,
  });
}

function createRecoveryCountMetric(input: {
  readonly name: ProductionRecoveryMetricName;
  readonly value: number;
  readonly denominator: number;
}): ProductionRecoveryMetricSummary {
  return Object.freeze({
    name: input.name,
    value: input.value,
    numerator: input.value,
    denominator: input.denominator,
  });
}
