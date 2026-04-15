/**
 * 诊断日志路径管理与校验逻辑。
 * 
 * 架构职责：
 * 1. 路径工厂：为 tasks, sandbox, llm 通道提供标准化的日志引用（log_ref）和代码引用（code_ref）生成函数。
 * 2. 严格校验：通过 assertDiagnosticStorageRef 确保引用的合法性，防止越权访问或错误的路径格式（如 log_ref 必须以 .jsonl 结尾）。
 * 3. 稳压校验：在 createTaskLogLine 等工厂函数中对输入载荷进行运行时校验，确保日志行的质量和类型安全。
 */

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
  type LlmJsonlLine,
  type SandboxJsonlLine,
  type TaskJsonlLine,
} from "./contracts.js";

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
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

/**
 * 创建诊断通道目录。
 * 
 * 架构意图：
 * 聚合所有支持的诊断通道（tasks, sandbox, llm）的元数据，包括其保留期（retention_days）
 * 和允许的持久化引用字段（ref_fields）。这为上层提供了统一的诊断能力视图。
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

/** 读取单个 diagnostics（诊断） 通道对应的数据目录策略。 */
export function getDiagnosticsChannelPolicy(channel: DiagnosticLogChannel): JsonlDirectoryPolicy {
  return JSONL_DIRECTORY_POLICIES[channel];
}

/**
 * 校验诊断日志引用的合法性。
 * 
 * 架构约束：
 * 1. 字段权限：确保所使用的引用字段（log_ref/code_ref）属于对应的通道策略。
 * 2. 路径隔离：强制要求路径必须以对应通道名开头（如 tasks/）。
 * 3. 格式规范：log_ref 必须以 .jsonl 结尾，code_ref 必须以 .code.ts 结尾。
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

/**
 * 创建任务执行通道的只读日志行。
 * 
 * 架构意图：
 * 作为一个“稳压工厂”，它负责在日志行被最终处理前，对其内部字段进行严格校验：
 * 1. 任务元数据（Job ID, Epoch）校验。
 * 2. 步骤逻辑一致性校验（如 err 状态必须携带错误对象）。
 * 3. 时序元信息校验。
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
 * 架构意图：
 * 负责校验沙箱执行周期的各个阶段（precheck, transpile, facade_call 等）：
 * 1. 阶段必填项校验（如 precheck 失败必须带 violation）。
 * 2. 耗时统计合法性校验。
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
 * 架构意图：
 * 负责校验 LLM 调用的关键元数据（模型名, Token 数, 耗时, 角色内容等），
 * 确保调用流水线的诊断信息完整。
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
    assertNonEmptyString(input.content, "content");
  } else {
    assertPositiveNumber(input.meta.input_tokens, "meta.input_tokens");
    assertPositiveNumber(input.meta.output_tokens, "meta.output_tokens");
    assertPositiveNumber(input.meta.ms, "meta.ms");
  }

  return cloneReadonlyValue(input);
}
