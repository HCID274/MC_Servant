import {
  EVAL_ATTEMPT_STATUSES,
  EVAL_CASE_KINDS,
  EVAL_EXECUTION_TERMINAL_STATUSES,
  EVAL_JSONL_KINDS,
  EVAL_JSONL_SCHEMA_VERSION,
  EVAL_METRIC_IDS,
  EVAL_RECOVERY_CLASSES,
  EVAL_RUN_STATUSES,
  EVAL_STAGES,
  type EvalAttemptJsonlLine,
  type EvalCaseJsonlLine,
  type EvalCaseKind,
  type EvalExecutionTerminalStatus,
  type EvalJsonlLine,
  type EvalMetricId,
  type EvalMetricJsonlLine,
  type EvalRecoveryClass,
  type EvalRunJsonlLine,
  type EvalStage,
} from "../data/contracts/index.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import { redactLocalDiagnosticJsonText } from "./local-log-redaction.js";

const REDACTED_API_KEY = "<redacted>" as const;

/** 创建 case（评测样本） JSONL 行。 */
export function createEvalCaseJsonlLine(input: Omit<EvalCaseJsonlLine, "schema_version" | "kind">) {
  assertNonEmptyString(input.case_id, "case_id");
  assertEvalStage(input.stage);
  if (input.case_kind !== undefined) {
    assertEvalCaseKind(input.case_kind);
  }
  assertNonEmptyString(input.input.message_id, "input.message_id");

  return cloneReadonlyValue({
    schema_version: EVAL_JSONL_SCHEMA_VERSION,
    kind: "case",
    ...input,
  } satisfies EvalCaseJsonlLine);
}

/** 创建 run（评测运行） JSONL 行。 */
export function createEvalRunJsonlLine(input: Omit<EvalRunJsonlLine, "schema_version" | "kind">) {
  assertNonEmptyString(input.run_id, "run_id");
  assertEvalRunStatus(input.status);
  assertNonEmptyString(input.started_at, "started_at");
  assertNonEmptyString(input.config.base_url, "config.base_url");
  assertNonEmptyString(input.config.model, "config.model");
  if (input.config.api_key !== REDACTED_API_KEY) {
    throw new Error("eval run config api_key must be redacted");
  }
  assertNonNegativeInteger(input.case_count, "case_count");

  return cloneReadonlyValue({
    schema_version: EVAL_JSONL_SCHEMA_VERSION,
    kind: "run",
    ...input,
  } satisfies EvalRunJsonlLine);
}

/** 创建 attempt（单次样本尝试） JSONL 行。 */
export function createEvalAttemptJsonlLine(
  input: Omit<EvalAttemptJsonlLine, "schema_version" | "kind">,
) {
  assertNonEmptyString(input.run_id, "run_id");
  assertNonEmptyString(input.case_id, "case_id");
  assertEvalStage(input.stage);
  if (input.case_kind !== undefined) {
    assertEvalCaseKind(input.case_kind);
  }
  assertEvalAttemptStatus(input.status);
  assertNonNegativeNumber(input.latency_ms, "latency_ms");
  assertNonNegativeInteger(input.input_tokens, "input_tokens");
  assertNonNegativeInteger(input.output_tokens, "output_tokens");
  if (input.terminal_status !== undefined) {
    assertExecutionTerminalStatus(input.terminal_status);
  }
  if (input.step_count !== undefined) {
    assertNonNegativeInteger(input.step_count, "step_count");
  }
  if (input.duration_ms !== undefined) {
    assertNonNegativeNumber(input.duration_ms, "duration_ms");
  }
  if (input.recovery_class !== undefined) {
    assertRecoveryClass(input.recovery_class);
  }
  if (input.replan_count !== undefined) {
    assertNonNegativeInteger(input.replan_count, "replan_count");
  }

  if (input.token_saving !== undefined) {
    assertNonNegativeInteger(
      input.token_saving.avoided_input_tokens,
      "token_saving.avoided_input_tokens",
    );
    assertNonNegativeInteger(
      input.token_saving.actual_input_tokens,
      "token_saving.actual_input_tokens",
    );
    assertRatio(input.token_saving.saved_ratio, "token_saving.saved_ratio");
  }

  return cloneReadonlyValue({
    schema_version: EVAL_JSONL_SCHEMA_VERSION,
    kind: "attempt",
    ...input,
  } satisfies EvalAttemptJsonlLine);
}

