/**
 * 沙箱执行编排入口。
 *
 * 本文件只负责把预检、转译、isolated-vm 执行、Host Call 分发与终态结果串起来。
 * 资源限制、API 注入、Host Call、错误归一和结果工厂分别由同目录内部组件负责。
 */

import { transform } from "esbuild";
import ivm from "isolated-vm";

import type {
  SandboxFacadeCallControl,
  SandboxFacadeExecutionAdapter,
} from "../core-ports/sandbox.js";
import type { SandboxJsonlLine } from "../diagnostics/contracts.js";
import { createSandboxLogLine } from "../diagnostics/logs.js";
import { type SandboxExecutionTaskContext, createSandboxBootstrapScript } from "./bootstrap.js";
import type {
  AbortError,
  FacadeCallError,
  SandboxExecutionError,
  SandboxExecutionFailure,
  SandboxExecutionInterrupted,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxExecutionSuccess,
  SandboxStepResult,
} from "./contracts.js";
import { createRuntimeSandboxError, createTranspileError } from "./errors.js";
import {
  attachExternalAbortSignal,
  createSandboxExecutionControlState,
  markSandboxTerminalError,
  runSandboxScriptWithTimeout,
  waitForActiveFacadeCalls,
} from "./execution-control.js";
import { handleSandboxHostCall, handleSandboxHostRead } from "./host-call.js";
import { checkSandboxSourceStaticPolicy } from "./resource-limits.js";
import {
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionSuccess,
} from "./result-factory.js";
import { isSandboxExecutionError, toJsonlErrorSnapshot } from "./validators.js";

export type { SandboxFacadeCallControl, SandboxFacadeExecutionAdapter };
export type { SandboxExecutionTaskContext } from "./bootstrap.js";
export { createSandboxError } from "./validators.js";
export {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  checkSandboxSourceStaticPolicy,
  createSandboxResourceLimits,
} from "./resource-limits.js";
export {
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxStepResult,
} from "./result-factory.js";

/**
 * 在 isolated-vm 内执行 Plan 产出的 TS code。
 *
 * 对外仍是单一 code 执行入口；不接受旧 SkillCall / sandbox_code 双任务语义。
 */
