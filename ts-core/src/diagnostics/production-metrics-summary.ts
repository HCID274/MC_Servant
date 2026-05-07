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

export interface ProductionLlmMetricSummary {
  readonly name: ProductionLlmMetricName;
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