/** 创建 metric（汇总指标） JSONL 行。 */
export function createEvalMetricJsonlLine(
  input: Omit<EvalMetricJsonlLine, "schema_version" | "kind">,
) {
  assertNonEmptyString(input.run_id, "run_id");
  assertEvalMetricId(input.metric_id);
  assertNonEmptyString(input.name, "name");
  assertNonNegativeNumber(input.value, "value");
  assertNonNegativeNumber(input.numerator, "numerator");
  assertNonNegativeNumber(input.denominator, "denominator");

  return cloneReadonlyValue({
    schema_version: EVAL_JSONL_SCHEMA_VERSION,
    kind: "metric",
    ...input,
  } satisfies EvalMetricJsonlLine);
}

/** 序列化 eval JSONL 行，敏感值在文本边界再兜底脱敏。 */
export function serializeEvalJsonlLine(
  line: EvalJsonlLine,
  sensitiveValues: readonly string[] = [],
): string {
  return redactLocalDiagnosticJsonText(JSON.stringify(line), sensitiveValues);
}

/** 从 JSONL 文本读取 case 行。 */
export function parseEvalCaseJsonlLines(content: string): readonly EvalCaseJsonlLine[] {
  return Object.freeze(
    content
      .split(/\r?\n/u)
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0)
      .map(({ line, lineNumber }) => parseEvalCaseJsonlLine(line, lineNumber)),
  );
}

function parseEvalCaseJsonlLine(line: string, lineNumber: number): EvalCaseJsonlLine {
  const parsed = JSON.parse(line) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`eval case line ${lineNumber} must be a JSON object`);
  }

  const record = parsed as Partial<EvalCaseJsonlLine>;

  if (record.schema_version !== EVAL_JSONL_SCHEMA_VERSION) {
    throw new Error(`eval case line ${lineNumber} has unsupported schema_version`);
  }
  if (record.kind !== "case") {
    throw new Error(`eval case line ${lineNumber} must have kind=case`);
  }
  if (typeof record.case_id !== "string") {
    throw new Error(`eval case line ${lineNumber} missing case_id`);
  }
  if (typeof record.stage !== "string" || !isEvalStage(record.stage)) {
    throw new Error(`eval case line ${lineNumber} has invalid stage`);
  }
  if (
    typeof record.input !== "object" ||
    record.input === null ||
    Array.isArray(record.input) ||
    typeof record.input.message_id !== "string"
  ) {
    throw new Error(`eval case line ${lineNumber} has invalid input`);
  }

  return createEvalCaseJsonlLine({
    case_id: record.case_id,
    stage: record.stage,
    ...(record.tags === undefined ? {} : { tags: record.tags }),
    ...(record.case_kind === undefined ? {} : { case_kind: record.case_kind }),
    input: record.input,
    ...(record.expect === undefined ? {} : { expect: record.expect }),
    ...(record.token_saving_probe === undefined
      ? {}
      : { token_saving_probe: record.token_saving_probe }),
  });
}

function assertEvalStage(value: EvalStage): void {
  if (!isEvalStage(value)) {
    throw new Error(`unsupported eval stage: ${value}`);
  }
}

function isEvalStage(value: string): value is EvalStage {
  return (EVAL_STAGES as readonly string[]).includes(value);
}

function assertEvalCaseKind(value: EvalCaseKind): void {
  if (!(EVAL_CASE_KINDS as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval case kind: ${value}`);
  }
}

function assertEvalRunStatus(value: string): void {
  if (!(EVAL_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval run status: ${value}`);
  }
}

function assertEvalAttemptStatus(value: string): void {
  if (!(EVAL_ATTEMPT_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval attempt status: ${value}`);
  }
}

function assertEvalMetricId(value: EvalMetricId): void {
  if (!(EVAL_METRIC_IDS as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval metric id: ${value}`);
  }
}

function assertExecutionTerminalStatus(value: EvalExecutionTerminalStatus): void {
  if (!(EVAL_EXECUTION_TERMINAL_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval terminal status: ${value}`);
  }
}

function assertRecoveryClass(value: EvalRecoveryClass): void {
  if (!(EVAL_RECOVERY_CLASSES as readonly string[]).includes(value)) {
    throw new Error(`unsupported eval recovery class: ${value}`);
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

function assertNonNegativeNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

function assertRatio(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${fieldName} must be a ratio between 0 and 1`);
  }
}