export async function executeSandboxCodeRequest(input: {
  request: SandboxExecutionRequest;
  facade: SandboxFacadeExecutionAdapter;
  task?: Partial<SandboxExecutionTaskContext>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<SandboxExecutionResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const phaseLogs: SandboxJsonlLine[] = [];
  const stepResults: SandboxStepResult[] = [];
  let lastFacadeError: FacadeCallError | null = null;
  const controlState = createSandboxExecutionControlState({
    startedAt,
    resourceLimits: input.request.resource_limits,
  });

  const pushPhaseLog = <TLine extends SandboxJsonlLine>(line: TLine): void => {
    phaseLogs.push(createSandboxLogLine(line));
  };

  const finishFailure = (error: SandboxExecutionError): SandboxExecutionFailure =>
    createSandboxExecutionFailure({
      job_id: input.request.job_id,
      bot_id: input.request.bot_id,
      intent_epoch: input.request.intent_epoch,
      log_ref: input.request.log_ref,
      ...(input.request.code_ref !== undefined ? { code_ref: input.request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: stepResults.length,
        duration_ms: Math.max(0, now() - startedAt),
      },
      error,
    });

  const finishInterrupted = (error: AbortError): SandboxExecutionInterrupted =>
    createSandboxExecutionInterrupted({
      job_id: input.request.job_id,
      bot_id: input.request.bot_id,
      intent_epoch: input.request.intent_epoch,
      log_ref: input.request.log_ref,
      ...(input.request.code_ref !== undefined ? { code_ref: input.request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: stepResults.length,
        duration_ms: Math.max(0, now() - startedAt),
      },
      error,
    });

  const removeExternalAbortListener = attachExternalAbortSignal(input.signal, controlState);

  const staticCheckError = checkSandboxSourceStaticPolicy(input.request.code);
  pushPhaseLog({
    t: now(),
    phase: "precheck",
    ok: staticCheckError === null,
    ...(staticCheckError !== null ? { violation: staticCheckError.violation } : {}),
  });
  if (staticCheckError !== null) {
    return finishFailure(staticCheckError);
  }

  const transpileStartedAt = now();
  const transpiled = await transpileSandboxCode(input.request.code).catch((error: unknown) => {
    const transpileError = createTranspileError(error);
    pushPhaseLog({
      t: now(),
      phase: "transpile",
      ok: false,
      ms: Math.max(0, now() - transpileStartedAt),
      err: toJsonlErrorSnapshot(transpileError),
    });

    return transpileError;
  });

  if (isSandboxExecutionError(transpiled)) {
    return finishFailure(transpiled);
  }

  pushPhaseLog({
    t: now(),
    phase: "transpile",
    ok: true,
    ms: Math.max(0, now() - transpileStartedAt),
  });

  let isolate: ivm.Isolate | undefined;

  try {
    isolate = new ivm.Isolate({
      memoryLimit: input.request.resource_limits.memory_limit_mb,
    });
    pushPhaseLog({
      t: now(),
      phase: "isolate_create",
      mem_mb: input.request.resource_limits.memory_limit_mb,
    });

    const context = await isolate.createContext();
    await context.global.set(
      "__sandboxHostCall",
      new ivm.Reference(async (method: string, args: readonly unknown[]) =>
        handleSandboxHostCall({
          method,
          args,
          runtime: {
            facade: input.facade,
            phaseLogs,
            stepResults,
            controlState,
            resourceLimits: input.request.resource_limits,
            setLastFacadeError: (error) => {
              lastFacadeError = error;
            },
            now,
          },
        }),
      ),
    );
    await context.global.set(
      "__sandboxHostRead",
      new ivm.Reference(async (method: string, args: readonly unknown[]) =>
        handleSandboxHostRead({
          method,
          args,
          runtime: {
            botId: input.request.bot_id,
            facade: input.facade,
            phaseLogs,
            stepResults,
            controlState,
            resourceLimits: input.request.resource_limits,
            now,
          },
        }),
      ),
    );

    const taskContext = {
      id: input.task?.id ?? input.request.job_id,
      userMessage: input.task?.userMessage ?? "",
      intent: input.task?.intent ?? "code",
      ...(input.task?.owner === undefined ? {} : { owner: input.task.owner }),
    };

    await context.eval(createSandboxBootstrapScript(taskContext), {
      timeout: input.request.resource_limits.script_timeout_ms,
    });

    const script = await isolate.compileScript(transpiled);
    await runSandboxScriptWithTimeout(
      script.run(context, {
        promise: true,
        copy: true,
        timeout: input.request.resource_limits.script_timeout_ms,
      }),
      input.request.resource_limits,
      controlState,
    );

    const terminalFacadeError = lastFacadeError ?? findFacadeStepError(stepResults);
    if (terminalFacadeError !== null) {
      markSandboxTerminalError(controlState, terminalFacadeError);
      pushPhaseLog({
        t: now(),
        phase: "sandbox_done",
        steps: stepResults.length,
        ms: Math.max(0, now() - startedAt),
      });

      return finishFailure(terminalFacadeError);
    }

    pushPhaseLog({
      t: now(),
      phase: "sandbox_complete",
      steps: stepResults.length,
      ms: Math.max(0, now() - startedAt),
    });

    return createSandboxExecutionSuccess({
      job_id: input.request.job_id,
      bot_id: input.request.bot_id,
      intent_epoch: input.request.intent_epoch,
      log_ref: input.request.log_ref,
      ...(input.request.code_ref !== undefined ? { code_ref: input.request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: stepResults.length,
        duration_ms: Math.max(0, now() - startedAt),
      },
    });
  } catch (error) {
    const sandboxError =
      lastFacadeError ??
      controlState.terminalError ??
      (isSandboxExecutionError(error)
        ? error
        : createRuntimeSandboxError(error, input.request.resource_limits));
    markSandboxTerminalError(controlState, sandboxError);
    await waitForActiveFacadeCalls(
      controlState,
      input.request.resource_limits.abort_cleanup_timeout_ms,
    );
    pushPhaseLog({
      t: now(),
      phase: "sandbox_done",
      steps: stepResults.length,
      ms: Math.max(0, now() - startedAt),
    });

    if (sandboxError.name === "AbortError") {
      return finishInterrupted(sandboxError);
    }

    return finishFailure(sandboxError);
  } finally {
    removeExternalAbortListener();
    isolate?.dispose();
  }
}

export const executeCodeRequest = executeSandboxCodeRequest;

async function transpileSandboxCode(code: string): Promise<string> {
  const wrappedCode = `(async () => {\n${code}\n})()`;
  const output = await transform(wrappedCode, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcemap: false,
  });

  return output.code;
}

function findFacadeStepError(stepResults: readonly SandboxStepResult[]): FacadeCallError | null {
  for (const stepResult of stepResults) {
    if (
      stepResult.status === "err" &&
      stepResult.error?.name === "FacadeCallError" &&
      stepResult.error.details?.ensure_recoverable !== true
    ) {
      return stepResult.error;
    }
  }

  return null;
}
