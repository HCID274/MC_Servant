import type {
  SandboxFacadeCallControl,
  SandboxFacadeExecutionAdapter,
} from "../core-ports/sandbox.js";
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
  SandboxGoalResult,
  SandboxStepActionName,
  SandboxStepParamsByAction,
  SandboxStepResult,
} from "./contracts.js";
import { createFacadeCallError, createToolchainCapabilityFacadeError } from "./errors.js";
import {
  type SandboxExecutionControlState,
  assertSandboxFacadeCallAllowed,
  createSandboxFacadeCallControl,
  markSandboxTerminalError,
  trackSandboxFacadeCall,
} from "./execution-control.js";
import { createSandboxStepResult } from "./result-factory.js";
import { isRecord, isSandboxStepActionName, toJsonlErrorSnapshot } from "./validators.js";

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
  readonly facade: SandboxFacadeExecutionAdapter;
  readonly phaseLogs: SandboxJsonlLine[];
  readonly stepResults: SandboxStepResult[];
  readonly controlState: SandboxExecutionControlState;
  readonly resourceLimits: SandboxExecutionResourceLimits;
  readonly now: () => number;
  readonly setLastFacadeError: (error: FacadeCallError) => void;
}

export interface SandboxHostReadRuntime extends Omit<SandboxHostCallRuntime, "setLastFacadeError"> {
  readonly botId: string;
}

