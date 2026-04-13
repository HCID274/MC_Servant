import {
  JSONL_DIRECTORY_POLICIES,
  type JsonlDirectoryPolicy,
  type StorageRefField,
  createDatedStorageRef,
  isValidStorageRef,
} from "../data/logs.js";
import {
  DIAGNOSTIC_LOG_CHANNELS,
  type DiagnosticLogChannel,
  type JsonlErrorSnapshot,
  type LlmJsonlLine,
  type SandboxJsonlLine,
  type TaskJsonlLine,
} from "./contracts.js";

function cloneReadonlyValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneReadonlyValue(item))) as TValue;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entryValue]) => [
      key,
      cloneReadonlyValue(entryValue),
    ]);

    return Object.freeze(Object.fromEntries(entries)) as TValue;
  }

  return value;
}

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

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

/** 创建 diagnostics（诊断） 模块的通道目录与保留期目录。 */
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

/** 读取单个 diagnostics（诊断） 通道对应的数据目录策略。 */
export function getDiagnosticsChannelPolicy(channel: DiagnosticLogChannel): JsonlDirectoryPolicy {
  return JSONL_DIRECTORY_POLICIES[channel];
}

/** 校验日志引用是否匹配指定 diagnostics（诊断） 通道与字段。 */
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

/** 创建 tasks（任务执行） 通道的日志引用。 */
export function createTaskLogRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "tasks",
    date: input.date,
    fileName: `${input.job_id}.jsonl`,
  });
}

/** 创建 sandbox（沙箱执行） 通道的 JSONL（结构化日志） 引用。 */
export function createSandboxLogRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "sandbox",
    date: input.date,
    fileName: `${input.job_id}.jsonl`,
  });
}

/** 创建 sandbox（沙箱执行） 通道的原始代码引用。 */
export function createSandboxCodeRef(input: { date: string; job_id: string }): string {
  return createDatedStorageRef({
    directory: "sandbox",
    date: input.date,
    fileName: `${input.job_id}.code.ts`,
  });
}

/** 创建 llm（大语言模型） 通道的调用日志引用。 */
export function createLlmLogRef(input: {
  date: string;
  stage: "triage" | "chat" | "plan";
  message_id: string;
}): string {
  return createDatedStorageRef({
    directory: "llm",
    date: input.date,
    fileName: `${input.stage}-${input.message_id}.jsonl`,
  });
}

/** 创建 tasks（任务执行） 通道的只读日志行。 */
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

/** 创建 sandbox（沙箱执行） 通道的只读日志行。 */
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

/** 创建 llm（大语言模型） 通道的只读日志行。 */
export function createLlmLogLine<TLine extends LlmJsonlLine>(input: TLine): TLine {
  assertPositiveNumber(input.t, "t");

  if ("stage" in input) {
    assertNonEmptyString(input.model, "model");
    assertNonEmptyString(input.msg_id, "msg_id");
  } else if ("role" in input) {
    assertNonEmptyString(input.content, "content");
  } else {
    assertPositiveNumber(input.meta.input_tokens, "meta.input_tokens");
    assertPositiveNumber(input.meta.output_tokens, "meta.output_tokens");
    assertPositiveNumber(input.meta.ms, "meta.ms");
  }

  return cloneReadonlyValue(input);
}
