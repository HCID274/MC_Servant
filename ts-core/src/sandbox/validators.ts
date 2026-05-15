import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { assertDiagnosticStorageRef } from "../diagnostics/logs.js";
import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import {
  SANDBOX_ERROR_NAMES,
  SANDBOX_STEP_ACTION_NAMES,
  type SandboxExecutionError,
  type SandboxStepActionName,
} from "./contracts.js";

/** 断言数值是否为正整数。 */
export function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

/** 断言数值是否为正数。 */
export function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
}

/** 判断字符串是否为合法的沙箱步骤动作名。 */
export function isSandboxStepActionName(value: string): value is SandboxStepActionName {
  return (SANDBOX_STEP_ACTION_NAMES as readonly string[]).includes(value);
}

/** 校验沙箱错误对象的合法性与完整性。 */
export function assertSandboxError(error: SandboxExecutionError): void {
  if (!(SANDBOX_ERROR_NAMES as readonly string[]).includes(error.name)) {
    throw new Error(`Unsupported sandbox error: ${error.name}`);
  }

  assertNonEmptyString(error.message, "error.message");

  switch (error.name) {
    case "StaticCheckError":
      assertNonEmptyString(error.violation, "error.violation");
      break;
    case "TranspileError":
      if (error.diagnostics?.some((item) => item.trim().length === 0) === true) {
        throw new Error("error.diagnostics must not contain empty items");
      }
      break;
    case "SandboxTimeoutError":
      assertPositiveInteger(error.timeout_ms, "error.timeout_ms");
      break;
    case "SandboxOOMError":
      assertPositiveInteger(error.memory_limit_mb, "error.memory_limit_mb");
      break;
    case "FacadeCallError":
      if (!isSandboxStepActionName(error.method)) {
        throw new Error(`Unsupported sandbox action: ${error.method}`);
      }
      assertNonEmptyString(error.error_code, "error.error_code");
      break;
    case "AbortError":
      if (error.recoverable) {
        throw new Error("AbortError.recoverable must be false");
      }
      assertNonEmptyString(error.reason, "error.reason");
      break;
    case "UnhandledError":
      if (error.stack !== undefined) {
        assertNonEmptyString(error.stack, "error.stack");
      }
      break;
  }
}

/** 校验沙箱阶段性日志是否非空。 */
export function assertSandboxPhaseLogs(phaseLogs: readonly SandboxJsonlLine[]): void {
  if (phaseLogs.length === 0) {
    throw new Error("phase_logs must contain at least one entry");
  }
}

/** 校验沙箱结果中的日志与代码引用是否符合存储安全契约。 */
export function assertSandboxResultRefs(input: {
  log_ref: string;
  code_ref?: string;
}): void {
  assertDiagnosticStorageRef({
    channel: "sandbox",
    refField: "log_ref",
    value: input.log_ref,
  });

  if (input.code_ref !== undefined) {
    assertDiagnosticStorageRef({
      channel: "sandbox",
      refField: "code_ref",
      value: input.code_ref,
    });
  }
}

/**
 * 创建结构化的沙箱错误对象。
 *
 * 1. 稳压校验：在错误穿过沙箱边界进入主进程前进行严格审计。
 * 2. 契约保证：确保所有沙箱异常均包含必要上下文。
 */
export function createSandboxError<TError extends SandboxExecutionError>(input: TError): TError {
  assertSandboxError(input);

  return cloneReadonlyValue(input);
}

export function isSandboxExecutionError(value: unknown): value is SandboxExecutionError {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (SANDBOX_ERROR_NAMES as readonly string[]).includes(String(value.name))
  );
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function toJsonlErrorSnapshot(error: SandboxExecutionError): {
  readonly name: string;
  readonly message: string;
  readonly error_code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly recoverable?: boolean;
} {
  return Object.freeze({
    name: error.name,
    message: error.message,
    ...("error_code" in error ? { error_code: error.error_code } : {}),
    ...("details" in error && error.details !== undefined ? { details: error.details } : {}),
    recoverable: error.recoverable,
  });
}
