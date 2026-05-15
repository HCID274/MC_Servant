import type { SandboxHostCallControl, SandboxHostExecutionAdapter } from "../core-ports/sandbox.js";
import type {
  EnsureConditionEvaluation,
  EnsureConditionStateSnapshot,
  SkillName,
  SkillParamsByName,
  ToolchainCapabilityName,
  ToolchainCapabilityParamsByName,
} from "../core-ports/skills.js";
import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { createSandboxLogLine } from "../diagnostics/logs.js";
import { cloneReadonlyValue } from "../domain/invariants.js";
import type {
  FacadeCallError,
  SandboxExecutionResourceLimits,
  SandboxStepActionName,
  SandboxStepParamsByAction,
  SandboxStepResult,
} from "./contracts.js";
import { createFacadeCallError, createToolchainCapabilityFacadeError } from "./errors.js";
import {
  type SandboxExecutionControlState,
  assertSandboxHostCallAllowed,
  createSandboxHostCallControl,
  markSandboxTerminalError,
  trackSandboxHostCall,
} from "./execution-control.js";
import {
  normalizeSandboxCallParams,
  normalizeSandboxSearchParams,
  normalizeSandboxSleepMs,
  toSandboxStepActionName,
} from "./host-call-params.js";
import { recordSandboxGoalReport } from "./host-call-report.js";
import { createSandboxStepResult } from "./result-factory.js";
import { toJsonlErrorSnapshot } from "./validators.js";

type SandboxHostCallResult = Readonly<Record<string, unknown>>;

type SandboxReadonlyHostCallResult =
  | Readonly<Record<string, unknown>>
  | EnsureConditionStateSnapshot
  | EnsureConditionEvaluation
  | readonly Readonly<Record<string, unknown>>[]
  | string
  | number
  | boolean
  | null;

export interface SandboxHostCallRuntime {
  readonly hostBridge: SandboxHostExecutionAdapter;
  readonly phaseLogs: SandboxJsonlLine[];
  readonly stepResults: SandboxStepResult[];
  readonly controlState: SandboxExecutionControlState;
  readonly resourceLimits: SandboxExecutionResourceLimits;
  readonly now: () => number;
  readonly setLastHostCallError: (error: FacadeCallError) => void;
}

export interface SandboxHostReadRuntime
  extends Omit<SandboxHostCallRuntime, "setLastHostCallError"> {
  readonly botId: string;
}

export async function handleSandboxHostCall(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  if (input.method === "system.tryHostCall") {
    return handleSandboxTryHostCall(input);
  }
  if (input.method === "system.reportGoal") {
    return handleSandboxGoalReport(input);
  }

  const action = toSandboxStepActionName(input.method);
  const params = normalizeSandboxCallParams(action, input.args);
  const startedAt = input.runtime.now();

  assertSandboxHostCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_call",
      m: action,
      p: params,
    }),
  );

  try {
    const control = createSandboxHostCallControl(input.runtime.controlState);
    const result =
      action === "say" || action === "report"
        ? await trackSandboxHostCall(
            input.runtime.controlState,
            input.runtime.hostBridge.writeChat(
              action,
              params as SandboxStepParamsByAction["say"],
              control,
            ),
          )
        : await trackSandboxHostCall(
            input.runtime.controlState,
            executeSandboxBotHostCall(input.runtime.hostBridge, action, params, control),
          );

    if (input.runtime.controlState.terminalError !== null) {
      throw input.runtime.controlState.terminalError;
    }

    const durationMs = Math.max(0, input.runtime.now() - startedAt);
    const step = createSandboxStepResult({
      step_index: input.runtime.stepResults.length,
      action,
      params,
      status: "ok",
      duration_ms: durationMs,
      result,
    });
    input.runtime.stepResults.push(step);
    input.runtime.phaseLogs.push(
      createSandboxLogLine({
        t: input.runtime.now(),
        phase: "facade_result",
        m: action,
        s: "ok",
        r: result,
        ms: durationMs,
      }),
    );

    return result;
  } catch (error) {
    if (
      input.runtime.controlState.terminalError !== null &&
      input.runtime.controlState.terminalError.name !== "FacadeCallError"
    ) {
      const terminalError = input.runtime.controlState.terminalError;
      const durationMs = Math.max(0, input.runtime.now() - startedAt);
      input.runtime.stepResults.push(
        createSandboxStepResult({
          step_index: input.runtime.stepResults.length,
          action,
          params,
          status: "err",
          duration_ms: durationMs,
          error: terminalError,
        }),
      );
      input.runtime.phaseLogs.push(
        createSandboxLogLine({
          t: input.runtime.now(),
          phase: "facade_result",
          m: action,
          s: "err",
          err: toJsonlErrorSnapshot(terminalError),
          ms: durationMs,
        }),
      );

      throw new Error(terminalError.message);
    }

    const facadeError = createFacadeCallError(action, params, error);
    input.runtime.setLastHostCallError(facadeError);
    markSandboxTerminalError(input.runtime.controlState, facadeError);
    const durationMs = Math.max(0, input.runtime.now() - startedAt);
    input.runtime.stepResults.push(
      createSandboxStepResult({
        step_index: input.runtime.stepResults.length,
        action,
        params: params as SandboxStepParamsByAction[typeof action],
        status: "err",
        duration_ms: durationMs,
        error: facadeError,
      }),
    );
    input.runtime.phaseLogs.push(
      createSandboxLogLine({
        t: input.runtime.now(),
        phase: "facade_result",
        m: action,
        s: "err",
        err: toJsonlErrorSnapshot(facadeError),
        ms: durationMs,
      }),
    );

    throw new Error(facadeError.message);
  }
}

