/**
 * 诊断日志路径管理与校验逻辑。
 *
 * 1. 路径工厂：为 tasks, sandbox, llm 通道提供标准化的日志引用（log_ref）和代码引用（code_ref）生成函数。
 * 2. 严格校验：通过 assertDiagnosticStorageRef 确保引用的合法性，防止越权访问或错误的路径格式（如 log_ref 必须以 .jsonl 结尾）。
 * 3. 稳压校验：在 createTaskLogLine 等工厂函数中对输入载荷进行运行时校验，确保日志行的质量和类型安全。
 */

import { createHash } from "node:crypto";

import { TaskHistoryStatus, type TaskTerminalStatus } from "../core-ports/tasking.js";
import {
  JSONL_DIRECTORY_POLICIES,
  type JsonlDirectoryPolicy,
  type StorageRefField,
  createDatedStorageRef,
  isValidStorageRef,
} from "../data/logs.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import {
  DIAGNOSTIC_LOG_CHANNELS,
  type DiagnosticLogChannel,
  type JsonlErrorSnapshot,
  type LlmCallMetrics,
  type LlmDiagnosticSummary,
  type LlmJsonlLine,
  type SandboxExperienceDraft,
  type SandboxExperienceErrorSummary,
  type SandboxJsonlLine,
  type TaskJsonlLine,
} from "./contracts.js";

const LLM_ERROR_SUMMARY_MAX_LENGTH = 240;
const SANDBOX_EXPERIENCE_SUMMARY_MAX_LENGTH = 240;
const SANDBOX_CODE_PREVIEW_MAX_LENGTH = 240;
const REDACTED_SECRET = "<redacted>";
const REDACTED_HOST_PATH = "<redacted-path>";

/**
 * 校验数值是否为正数或零。
 */
function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

/**
 * 校验 JSONL 错误快照的完整性。
 */
