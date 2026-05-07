import type { FailureRecoveryClass } from "../core-ports/task-result.js";
import type {
  ProductionMetricEventJsonlLine,
  ProductionMetricEventType,
  ProductionMetricSource,
  ProductionMetricStage,
  ProductionMetricTerminalStatus,
} from "../data/contracts/index.js";
import { PRODUCTION_METRIC_SCHEMA_VERSION } from "../data/contracts/index.js";
import {
  type ProductionExecutionMetricSummary,
  type ProductionLlmMetricSummary,
  type ProductionRecoveryMetricSummary,
  createProductionExecutionMetricSummaries,
  createProductionLlmMetricSummaries,
  createProductionRecoveryMetricSummaries,
} from "./production-metrics-summary.js";
import { createProductionMetricEventJsonlLine } from "./production-metrics.js";

export type ProductionMetricReportGroupBy = "overall" | "model" | "prompt_version" | "task_type";

export interface ProductionMetricReportFilters {
  readonly from?: string;
  readonly to?: string;
  readonly bot_id?: string;
  readonly model?: string;
  readonly prompt_version?: string;
}

export interface ProductionMetricReportMetricGroups {
  readonly llm: readonly ProductionLlmMetricSummary[];
  readonly execution: readonly ProductionExecutionMetricSummary[];
  readonly recovery: readonly ProductionRecoveryMetricSummary[];
}

export interface ProductionMetricReportGroup {
  readonly group_by: ProductionMetricReportGroupBy;
  readonly group_value: string;
  readonly event_count: number;
  readonly metrics: ProductionMetricReportMetricGroups;
}

export interface ProductionMetricReport {
  readonly schema_version: "ts-core.production-metric-report.v1";
  readonly generated_at: string;
  readonly filters: ProductionMetricReportFilters;
  readonly event_count: number;
  readonly groups: readonly ProductionMetricReportGroup[];
  readonly resume_summary_zh: string;
}

export interface CreateProductionMetricReportInput {
  readonly events: readonly ProductionMetricEventJsonlLine[];
  readonly filters?: ProductionMetricReportFilters;
  readonly now?: () => Date;
}

/** 读取生产指标 JSONL 文本，脚本层可组合多个日期分桶后统一汇总。 */
export function parseProductionMetricJsonlLines(
  content: string,
  sourceName = "production-metrics.jsonl",
): readonly ProductionMetricEventJsonlLine[] {
  return Object.freeze(
    content
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0)
      .map(({ line, lineNumber }) => parseProductionMetricJsonlLine(line, lineNumber, sourceName)),
  );
}

/** 创建生产指标汇总报告，默认输出总体、模型、prompt 版本和任务类型四类分组。 */
export function createProductionMetricReport(
  input: CreateProductionMetricReportInput,
): ProductionMetricReport {
  const filters = normalizeFilters(input.filters ?? {});
  const filteredEvents = filterProductionMetricEvents(input.events, filters);
  const groups = createReportGroups(filteredEvents);
  const overall = groups[0];

  if (overall === undefined) {
    throw new Error("production metric report must include overall group");
  }

  return Object.freeze({
    schema_version: "ts-core.production-metric-report.v1",
    generated_at: (input.now ?? (() => new Date()))().toISOString(),
    filters,
    event_count: filteredEvents.length,
    groups,
    resume_summary_zh: createResumeSummaryZh(overall),
  });
}

export function filterProductionMetricEvents(
  events: readonly ProductionMetricEventJsonlLine[],
  filters: ProductionMetricReportFilters,
): readonly ProductionMetricEventJsonlLine[] {
  const fromMs = filters.from === undefined ? null : parseTimeBoundary(filters.from, "from");
  const toMs = filters.to === undefined ? null : parseTimeBoundary(filters.to, "to");

  return Object.freeze(
    events.filter((event) => {
      const createdAtMs = Date.parse(event.created_at);
      if (!Number.isFinite(createdAtMs)) {
        return false;
      }

      return (
        (fromMs === null || createdAtMs >= fromMs) &&
        (toMs === null || createdAtMs <= toMs) &&
        (filters.bot_id === undefined || event.bot_id === filters.bot_id) &&
        (filters.model === undefined || event.model === filters.model) &&
        (filters.prompt_version === undefined || event.prompt_version === filters.prompt_version)
      );
    }),
  );
}