export async function handleSandboxHostRead(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostReadRuntime;
}): Promise<SandboxReadonlyHostCallResult> {
  assertSandboxHostCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  const control = createSandboxHostCallControl(input.runtime.controlState);
  if (input.method === "memory.search") {
    if (typeof input.runtime.hostBridge.searchMemory !== "function") {
      throw new Error("search is not configured in current sandbox");
    }

    const params = normalizeSandboxSearchParams(input.args);
    return trackSandboxHostCall(
      input.runtime.controlState,
      Promise.resolve(
        input.runtime.hostBridge.searchMemory(
          {
            bot_id: input.runtime.botId,
            query: params.query,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
          },
          control,
        ),
      ),
    );
  }

  if (input.method === "system.sleep") {
    const ms = normalizeSandboxSleepMs(input.args[0], input.runtime.resourceLimits.max_sleep_ms);
    await trackSandboxHostCall(
      input.runtime.controlState,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    );
    assertSandboxHostCallAllowed(
      input.runtime.controlState,
      input.runtime.resourceLimits,
      input.runtime.now(),
    );

    return Object.freeze({ slept_ms: ms });
  }

  if (input.method === "system.captureConditionState") {
    if (typeof input.runtime.hostBridge.captureConditionState !== "function") {
      throw new Error("ensure condition state reader is not configured in current sandbox");
    }

    return trackSandboxHostCall(
      input.runtime.controlState,
      Promise.resolve(input.runtime.hostBridge.captureConditionState(control)),
    );
  }

  if (input.method === "system.evaluateCondition") {
    if (typeof input.runtime.hostBridge.evaluateCondition !== "function") {
      throw new Error("ensure condition evaluator is not configured in current sandbox");
    }

    return trackSandboxHostCall(
      input.runtime.controlState,
      Promise.resolve(
        input.runtime.hostBridge.evaluateCondition(
          {
            condition: cloneReadonlyValue(input.args[0] ?? {}) as never,
            baseline: cloneReadonlyValue(input.args[1] ?? {}) as never,
            current: cloneReadonlyValue(input.args[2] ?? {}) as never,
          },
          control,
        ),
      ),
    ) as Promise<SandboxReadonlyHostCallResult>;
  }

  throw new Error(`Unsupported readonly Facade method: ${input.method}`);
}

async function handleSandboxGoalReport(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  void input.method;
  assertSandboxHostCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  return recordSandboxGoalReport({
    args: input.args,
    runtime: input.runtime,
  });
}