export async function handleSandboxHostCall(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  if (input.method === "system.tryFacadeCall") {
    return handleSandboxTryFacadeCall(input);
  }
  if (input.method === "system.reportGoal") {
    return handleSandboxGoalReport(input);
  }

  const action = toSandboxStepActionName(input.method);
  const params = normalizeSandboxCallParams(action, input.args);
  const startedAt = input.runtime.now();

  assertSandboxFacadeCallAllowed(
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
    const control = createSandboxFacadeCallControl(input.runtime.controlState);
    const result =
      action === "say" || action === "report"
        ? await trackSandboxFacadeCall(
            input.runtime.controlState,
            input.runtime.facade.writeChat(
              action,
              params as SandboxStepParamsByAction["say"],
              control,
            ),
          )
        : await trackSandboxFacadeCall(
            input.runtime.controlState,
            executeSandboxBotFacadeCall(input.runtime.facade, action, params, control),
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
    input.runtime.setLastFacadeError(facadeError);
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
  assertSandboxFacadeCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  const control = createSandboxFacadeCallControl(input.runtime.controlState);
  if (input.method === "memory.search") {
    if (typeof input.runtime.facade.searchMemory !== "function") {
      throw new Error("search is not configured in current sandbox");
    }

    const params = normalizeSandboxSearchParams(input.args);
    return trackSandboxFacadeCall(
      input.runtime.controlState,
      Promise.resolve(
        input.runtime.facade.searchMemory(
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
    await trackSandboxFacadeCall(
      input.runtime.controlState,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    );
    assertSandboxFacadeCallAllowed(
      input.runtime.controlState,
      input.runtime.resourceLimits,
      input.runtime.now(),
    );

    return Object.freeze({ slept_ms: ms });
  }

  if (input.method === "system.captureConditionState") {
    if (typeof input.runtime.facade.captureConditionState !== "function") {
      throw new Error("ensure condition state reader is not configured in current sandbox");
    }

    return trackSandboxFacadeCall(
      input.runtime.controlState,
      Promise.resolve(input.runtime.facade.captureConditionState(control)),
    );
  }

  if (input.method === "system.evaluateCondition") {
    if (typeof input.runtime.facade.evaluateCondition !== "function") {
      throw new Error("ensure condition evaluator is not configured in current sandbox");
    }

    return trackSandboxFacadeCall(
      input.runtime.controlState,
      Promise.resolve(
        input.runtime.facade.evaluateCondition(
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

function toSandboxStepActionName(method: string): SandboxStepActionName {
  const action =
    method.startsWith("bot.") || method.startsWith("chat.")
      ? method.slice(method.indexOf(".") + 1)
      : method;

  if (!isSandboxStepActionName(action)) {
    throw new Error(`Unsupported Facade method: ${method}`);
  }

  return action;
}

function normalizeSandboxCallParams(
  action: SandboxStepActionName,
  args: readonly unknown[],
): SandboxStepResult["params"] {
  const first = args[0];

  if (action === "goTo") {
    if (args.length === 3) {
      return { x: Number(args[0]), y: Number(args[1]), z: Number(args[2]) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["goTo"];
  }

  if (action === "mine") {
    if (typeof first === "string") {
      return { blockName: first, count: Number(args[1] ?? 1) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["mine"];
  }

  if (action === "collect") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(args[1] !== undefined ? { radius: Number(args[1]) } : {}),
      };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["collect"];
  }

  if (action === "equip") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(typeof args[1] === "string" ? { destination: args[1] } : {}),
      } as SandboxStepParamsByAction["equip"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["equip"];
  }

  if (action === "craft") {
    if (typeof first === "string") {
      return {
        itemName: first,
        count: Number(args[1] ?? 1),
      } as SandboxStepParamsByAction["craft"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["craft"];
  }

  if (action === "place") {
    if (typeof first === "string") {
      return {
        blockName: first,
        ...(isRecord(args[1]) ? { near: cloneReadonlyValue(args[1]) } : {}),
      } as SandboxStepParamsByAction["place"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["place"];
  }

  if (action === "placeCraftingTable") {
    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["placeCraftingTable"];
  }

  if (action === "ensure") {
    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["ensure"];
  }

  if (action === "cutTree") {
    if (typeof first === "number") {
      return { count: first } as SandboxStepParamsByAction["cutTree"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["cutTree"];
  }

  if (typeof first !== "string" || first.trim().length === 0) {
    return { message: "" };
  }

  return { message: first };
}

function normalizeSandboxGoalResult(value: unknown): SandboxGoalResult {
  if (!isRecord(value) || value.kind !== "goal_result" || typeof value.ok !== "boolean") {
    throw new Error("report(task) requires a GoalResult returned by runGoal");
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error("GoalResult.name must be non-empty");
  }
  if (typeof value.duration_ms !== "number" || !Number.isFinite(value.duration_ms)) {
    throw new Error("GoalResult.duration_ms must be finite");
  }
  if (value.ok === true) {
    if (!isRecord(value.summary)) {
      throw new Error("GoalResult.summary must be an object");
    }

    return cloneReadonlyValue(value) as SandboxGoalResult;
  }
  if (!isRecord(value.failure)) {
    throw new Error("GoalResult.failure must be an object");
  }
  const failure = value.failure;
  if (
    typeof failure.failure_code !== "string" ||
    failure.failure_code.trim().length === 0 ||
    typeof failure.failure_stage !== "string" ||
    failure.failure_stage.trim().length === 0 ||
    typeof failure.message !== "string" ||
    failure.message.trim().length === 0
  ) {
    throw new Error("GoalResult.failure must include code, stage and message");
  }

  return cloneReadonlyValue(value) as SandboxGoalResult;
}

async function handleSandboxGoalReport(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  void input.method;
  assertSandboxFacadeCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  const goalResult = normalizeSandboxGoalResult(input.args[0]);
  const params: SandboxStepParamsByAction["report"] = Object.freeze({
    message: "",
    goal_result: goalResult,
  });
  const result = Object.freeze({
    reported: true,
    goal_result: goalResult,
  });

  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_call",
      m: "report",
      p: params,
    }),
  );
  input.runtime.stepResults.push(
    createSandboxStepResult({
      step_index: input.runtime.stepResults.length,
      action: "report",
      params,
      status: "ok",
      duration_ms: 0,
      result,
    }),
  );
  input.runtime.phaseLogs.push(
    createSandboxLogLine({
      t: input.runtime.now(),
      phase: "facade_result",
      m: "report",
      s: "ok",
      r: result,
      ms: 0,
    }),
  );

  return result;
}

async function handleSandboxTryFacadeCall(input: {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly runtime: SandboxHostCallRuntime;
}): Promise<SandboxHostCallResult> {
  assertSandboxFacadeCallAllowed(
    input.runtime.controlState,
    input.runtime.resourceLimits,
    input.runtime.now(),
  );

  const method = typeof input.args[0] === "string" ? input.args[0] : "";
  const callArgs = Array.isArray(input.args[1]) ? input.args[1] : [];
  const action = toSandboxStepActionName(method);
  if (action === "say" || action === "report") {
    throw new Error("tryFacadeCall only supports bot actions");
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
    const control = createSandboxFacadeCallControl(input.runtime.controlState);
    const result = await trackSandboxFacadeCall(
      input.runtime.controlState,
      executeSandboxBotFacadeCall(input.runtime.facade, action, params, control),
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

function normalizeSandboxSearchParams(args: readonly unknown[]): {
  readonly query: string;
  readonly limit?: number;
} {
  const first = args[0];
  if (typeof first === "string") {
    const query = first.trim();
    if (query.length === 0) {
      throw new Error("search query must be non-empty");
    }

    return Object.freeze({
      query,
      ...(args[1] === undefined ? {} : { limit: normalizeSandboxSearchLimit(args[1]) }),
    });
  }

  if (isRecord(first) && typeof first.query === "string") {
    const query = first.query.trim();
    if (query.length === 0) {
      throw new Error("search query must be non-empty");
    }

    return Object.freeze({
      query,
      ...(first.limit === undefined ? {} : { limit: normalizeSandboxSearchLimit(first.limit) }),
    });
  }

  throw new Error("search requires a query string");
}

function normalizeSandboxSearchLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10) {
    throw new Error("search limit must be an integer between 1 and 10");
  }

  return limit;
}

function normalizeSandboxSleepMs(value: unknown, maxSleepMs: number): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error("sleep ms must be a non-negative integer");
  }

  return Math.min(ms, maxSleepMs);
}

async function executeSandboxBotFacadeCall(
  facade: SandboxFacadeExecutionAdapter,
  action: Exclude<SandboxStepActionName, "say" | "report">,
  params: SandboxStepResult["params"],
  control: SandboxFacadeCallControl,
): Promise<Readonly<Record<string, unknown>>> {
  if (isToolchainSandboxAction(action)) {
    if (typeof facade.executeToolchainCapability !== "function") {
      throw new Error(`Toolchain capability ${action} is not configured in current sandbox`);
    }

    const result = await facade.executeToolchainCapability(
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

  return facade.executeBotSkill(action, params as SkillParamsByName[typeof action], control);
}

function isToolchainSandboxAction(
  action: Exclude<SandboxStepActionName, "say" | "report">,
): action is ToolchainCapabilityName {
  return (
    action === "craft" ||
    action === "place" ||
    action === "placeCraftingTable" ||
    action === "ensure"
  );
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