export function readProductionMetricTaskType(event: ProductionMetricEventJsonlLine): string {
  if (
    event.recovery_class !== null ||
    event.recovery_chain_id !== null ||
    (event.replan_count ?? 0) > 0
  ) {
    return "failure_recovery";
  }

  if (event.event_type === "llm.stage") {
    return `llm_${event.stage}`;
  }

  if (event.event_type === "conversation.plan_accepted") {
    return "conversation_plan_accepted";
  }

  if (event.event_type === "conversation.plan_discarded") {
    return "conversation_plan_discarded";
  }

  if (event.event_type === "task.started") {
    return "execution_started";
  }

  if (event.terminal_status !== null) {
    return "execution_terminal";
  }

  return "other";
}

function parseProductionMetricJsonlLine(
  line: string,
  lineNumber: number,
  sourceName: string,
): ProductionMetricEventJsonlLine {
  const parsed = JSON.parse(line) as unknown;
  const record = readJsonObject(parsed, sourceName, lineNumber);

  if (record.schema_version !== PRODUCTION_METRIC_SCHEMA_VERSION) {
    throw new Error(`${sourceName}:${lineNumber} has unsupported production metric schema_version`);
  }

  return createProductionMetricEventJsonlLine({
    event_id: readStringField(record, "event_id", sourceName, lineNumber),
    event_type: readStringField(
      record,
      "event_type",
      sourceName,
      lineNumber,
    ) as ProductionMetricEventType,
    message_id: readNullableStringField(record, "message_id", sourceName, lineNumber),
    task_id: readNullableStringField(record, "task_id", sourceName, lineNumber),
    bot_id: readStringField(record, "bot_id", sourceName, lineNumber),
    root_goal_id: readNullableStringField(record, "root_goal_id", sourceName, lineNumber),
    recovery_chain_id: readNullableStringField(record, "recovery_chain_id", sourceName, lineNumber),
    created_at: readStringField(record, "created_at", sourceName, lineNumber),
    source: readStringField(record, "source", sourceName, lineNumber) as ProductionMetricSource,
    prompt_version: readNullableStringField(record, "prompt_version", sourceName, lineNumber),
    model: readNullableStringField(record, "model", sourceName, lineNumber),
    stage: readStringField(record, "stage", sourceName, lineNumber) as ProductionMetricStage,
    ok: readBooleanField(record, "ok", sourceName, lineNumber),
    error_code: readNullableStringField(record, "error_code", sourceName, lineNumber),
    duration_ms: readNullableNumberField(record, "duration_ms", sourceName, lineNumber),
    input_tokens: readNullableNumberField(record, "input_tokens", sourceName, lineNumber),
    output_tokens: readNullableNumberField(record, "output_tokens", sourceName, lineNumber),
    plan_parse_ok: readNullableBooleanField(record, "plan_parse_ok", sourceName, lineNumber),
    plan_code_only_ok: readNullableBooleanField(
      record,
      "plan_code_only_ok",
      sourceName,
      lineNumber,
    ),
    plan_gate_failure_type: readNullableStringField(
      record,
      "plan_gate_failure_type",
      sourceName,
      lineNumber,
    ),
    plan_static_precheck_failure_type: readNullableStringField(
      record,
      "plan_static_precheck_failure_type",
      sourceName,
      lineNumber,
    ),
    terminal_status: readNullableStringField(
      record,
      "terminal_status",
      sourceName,
      lineNumber,
    ) as ProductionMetricTerminalStatus | null,
    step_count: readNullableNumberField(record, "step_count", sourceName, lineNumber),
    is_manual_intervention: readNullableBooleanField(
      record,
      "is_manual_intervention",
      sourceName,
      lineNumber,
    ),
    recovery_class: readNullableStringField(
      record,
      "recovery_class",
      sourceName,
      lineNumber,
    ) as FailureRecoveryClass | null,
    replan_count: readNullableNumberField(record, "replan_count", sourceName, lineNumber),
  });
}

function createReportGroups(
  events: readonly ProductionMetricEventJsonlLine[],
): readonly ProductionMetricReportGroup[] {
  return Object.freeze([
    createReportGroup("overall", "all", events),
    ...createDimensionGroups(events, "model", (event) => event.model ?? "none"),
    ...createDimensionGroups(events, "prompt_version", (event) => event.prompt_version ?? "none"),
    ...createDimensionGroups(events, "task_type", readProductionMetricTaskType),
  ]);
}

function createDimensionGroups(
  events: readonly ProductionMetricEventJsonlLine[],
  groupBy: Exclude<ProductionMetricReportGroupBy, "overall">,
  readValue: (event: ProductionMetricEventJsonlLine) => string,
): readonly ProductionMetricReportGroup[] {
  const values = [...new Set(events.map(readValue))].sort((left, right) =>
    left.localeCompare(right),
  );

  return values.map((value) =>
    createReportGroup(
      groupBy,
      value,
      events.filter((event) => readValue(event) === value),
    ),
  );
}

