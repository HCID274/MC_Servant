import type {
  AbortError,
  FacadeCallError,
  SandboxExecutionError,
  SandboxExecutionResourceLimits,
  SandboxStepActionName,
  SandboxStepResult,
  TranspileError,
  UnhandledError,
} from "./contracts.js";
import { createSandboxError, isSandboxExecutionError } from "./validators.js";

export function createTranspileError(error: unknown): TranspileError {
  return createSandboxError({
    name: "TranspileError",
    message: "Sandbox TypeScript transpile failed",
    recoverable: false,
    diagnostics: [error instanceof Error ? error.message : String(error)],
  });
}

export function createRuntimeSandboxError(
  error: unknown,
  limits: SandboxExecutionResourceLimits,
): SandboxExecutionError {
  if (isAbortError(error)) {
    return createSandboxAbortError(error.reason ?? error.message);
  }

  if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
    return createSandboxTimeoutError(limits);
  }

  if (error instanceof Error && error.message.includes("Array buffer allocation failed")) {
    return createSandboxError({
      name: "SandboxOOMError",
      message: error.message,
      recoverable: false,
      memory_limit_mb: limits.memory_limit_mb,
    });
  }

  const unhandledError: UnhandledError = {
    name: "UnhandledError",
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };

  return createSandboxError(unhandledError);
}

export function createSandboxTimeoutError(
  limits: SandboxExecutionResourceLimits,
): SandboxExecutionError {
  return createSandboxError({
    name: "SandboxTimeoutError",
    message: "Sandbox execution timed out",
    recoverable: false,
    timeout_ms: limits.timeout_ms,
  });
}

export function createSandboxAbortError(reason: unknown): AbortError {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim().length > 0
        ? reason
        : "Sandbox execution aborted";
  return createSandboxError({
    name: "AbortError",
    message,
    recoverable: false,
    reason: message,
  });
}

export function readAbortReason(reason: unknown): SandboxExecutionError {
  return isSandboxExecutionError(reason) ? reason : createSandboxAbortError(reason);
}

export function isAbortError(error: unknown): error is AbortError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
}

export function createFacadeCallError(
  action: SandboxStepActionName,
  params: SandboxStepResult["params"],
  error: unknown,
  detailsOverlay: Readonly<Record<string, unknown>> = {},
): FacadeCallError {
  const details = mergeFacadeErrorDetails(readFacadeErrorDetails(error).details, detailsOverlay);
  return createSandboxError({
    name: "FacadeCallError",
    message: error instanceof Error ? error.message : String(error),
    recoverable: true,
    method: action,
    params: params as Readonly<Record<string, unknown>>,
    error_code: readFacadeErrorCode(error),
    ...(details === undefined ? {} : { details }),
  });
}

export function createToolchainCapabilityFacadeError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Error {
  const detailText = formatToolchainErrorDetails(details);
  return Object.assign(new Error(`${message}${detailText}`), {
    error_code: code,
    ...(details === undefined ? {} : { details }),
  });
}

function mergeFacadeErrorDetails(
  details: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  return Object.keys(overlay).length === 0 && details === undefined
    ? undefined
    : Object.freeze({
        ...(details ?? {}),
        ...overlay,
      });
}

function readFacadeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "facade_call_failed";
  }

  const errorCode = (error as { readonly error_code?: unknown }).error_code;
  return typeof errorCode === "string" && errorCode.trim().length > 0
    ? errorCode
    : "facade_call_failed";
}

function readFacadeErrorDetails(error: unknown): {
  readonly details?: Readonly<Record<string, unknown>>;
} {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const details = (error as { readonly details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return {};
  }

  return { details: details as Readonly<Record<string, unknown>> };
}

function formatToolchainErrorDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): string {
  if (details === undefined) {
    return "";
  }

  try {
    return ` details=${JSON.stringify(details)}`;
  } catch (error) {
    void error;
    return " details=<unserializable>";
  }
}