function assertJsonlErrorSnapshot(value: JsonlErrorSnapshot | undefined): void {
  if (!value) {
    return;
  }

  assertNonEmptyString(value.name, "error.name");
  assertNonEmptyString(value.message, "error.message");

  if (value.error_code !== undefined) {
    assertNonEmptyString(value.error_code, "error.error_code");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactKnownSensitiveValues(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((current, sensitiveValue) => {
    const normalized = sensitiveValue.trim();

    if (normalized.length === 0) {
      return current;
    }

    return current.replace(new RegExp(escapeRegExp(normalized), "g"), REDACTED_SECRET);
  }, value);
}

function redactConnectionStringPasswords(value: string): string {
  return value.replace(
    /\b(postgres(?:ql)?|redis):\/\/([^@\s]+)@/gi,
    (match: string, scheme: string, auth: string) => {
      const passwordSeparatorIndex = auth.lastIndexOf(":");

      if (passwordSeparatorIndex < 0) {
        return match;
      }

      const username = auth.slice(0, passwordSeparatorIndex);

      return `${scheme}://${username}:${REDACTED_SECRET}@`;
    },
  );
}

function redactNamedSecretValues(value: string): string {
  return value.replace(
    /\b(LLM_API_KEY|OPENAI_API_KEY|API_KEY|api_key|MC_EXTERNAL_AUTH_SECRET|MC_EXTERNAL_AUTH_PASSWORD|EasyAuth(?:\s*(?:password|密码))?|password|passwd|pwd|secret)\s*[:=]\s*["']?([^"',;\s]+)/gi,
    (_match: string, key: string) => `${key}=${REDACTED_SECRET}`,
  );
}

function redactHostSensitivePaths(value: string): string {
  const unixPathPrefixes = [
    "home",
    "Users",
    "root",
    "workspace",
    "workspaces",
    "mnt",
    "tmp",
    "var",
    "opt",
    "private",
    "Volumes",
  ].join("|");
  const pathEndPattern = "[^\\s\"'`,;)\\]}]+";
  const unixAbsolutePathPattern = new RegExp(
    `(^|[\\s"'(=:\\[{])(/(?:${unixPathPrefixes})/${pathEndPattern})`,
    "g",
  );
  const windowsAbsolutePathPattern =
    /(^|[\s"'(=:\[{])([A-Za-z]:[\\/](?:Users[\\/])?[^\s"'`,;)\]}]+)/g;

  return value
    .replace(unixAbsolutePathPattern, (_match: string, prefix: string) => {
      return `${prefix}${REDACTED_HOST_PATH}`;
    })
    .replace(windowsAbsolutePathPattern, (_match: string, prefix: string) => {
      return `${prefix}${REDACTED_HOST_PATH}`;
    });
}

function redactSensitiveDiagnosticText(
  value: string,
  options: { readonly sensitiveValues?: readonly string[] } = {},
): string {
  // 状态接口只需要定位线索，任何可疑密钥或连接串密码都必须先在诊断边界收口。
  const redacted = redactHostSensitivePaths(
    redactNamedSecretValues(
      redactConnectionStringPasswords(
        redactKnownSensitiveValues(
          value.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED_SECRET),
          options.sensitiveValues ?? [],
        ),
      ),
    ),
  );

  if (redacted.length <= LLM_ERROR_SUMMARY_MAX_LENGTH) {
    return redacted;
  }

  return `${redacted.slice(0, LLM_ERROR_SUMMARY_MAX_LENGTH)}...<truncated>`;
}

function truncateDiagnosticText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 14))}...<truncated>`;
}

function assertSandboxExperienceStatus(status: TaskTerminalStatus): void {
  if (
    status !== TaskHistoryStatus.Completed &&
    status !== TaskHistoryStatus.Failed &&
    status !== TaskHistoryStatus.Interrupted
  ) {
    throw new Error("sandbox experience status must be completed, failed, or interrupted");
  }
}

function createCodeHash(code: string): string {
  return `sha256:${createHash("sha256").update(code).digest("hex")}`;
}

function createSandboxExperienceErrorSummary(input: {
  error: {
    readonly name?: string;
    readonly message: string;
    readonly error_code?: string;
    readonly recoverable?: boolean;
  };
  sensitiveValues?: readonly string[];
}): SandboxExperienceErrorSummary {
  const name = input.error.name ?? "Error";
  assertNonEmptyString(name, "error.name");
  assertNonEmptyString(input.error.message, "error.message");

  const message = redactSensitiveDiagnosticText(input.error.message, {
    ...(input.sensitiveValues === undefined ? {} : { sensitiveValues: input.sensitiveValues }),
  });
  assertNonEmptyString(message, "error.message");

  return cloneReadonlyValue({
    name,
    message,
    ...(input.error.error_code === undefined ? {} : { error_code: input.error.error_code }),
    ...(input.error.recoverable === undefined ? {} : { recoverable: input.error.recoverable }),
  });
}

function createSandboxExperienceSummary(input: {
  status: TaskTerminalStatus;
  total_steps: number;
  duration_ms: number;
  log_ref?: string;
  code_ref?: string;
  error?: SandboxExperienceErrorSummary;
}): string {
  const base = `sandbox_code ${input.status}: steps=${input.total_steps}, ms=${input.duration_ms}`;
  const refs = [input.log_ref, input.code_ref].filter(
    (value): value is string => value !== undefined,
  );
  const errorText =
    input.error === undefined ? undefined : `error=${input.error.name}: ${input.error.message}`;
  const summary = [base, refs.length > 0 ? `refs=${refs.join(",")}` : undefined, errorText]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("; ");

  return truncateDiagnosticText(summary, SANDBOX_EXPERIENCE_SUMMARY_MAX_LENGTH);
}

/**
 * 创建诊断通道目录。
 *
 * 诊断能力公示（Capability Publicizing）：聚合所有支持的诊断通道及其保留期、引用字段元数据。
 *
 * 统一视图：为引导层（Bootstrap）提供一站式的诊断策略清单，确保系统对各通道的存储限制有全局认知。
 *
 * @returns 不可变的诊断通道目录
 */
export function createDiagnosticsCatalog(): Readonly<{
  channels: readonly Readonly<{
    channel: DiagnosticLogChannel;
    retention_days: number;
    ref_fields: readonly StorageRefField[];
  }>[];
}> {
  return Object.freeze({
    channels: Object.freeze(
      DIAGNOSTIC_LOG_CHANNELS.map((channel) =>
        Object.freeze({
          channel,
          retention_days: JSONL_DIRECTORY_POLICIES[channel].retentionDays,
          ref_fields: Object.freeze([...JSONL_DIRECTORY_POLICIES[channel].refFields]),
        }),
      ),
    ),
  });
}

/**
 * 获取诊断通道对应的数据目录策略。
 *
 * 策略透传：作为 data/logs 策略定义的出口，供运行时逻辑快速获取目录规则。
 */
export function getDiagnosticsChannelPolicy(channel: DiagnosticLogChannel): JsonlDirectoryPolicy {
  return JSONL_DIRECTORY_POLICIES[channel];
}

/**
 * 校验诊断日志引用的合法性。
 *
 * 存储安全审计（Storage Auditing）：强制执行通道间的物理路径隔离与文件后缀规范。
 *
 * 越权防御：确保 tasks 通道无法写入 sandbox 路径，log_ref 必须以 .jsonl 结尾，从协议层面拦截潜在的目录穿越或文件伪造风险。
 *
 * @param input 包含通道、引用字段和待校验值的输入
 */
export function assertDiagnosticStorageRef(input: {
  channel: DiagnosticLogChannel;
  refField: StorageRefField;
  value: string;
}): void {
  const policy = JSONL_DIRECTORY_POLICIES[input.channel];

  if (!(policy.refFields as readonly StorageRefField[]).includes(input.refField)) {
    throw new Error(`Channel ${input.channel} does not allow ${input.refField}`);
  }

  if (!isValidStorageRef(input.value)) {
    throw new Error(`Invalid storage ref: ${input.value}`);
  }

  if (!input.value.startsWith(`${input.channel}/`)) {
    throw new Error(`Storage ref ${input.value} must stay inside ${input.channel}/`);
  }

  if (input.refField === "log_ref" && !input.value.endsWith(".jsonl")) {
    throw new Error(`log_ref must point to a .jsonl file: ${input.value}`);
  }

  if (input.refField === "code_ref" && !input.value.endsWith(".code.ts")) {
    throw new Error(`code_ref must point to a .code.ts file: ${input.value}`);
  }
}

/**
 * 创建任务执行通道的日志引用。
 *
 * 路径标准化：生成符合 tasks/date/jobId.jsonl 规则的物理路径引用。
 */
export function createTaskLogRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "tasks",
    date: input.date,
    fileName: `${input.job_id}.jsonl`,
  });
}

/**
 * 创建沙箱执行通道的 JSONL 引用。
 */
export function createSandboxLogRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "sandbox",
    date: input.date,
    fileName: `${input.job_id}.jsonl`,
  });
}

/**
 * 创建沙箱执行通道的原始代码引用。
 */
export function createSandboxCodeRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "sandbox",
    date: input.date,
    fileName: `${input.job_id}.code.ts`,
  });
}

/**
 * 创建 LLM 通道的调用日志引用。
 */
export function createLlmLogRef(input: {
  date: string;
  stage: "triage" | "chat" | "plan" | "brain";
  message_id: string;
}): string {
  return createDatedStorageRef({
    directory: "llm",
    date: input.date,
    fileName: `${input.stage}-${input.message_id}.jsonl`,
  });
}

/**
 * 创建任务执行通道的只读日志行。
 *
 * 1. 日志行稳压工厂（Stabilizing Factory）：在日志最终写入前，对各个事件类型的内部字段进行运行时校验。
 * 2. 类型安全保障：确保 step 类型的日志行必须包含 act (Action)，且 err 状态必须携带完整的错误快照。
 * 3. 状态完整性：校验完成（Completed）或中断（Interrupted）时的元数据（步数、耗时）是否完整。
 *
 * @param input 原始日志行对象
 * @returns 经过校验并克隆的只读日志行
 */
export function createTaskLogLine<TAction extends string, TLine extends TaskJsonlLine<TAction>>(
  input: TLine,
): TLine {
  assertPositiveNumber(input.t, "t");

  switch (input.e) {
    case "task.started":
      assertNonEmptyString(input.job, "job");
      assertPositiveNumber(input.epoch, "epoch");
      break;
    case "step":
      assertPositiveNumber(input.i, "i");
      assertNonEmptyString(input.act, "act");
      if (input.s === "err" && input.err === undefined) {
        throw new Error("step log with err status must include err");
      }
      assertJsonlErrorSnapshot(input.err);
      break;
    case "task.completed":
    case "task.interrupted":
      assertNonEmptyString(input.job, "job");
      assertPositiveNumber(input.steps, "steps");
      assertPositiveNumber(input.ms, "ms");
      if (input.e === "task.interrupted") {
        assertNonEmptyString(input.reason, "reason");
      }
      break;
    case "task.failed":
      assertNonEmptyString(input.job, "job");
      assertPositiveNumber(input.steps, "steps");
      assertPositiveNumber(input.ms, "ms");
      assertJsonlErrorSnapshot(input.err);
      if (input.err === undefined) {
        throw new Error("task.failed log must include err");
      }
      break;
  }

  return cloneReadonlyValue(input);
}

/**
 * 创建沙箱执行通道的只读日志行。
 *
 * 生命周期校验：负责校验沙箱从预检（Precheck）到完成（Done）各个阶段的日志行。
 *
 * 阶段必填项约束：强制要求 precheck 失败时必须携带违反规则的说明（violation），transpile 失败必须带错误对象。
 *
 * @param input 原始沙箱日志行
 * @returns 经过校验的只读日志行
 */
export function createSandboxLogLine<TLine extends SandboxJsonlLine>(input: TLine): TLine {
  assertPositiveNumber(input.t, "t");

  switch (input.phase) {
    case "precheck":
      if (!input.ok && input.violation === undefined) {
        throw new Error("precheck failure must include violation");
      }
      break;
    case "transpile":
      if (!input.ok && input.err === undefined) {
        throw new Error("transpile failure must include err");
      }
      assertJsonlErrorSnapshot(input.err);
      if (input.ms !== undefined) {
        assertPositiveNumber(input.ms, "ms");
      }
      break;
    case "isolate_create":
      assertPositiveNumber(input.mem_mb, "mem_mb");
      break;
    case "facade_call":
      assertNonEmptyString(input.m, "m");
      break;
    case "facade_result":
      assertNonEmptyString(input.m, "m");
      if (input.s !== "ok" && input.err === undefined) {
        throw new Error("facade_result failure must include err");
      }
      assertJsonlErrorSnapshot(input.err);
      if (input.ms !== undefined) {
        assertPositiveNumber(input.ms, "ms");
      }
      break;
    case "console":
      break;
    case "sandbox_complete":
    case "sandbox_done":
      assertPositiveNumber(input.steps, "steps");
      assertPositiveNumber(input.ms, "ms");
      break;
  }

  return cloneReadonlyValue(input);
}

/**
 * 创建大语言模型通道的只读日志行。
 *
 * 调用元数据完整性：强制校验 LLM 调用时的模型名、Token 数及耗时统计，确保审计信息足以支撑成本分析和性能监控。
 *
 * @param input 原始 LLM 日志行
 * @returns 经过校验的只读日志行
 */
export function createLlmLogLine<TLine extends LlmJsonlLine>(input: TLine): TLine {
  assertPositiveNumber(input.t, "t");

  if ("stage" in input) {
    assertNonEmptyString(input.model, "model");
    assertNonEmptyString(input.msg_id, "msg_id");
  } else if ("role" in input) {
    if (input.tool_calls === undefined || input.tool_calls.length === 0) {
      assertNonEmptyString(input.content, "content");
    }
  } else {
    assertPositiveNumber(input.meta.input_tokens, "meta.input_tokens");
    assertPositiveNumber(input.meta.output_tokens, "meta.output_tokens");
    assertPositiveNumber(input.meta.ms, "meta.ms");
    assertLlmCallMetrics(input.meta.metrics);
    assertJsonlErrorSnapshot(input.err);
    if (!input.meta.ok && input.err === undefined) {
      throw new Error("llm meta with ok=false must include err");
    }
  }

  return cloneReadonlyValue(input);
}

function assertLlmCallMetrics(metrics: LlmCallMetrics | undefined): void {
  if (metrics === undefined) {
    return;
  }

  assertPositiveNumber(metrics.queue_wait_ms, "metrics.queue_wait_ms");
  assertPositiveNumber(metrics.prompt_build_ms, "metrics.prompt_build_ms");
  assertPositiveNumber(metrics.request_total_ms, "metrics.request_total_ms");
  assertPositiveNumber(metrics.response_parse_ms, "metrics.response_parse_ms");
  assertPositiveNumber(metrics.tool_round_count, "metrics.tool_round_count");
  for (const value of metrics.tool_round_ms) {
    assertPositiveNumber(value, "metrics.tool_round_ms");
  }
  if (metrics.diagnostics_write_ms !== null) {
    assertPositiveNumber(metrics.diagnostics_write_ms, "metrics.diagnostics_write_ms");
  }
  assertPositiveNumber(metrics.input_tokens, "metrics.input_tokens");
  assertPositiveNumber(metrics.output_tokens, "metrics.output_tokens");
  assertPositiveNumber(metrics.tokens_per_second, "metrics.tokens_per_second");
  if (metrics.ttft_ms !== null) {
    assertPositiveNumber(metrics.ttft_ms, "metrics.ttft_ms");
  }
}

/**
 * 创建 LLM（大语言模型） 最近调用诊断摘要。
 *
 * 状态接口只暴露定位线索，不包含完整 prompt（提示词） 或 completion（补全） 内容。
 *
 * @param input 原始诊断摘要
 * @param options 需要额外精确屏蔽的敏感值
 */
export function createLlmDiagnosticSummary(
  input: LlmDiagnosticSummary,
  options: { readonly sensitiveValues?: readonly string[] } = {},
): LlmDiagnosticSummary {
  assertNonEmptyString(input.stage, "stage");
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.model, "model");
  assertNonEmptyString(input.log_ref, "log_ref");
  assertNonEmptyString(input.created_at, "created_at");
  assertDiagnosticStorageRef({
    channel: "llm",
    refField: "log_ref",
    value: input.log_ref,
  });

  const errorSummary =
    input.error_summary === undefined
      ? undefined
      : redactSensitiveDiagnosticText(input.error_summary, options);

  if (input.status === "error" && errorSummary !== undefined) {
    assertNonEmptyString(errorSummary, "error_summary");
  }

  return cloneReadonlyValue({
    stage: input.stage,
    message_id: input.message_id,
    status: input.status,
    model: input.model,
    log_ref: input.log_ref,
    created_at: input.created_at,
    ...(errorSummary === undefined ? {} : { error_summary: errorSummary }),
    ...(input.metrics === undefined ? {} : { metrics: cloneReadonlyValue(input.metrics) }),
  });
}

/**
 * 创建 sandbox experience（沙箱经验） 草案。
 *
 * 该工厂只做确定性契约转换，不写数据库、不写 JSONL（结构化日志）文件；输出已脱敏、限长并深冻结。
 *
 * @param input 沙箱终态上下文与可选源码 / 错误信息
 * @returns 可交给后续持久化层的沙箱经验草案
 */
export function createSandboxExperienceDraft(input: {
  bot_id: string;
  message_id: string;
  intent_epoch: number;
  status: TaskTerminalStatus;
  total_steps: number;
  duration_ms: number;
  log_ref?: string;
  code_ref?: string;
  code?: string;
  error?: {
    readonly name?: string;
    readonly message: string;
    readonly error_code?: string;
    readonly recoverable?: boolean;
  };
  sensitiveValues?: readonly string[];
}): SandboxExperienceDraft {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.message_id, "message_id");
  assertPositiveNumber(input.intent_epoch, "intent_epoch");
  assertSandboxExperienceStatus(input.status);
  assertPositiveNumber(input.total_steps, "total_steps");
  assertPositiveNumber(input.duration_ms, "duration_ms");

  if (input.log_ref !== undefined) {
    assertDiagnosticStorageRef({
      channel: "sandbox",
      refField: "log_ref",
      value: input.log_ref,
    });
  }

  if (input.code_ref !== undefined) {
    assertDiagnosticStorageRef({
      channel: "sandbox",
      refField: "code_ref",
      value: input.code_ref,
    });
  }

  if (input.status === TaskHistoryStatus.Failed && input.error === undefined) {
    throw new Error("failed sandbox experience requires error");
  }

  const error =
    input.error === undefined
      ? undefined
      : createSandboxExperienceErrorSummary({
          error: input.error,
          ...(input.sensitiveValues === undefined
            ? {}
            : { sensitiveValues: input.sensitiveValues }),
        });
  const codeHash = input.code === undefined ? undefined : createCodeHash(input.code);
  const codePreview =
    input.code === undefined
      ? undefined
      : truncateDiagnosticText(
          redactSensitiveDiagnosticText(input.code, {
            ...(input.sensitiveValues === undefined
              ? {}
              : { sensitiveValues: input.sensitiveValues }),
          }),
          SANDBOX_CODE_PREVIEW_MAX_LENGTH,
        );
  const summary = createSandboxExperienceSummary({
    status: input.status,
    total_steps: input.total_steps,
    duration_ms: input.duration_ms,
    ...(input.log_ref === undefined ? {} : { log_ref: input.log_ref }),
    ...(input.code_ref === undefined ? {} : { code_ref: input.code_ref }),
    ...(error === undefined ? {} : { error }),
  });

  return cloneReadonlyValue({
    bot_id: input.bot_id,
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    status: input.status,
    total_steps: input.total_steps,
    duration_ms: input.duration_ms,
    ...(input.log_ref === undefined ? {} : { log_ref: input.log_ref }),
    ...(input.code_ref === undefined ? {} : { code_ref: input.code_ref }),
    ...(codeHash === undefined ? {} : { code_hash: codeHash }),
    ...(codePreview === undefined ? {} : { code_preview: codePreview }),
    ...(error === undefined ? {} : { error }),
    summary,
  });
}
