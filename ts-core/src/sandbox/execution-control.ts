import type { SandboxFacadeCallControl } from "../core-ports/sandbox.js";
import type { SandboxExecutionError, SandboxExecutionResourceLimits } from "./contracts.js";
import { createSandboxAbortError, createSandboxTimeoutError, readAbortReason } from "./errors.js";

export interface SandboxExecutionControlState {
  readonly abortController: AbortController;
  readonly activeFacadeCalls: Set<Promise<void>>;
  readonly deadlineMs: number;
  terminalError: SandboxExecutionError | null;
}

export function createSandboxExecutionControlState(input: {
  startedAt: number;
  resourceLimits: SandboxExecutionResourceLimits;
}): SandboxExecutionControlState {
  return {
    abortController: new AbortController(),
    activeFacadeCalls: new Set<Promise<void>>(),
    deadlineMs: input.startedAt + input.resourceLimits.timeout_ms,
    terminalError: null,
  };
}

export function createSandboxFacadeCallControl(
  state: SandboxExecutionControlState,
): SandboxFacadeCallControl {
  return Object.freeze({
    signal: state.abortController.signal,
    deadline_ms: state.deadlineMs,
  });
}

export function assertSandboxFacadeCallAllowed(
  state: SandboxExecutionControlState,
  limits: SandboxExecutionResourceLimits,
  now: number,
): void {
  if (state.terminalError !== null) {
    throw new Error(state.terminalError.message);
  }

  if (state.abortController.signal.aborted || now >= state.deadlineMs) {
    const timeoutError = createSandboxTimeoutError(limits);
    markSandboxTerminalError(state, timeoutError);
    abortSandboxFacadeCalls(state, timeoutError);
    throw new Error(timeoutError.message);
  }
}

export function markSandboxTerminalError(
  state: SandboxExecutionControlState,
  error: SandboxExecutionError,
): void {
  if (state.terminalError === null) {
    state.terminalError = error;
    abortSandboxFacadeCalls(state, error);
  }
}

export function abortSandboxFacadeCalls(
  state: SandboxExecutionControlState,
  error: SandboxExecutionError,
): void {
  if (!state.abortController.signal.aborted) {
    state.abortController.abort(error);
  }
}

export function attachExternalAbortSignal(
  signal: AbortSignal | undefined,
  state: SandboxExecutionControlState,
): () => void {
  if (signal === undefined) {
    return () => undefined;
  }

  const abort = (): void => {
    markSandboxTerminalError(state, createSandboxAbortError(signal.reason));
  };

  if (signal.aborted) {
    abort();
    return () => undefined;
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
  };
}

export async function trackSandboxFacadeCall<TValue>(
  state: SandboxExecutionControlState,
  call: Promise<TValue>,
): Promise<TValue> {
  const trackedCall = call.then(
    () => undefined,
    () => undefined,
  );
  state.activeFacadeCalls.add(trackedCall);

  try {
    return await Promise.race([call, waitForSandboxAbort(state)]);
  } finally {
    state.activeFacadeCalls.delete(trackedCall);
  }
}

export async function waitForActiveFacadeCalls(
  state: SandboxExecutionControlState,
  cleanupTimeoutMs: number,
): Promise<void> {
  const activeCalls = [...state.activeFacadeCalls];

  if (activeCalls.length === 0) {
    return;
  }

  await Promise.race([
    Promise.allSettled(activeCalls),
    new Promise<void>((resolve) => {
      setTimeout(resolve, cleanupTimeoutMs);
    }),
  ]);
}

export function runSandboxScriptWithTimeout<TValue>(
  execution: Promise<TValue>,
  limits: SandboxExecutionResourceLimits,
  state: SandboxExecutionControlState,
): Promise<TValue> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = createSandboxTimeoutError(limits);
      markSandboxTerminalError(state, timeoutError);
      abortSandboxFacadeCalls(state, timeoutError);
      reject(timeoutError);
    }, limits.timeout_ms);
  });

  return Promise.race([execution, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

function waitForSandboxAbort(state: SandboxExecutionControlState): Promise<never> {
  const signal = state.abortController.signal;
  if (signal.aborted) {
    return Promise.reject(readAbortReason(signal.reason));
  }

  return new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(readAbortReason(signal.reason));
    };
    signal.addEventListener("abort", onAbort);
  });
}
