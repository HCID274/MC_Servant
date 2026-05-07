import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  PRODUCTION_METRIC_EVENT_TYPES,
  PRODUCTION_METRIC_SCHEMA_VERSION,
  PRODUCTION_METRIC_SOURCES,
  PRODUCTION_METRIC_STAGES,
  PRODUCTION_METRIC_TERMINAL_STATUSES,
  type ProductionMetricEventJsonlLine,
} from "../data/contracts/index.js";
import { createDatedStorageRef } from "../data/index.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import { redactLocalDiagnosticJsonText } from "./local-log-redaction.js";
import { assertDiagnosticStorageRef } from "./logs.js";

/** 生产指标 JSONL（结构化日志） 写入函数。 */
export type ProductionMetricLogSink = (line: ProductionMetricEventJsonlLine) => Promise<void>;

type ProductionMetricPlanFields = Pick<
  ProductionMetricEventJsonlLine,
  | "plan_parse_ok"
  | "plan_code_only_ok"
  | "plan_gate_failure_type"
  | "plan_static_precheck_failure_type"
>;

type ProductionMetricExecutionFields = Pick<
  ProductionMetricEventJsonlLine,
  "terminal_status" | "step_count" | "is_manual_intervention"
>;

/** 创建生产指标事件，所有可未知字段显式落 null，避免下游猜字段缺失语义。 */
export function createProductionMetricEventJsonlLine(
  input: Omit<
    ProductionMetricEventJsonlLine,
    | "schema_version"
    | "event_id"
    | keyof ProductionMetricPlanFields
    | keyof ProductionMetricExecutionFields
  > &
    Partial<ProductionMetricPlanFields> &
    Partial<ProductionMetricExecutionFields> & {
      readonly event_id?: string;
    },
): ProductionMetricEventJsonlLine {
  const eventId = input.event_id ?? randomUUID();
  assertNonEmptyString(eventId, "event_id");
  assertProductionMetricEventType(input.event_type);
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.created_at, "created_at");
  assertProductionMetricSource(input.source);
  assertProductionMetricStage(input.stage);
  assertNullableNonNegativeNumber(input.duration_ms, "duration_ms");
  assertNullableNonNegativeInteger(input.input_tokens, "input_tokens");
  assertNullableNonNegativeInteger(input.output_tokens, "output_tokens");
  assertNullableProductionMetricTerminalStatus(input.terminal_status ?? null);
  assertNullableNonNegativeInteger(input.step_count ?? null, "step_count");
  assertNullableBoolean(input.is_manual_intervention ?? null, "is_manual_intervention");

  return cloneReadonlyValue({
    schema_version: PRODUCTION_METRIC_SCHEMA_VERSION,
    event_id: eventId,
    plan_parse_ok: null,
    plan_code_only_ok: null,
    plan_gate_failure_type: null,
    plan_static_precheck_failure_type: null,
    terminal_status: null,
    step_count: null,
    is_manual_intervention: null,
    ...input,
  } satisfies ProductionMetricEventJsonlLine);
}

/** 创建生产指标通道的日期分桶日志引用。 */
export function createProductionMetricLogRef(input: { readonly date: string }): string {
  return createDatedStorageRef({
    directory: "metrics",
    date: input.date,
    fileName: "production-metrics.jsonl",
  });
}

/** 创建本地生产指标 JSONL 写入器。 */
export function createLocalProductionMetricLogSink(input: {
  readonly baseDir: string;
  readonly sensitiveValues?: readonly string[];
}): ProductionMetricLogSink {
  return async (line) => {
    const logRef = createProductionMetricLogRef({ date: line.created_at.slice(0, 10) });
    assertDiagnosticStorageRef({
      channel: "metrics",
      refField: "log_ref",
      value: logRef,
    });

    const filePath = join(input.baseDir, ...logRef.split("/"));
    const content = redactLocalDiagnosticJsonText(
      JSON.stringify(line),
      input.sensitiveValues ?? [],
    );

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${content}\n`, "utf8");
  };
}

function assertProductionMetricEventType(
  value: ProductionMetricEventJsonlLine["event_type"],
): void {
  if (!(PRODUCTION_METRIC_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new Error(`unsupported production metric event_type: ${value}`);
  }
}

function assertProductionMetricSource(value: ProductionMetricEventJsonlLine["source"]): void {
  if (!(PRODUCTION_METRIC_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`unsupported production metric source: ${value}`);
  }
}

function assertProductionMetricStage(value: ProductionMetricEventJsonlLine["stage"]): void {
  if (!(PRODUCTION_METRIC_STAGES as readonly string[]).includes(value)) {
    throw new Error(`unsupported production metric stage: ${value}`);
  }
}

function assertNullableProductionMetricTerminalStatus(
  value: ProductionMetricEventJsonlLine["terminal_status"],
): void {
  if (
    value !== null &&
    !(PRODUCTION_METRIC_TERMINAL_STATUSES as readonly string[]).includes(value)
  ) {
    throw new Error(`unsupported production metric terminal_status: ${value}`);
  }
}

function assertNullableNonNegativeNumber(value: number | null, name: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative number or null`);
  }
}

function assertNullableNonNegativeInteger(value: number | null, name: string): void {
  if (value !== null && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer or null`);
  }
}

function assertNullableBoolean(value: boolean | null, name: string): void {
  if (value !== null && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean or null`);
  }
}