async function handleSandboxTryHostCall(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  assertSandboxHostCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  const method = typeof input.args[0] === "string" ? input.args[0] : "";
  const callArgs = Array.isArray(input.args[1]) ? input.args[1] : [];
  const action = toSandboxStepActionName(method);
  if (action === "say" || action === "report") {
    throw new Error("tryHostCall only supports bot actions");
  }

  const params = normalizeSandboxCallParams(action, callArgs);
  const startedAt = input.runtime.now();
  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_call",
      m: action,
      p: params,
    }),
  );

  try {
    const control = createSandboxHostCallControl(input.runtime.controlState);
    const result = await trackSandboxHostCall(
      input.runtime.controlState,
      executeSandboxBotHostCall(input.runtime.hostBridge, action, params, control),
    );
    if (input.runtime.controlState.terminalError !== null) {
      throw input.runtime.controlState.terminalError;
    }

    const durationMs = Math.max(0, input.runtime.now() - startedAt);
    input.runtime.stepResults.push(
      createSandboxStepResult({
        step_index: input.runtime.stepResults.length,
        action,
        params: params as SandboxStepParamsByAction[typeof action],
        status: "ok",
        duration_ms: durationMs,
        result,
      }),
    );
    input.runtime.phaseLogs.push(
      createSandboxLogLine({
        t: input.runtime.now(),
        phase: "facade_result",
        m: action,
        s: "ok",
        r: result,
        ms: durationMs,
      }),
    );

    return Object.freeze({ ok: true, result });
  } catch (error) {
    if (
      input.runtime.controlState.terminalError !== null &&
      input.runtime.controlState.terminalError.name !== "FacadeCallError"
    ) {
      throw new Error(input.runtime.controlState.terminalError.message);
    }

    const facadeError = createFacadeCallError(action, params, error, {
      ensure_recoverable: true,
    });
    const durationMs = Math.max(0, input.runtime.now() - startedAt);
    input.runtime.stepResults.push(
      createSandboxStepResult({
        step_index: input.runtime.stepResults.length,
        action,
        params: params as SandboxStepParamsByAction[typeof action],
        status: "err",
        duration_ms: durationMs,
        error: facadeError,
      }),
    );
    input.runtime.phaseLogs.push(
      createSandboxLogLine({
        t: input.runtime.now(),
        phase: "facade_result",
        m: action,
        s: "err",
        err: toJsonlErrorSnapshot(facadeError),
        ms: durationMs,
      }),
    );

    return Object.freeze({
      ok: false,
      error: Object.freeze({
        action,
        params,
        code: facadeError.error_code,
        message: facadeError.message,
        ...(facadeError.details === undefined ? {} : { details: facadeError.details }),
      }),
    });
  }
}

async function executeSandboxBotHostCall(
  hostBridge: SandboxHostExecutionAdapter,
  action: Exclude<SandboxStepActionName, "say" | "report">,
  params: SandboxStepResult["params"],
  control: SandboxHostCallControl,
): Promise<Readonly<Record<string, unknown>>> {
  if (isToolchainSandboxAction(action)) {
    if (typeof hostBridge.executeToolchainCapability !== "function") {
      throw new Error(`Toolchain capability ${action} is not configured in current sandbox`);
    }

    const result = await hostBridge.executeToolchainCapability(
      action,
      params as ToolchainCapabilityParamsByName[typeof action],
      control,
    );

    if (isToolchainCapabilityFailure(result)) {
      throw createToolchainCapabilityFacadeError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    }

    return result;
  }

  return hostBridge.executeBotSkill(action, params as SkillParamsByName[typeof action], control);
}

function isToolchainSandboxAction(
  action: Exclude<SandboxStepActionName, "say" | "report">,
): action is ToolchainCapabilityName {
  return action === "craft" || action === "place" || action === "ensure";
}

function isToolchainCapabilityFailure(value: unknown): value is {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly ok?: unknown;
    readonly error?: { readonly code?: unknown; readonly message?: unknown };
  };
  return (
    candidate.ok === false &&
    typeof candidate.error?.code === "string" &&
    typeof candidate.error.message === "string"
  );
}