function createReportGroup(
  groupBy: ProductionMetricReportGroupBy,
  groupValue: string,
  events: readonly ProductionMetricEventJsonlLine[],
): ProductionMetricReportGroup {
  return Object.freeze({
    group_by: groupBy,
    group_value: groupValue,
    event_count: events.length,
    metrics: Object.freeze({
      llm: createProductionLlmMetricSummaries(events),
      execution: createProductionExecutionMetricSummaries(events),
      recovery: createProductionRecoveryMetricSummaries(events),
    }),
  });
}

function normalizeFilters(filters: ProductionMetricReportFilters): ProductionMetricReportFilters {
  return Object.freeze({
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.bot_id === undefined ? {} : { bot_id: filters.bot_id }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
    ...(filters.prompt_version === undefined ? {} : { prompt_version: filters.prompt_version }),
  });
}

function parseTimeBoundary(value: string, boundary: "from" | "to"): number {
  const dateValue =
    /^\d{4}-\d{2}-\d{2}$/u.test(value) && boundary === "from"
      ? `${value}T00:00:00.000Z`
      : /^\d{4}-\d{2}-\d{2}$/u.test(value)
        ? `${value}T23:59:59.999Z`
        : value;
  const parsed = Date.parse(dateValue);

  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --${boundary} time: ${value}`);
  }

  return parsed;
}

function createResumeSummaryZh(group: ProductionMetricReportGroup): string {
  const llm = group.metrics.llm;
  const execution = group.metrics.execution;
  const recovery = group.metrics.recovery;

  return [
    `生产窗口内记录 ${group.event_count} 条指标事件。`,
    `Plan 严格解析成功率 ${formatPercent(readMetricValue(llm, "plan_code_strict_parse_success_rate"))}，Plan 平均延迟 ${formatNumber(readMetricValue(llm, "plan_average_latency_ms"), "ms")}。`,
    `LLM 输入 token 合计 ${formatInteger(readMetricValue(llm, "llm_input_tokens_total"))}，输出 token 合计 ${formatInteger(readMetricValue(llm, "llm_output_tokens_total"))}。`,
    `执行终态任务 ${formatInteger(readMetricValue(execution, "execution_task_run_count"))} 次，无人工干预完成率 ${formatPercent(readMetricValue(execution, "execution_no_manual_completion_rate"))}，平均耗时 ${formatNumber(readMetricValue(execution, "execution_average_duration_minutes"), "分钟")}。`,
    `可恢复失败 ${formatInteger(readMetricValue(recovery, "recoverable_failure_count"))} 次，自动恢复成功率 ${formatPercent(readMetricValue(recovery, "recoverable_replan_success_rate"))}，成功恢复平均重规划 ${formatNumber(readMetricValue(recovery, "average_replan_count_to_success"), "次")}。`,
  ].join("");
}

function readMetricValue(
  metrics: readonly { readonly name: string; readonly value: number | null }[],
  name: string,
): number | null {
  return metrics.find((metric) => metric.name === name)?.value ?? null;
}

function formatPercent(value: number | null): string {
  return value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null, unit: string): string {
  return value === null ? "暂无数据" : `${value.toFixed(2)} ${unit}`;
}

function formatInteger(value: number | null): string {
  return value === null ? "暂无数据" : `${Math.round(value)}`;
}

function readJsonObject(
  value: unknown,
  sourceName: string,
  lineNumber: number,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${sourceName}:${lineNumber} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function readStringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  sourceName: string,
  lineNumber: number,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${sourceName}:${lineNumber} missing string field ${key}`);
  }

  return value;
}

function readNullableStringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  sourceName: string,
  lineNumber: number,
): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${sourceName}:${lineNumber} field ${key} must be string or null`);
  }

  return value;
}

function readBooleanField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  sourceName: string,
  lineNumber: number,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${sourceName}:${lineNumber} missing boolean field ${key}`);
  }

  return value;
}

function readNullableBooleanField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  sourceName: string,
  lineNumber: number,
): boolean | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${sourceName}:${lineNumber} field ${key} must be boolean or null`);
  }

  return value;
}

function readNullableNumberField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  sourceName: string,
  lineNumber: number,
): number | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`${sourceName}:${lineNumber} field ${key} must be number or null`);
  }

  return value;
}
