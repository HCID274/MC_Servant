import { describe, expect, it } from "vitest";

import {
  type AbortError,
  ExecPriority,
  ExecutionTaskKind,
  PHASE1_SKILL_NAMES,
  SANDBOX_BOT_SKILL_BINDINGS,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_READONLY_SECTIONS,
  type SANDBOX_STEP_ACTION_NAMES,
  type SandboxExecutionRequest,
  type SandboxStepParamsByAction,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createDiagnosticsCatalog,
  createLlmLogLine,
  createLlmLogRef,
  createSandboxCodeJob,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxFacadeContract,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
} from "../index.js";

const validBindings: typeof SANDBOX_BOT_SKILL_BINDINGS = SANDBOX_BOT_SKILL_BINDINGS;
void validBindings;

// @ts-expect-error `dig`（挖掘） 不是 Phase 1（第一阶段） 可记录动作。
const invalidStepAction: (typeof SANDBOX_STEP_ACTION_NAMES)[number] = "dig";
void invalidStepAction;

// @ts-expect-error `goTo`（移动） 的参数必须是坐标结构。
const invalidGoToParams: SandboxStepParamsByAction["goTo"] = { blockName: "oak_log", count: 1 };
void invalidGoToParams;

// @ts-expect-error `goTo`（移动） 不能映射到 `mine`（挖掘） 技能。
const invalidGoToBinding: typeof SANDBOX_BOT_SKILL_BINDINGS.goTo = "mine";
void invalidGoToBinding;

// @ts-expect-error `SandboxExecutionRequest.type` 固定为 `sandbox_code`（沙箱代码）。
const invalidSandboxRequestType: SandboxExecutionRequest["type"] = ExecutionTaskKind.SkillCall;
void invalidSandboxRequestType;

// @ts-expect-error `AbortError`（中断错误） 固定不可恢复。
const invalidAbortRecoverable: AbortError["recoverable"] = true;
void invalidAbortRecoverable;

describe("sandbox（沙箱） 与 diagnostics（诊断） 契约", () => {
  it("应让 Facade API（门面接口） 写动作与 Phase 1（第一阶段） 技能目录精确对齐", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(Object.keys(facadeContract)).toEqual([...SANDBOX_FACADE_SECTIONS]);
    expect(Object.keys(facadeContract.bot)).toEqual([...PHASE1_SKILL_NAMES]);
    expect(SANDBOX_BOT_SKILL_BINDINGS.goTo).toBe("goTo");
    expect(facadeContract.bot.mine.aligned_skill).toBe("mine");
    expect(facadeContract.chat.report.emits_step).toBe(true);
    expect(SANDBOX_READONLY_SECTIONS).toEqual(["world", "knowledge", "memory", "owner", "task"]);
  });

  it("应集中表达 diagnostics（诊断） 通道目录、保留期与引用规则", () => {
    const diagnosticsCatalog = createDiagnosticsCatalog();
    const taskLogRef = createTaskLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxLogRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxCodeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const llmLogRef = createLlmLogRef({
      date: "2026-04-13",
      stage: "triage",
      message_id: "msg-001",
    });

    expect(diagnosticsCatalog.channels.map((channel) => channel.channel)).toEqual([
      "tasks",
      "sandbox",
      "llm",
    ]);
    expect(taskLogRef).toBe("tasks/2026-04-13/T-007.jsonl");
    expect(sandboxLogRef).toBe("sandbox/2026-04-13/T-007.jsonl");
    expect(sandboxCodeRef).toBe("sandbox/2026-04-13/T-007.code.ts");
    expect(llmLogRef).toBe("llm/2026-04-13/triage-msg-001.jsonl");

    expect(() =>
      createSandboxExecutionRequest({
        job_id: "T-007",
        bot_id: "bot-007",
        intent_epoch: 2,
        snapshot_ts: 1,
        code: "await api.chat.say('hello')",
        log_ref: taskLogRef,
      }),
    ).toThrow(/sandbox/);
  });

  it("应创建只读的 tasks（任务执行） / sandbox（沙箱执行） / llm（大语言模型） 日志行", () => {
    const taskStep = createTaskLogLine({
      t: 1_712_930_001,
      e: "step",
      i: 0,
      act: "goTo",
      p: { x: 1, y: 64, z: 2 },
      s: "ok",
      ms: 5200,
    });
    const sandboxLine = createSandboxLogLine({
      t: 1_712_930_001,
      phase: "facade_result",
      m: "goTo",
      s: "ok",
      r: { arrived: true },
      ms: 5200,
    });
    const llmLine = createLlmLogLine({
      t: 1_712_930_001,
      meta: {
        input_tokens: 120,
        output_tokens: 35,
        ms: 800,
        ok: true,
      },
    });

    expect(Object.isFrozen(taskStep)).toBe(true);
    expect(Object.isFrozen(taskStep.p ?? {})).toBe(true);
    expect(Object.isFrozen(sandboxLine.r ?? {})).toBe(true);
    expect(Object.isFrozen(llmLine.meta)).toBe(true);
  });

  it("应让 tasks（任务执行） 摘要与运行时 started / terminal（已开始 / 终态） 生命周期对齐", () => {
    const job = createSandboxCodeJob({
      message_id: "T-008",
      intent_epoch: 6,
      snapshot_ts: 1_712_940_000,
      priority: ExecPriority.Normal,
      code: "await api.chat.say('ok')",
    });
    const startedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_001,
      lifecycle: createTaskStartedLifecycleEvent(job),
    });
    const failedLifecycle = createTaskTerminalLifecycleEvent({
      job,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 9800,
      error: {
        name: "StaticCheckError",
        message: "Forbidden import detected",
      },
      last_step: "goTo",
    });
    if (failedLifecycle.status !== TaskHistoryStatus.Failed) {
      throw new Error("expected failed terminal lifecycle");
    }
    const failedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_099,
      lifecycle: failedLifecycle as TaskLifecycleEvent<TaskHistoryStatus.Failed>,
    });

    expect(startedSummary.status).toBe(TaskHistoryStatus.Started);
    expect(startedSummary.e).toBe("task.started");
    expect(failedSummary.status).toBe(TaskHistoryStatus.Failed);
    expect(failedSummary.e).toBe("task.failed");
    expect(failedSummary.err.message).toBe("Forbidden import detected");
    expect(Object.isFrozen(failedSummary.err)).toBe(true);
  });

  it("应创建携带阶段日志与终态摘要的 sandbox（沙箱执行） 请求和结果", () => {
    const resourceLimits = createSandboxResourceLimits();
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const codeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const request = createSandboxExecutionRequest({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      snapshot_ts: 1712930000,
      code: "await api.bot.goTo({ x: 1, y: 64, z: 2 });",
      log_ref: logRef,
      code_ref: codeRef,
      resource_limits: resourceLimits,
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: true,
      }),
      createSandboxLogLine({
        t: 1_712_930_022,
        phase: "sandbox_complete",
        steps: 1,
        ms: 22000,
      }),
    ] as const;
    const stepResults = [
      createSandboxStepResult({
        step_index: 0,
        action: "goTo",
        params: { x: 1, y: 64, z: 2 },
        status: "ok",
        duration_ms: 5200,
        result: { x: 1, y: 64, z: 2 },
      }),
    ] as const;
    const success = createSandboxExecutionSuccess({
      job_id: request.job_id,
      bot_id: request.bot_id,
      intent_epoch: request.intent_epoch,
      log_ref: request.log_ref,
      ...(request.code_ref !== undefined ? { code_ref: request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: 1,
        duration_ms: 22000,
      },
    });

    expect(request.type).toBe(ExecutionTaskKind.SandboxCode);
    expect(success.status).toBe(TaskHistoryStatus.Completed);
    expect(success.summary.terminal_status).toBe(TaskHistoryStatus.Completed);
    expect(Object.isFrozen(success.phase_logs)).toBe(true);
    expect(success.step_results).toHaveLength(1);
    expect(Object.isFrozen(success.step_results[0]?.params ?? {})).toBe(true);
  });

  it("应覆盖文档要求的错误分类并区分失败与中断终态", () => {
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: false,
        violation: "\\bimport\\s",
      }),
    ] as const;
    const staticCheckError = createSandboxError({
      name: "StaticCheckError",
      message: "Forbidden import detected",
      recoverable: false,
      violation: "\\bimport\\s",
    });
    const abortError = createSandboxError({
      name: "AbortError",
      message: "Sandbox aborted",
      recoverable: false,
      reason: "owner_interrupt",
    });
    const failure = createSandboxExecutionFailure({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: staticCheckError,
    });
    const interrupted = createSandboxExecutionInterrupted({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: abortError,
    });

    expect(failure.status).toBe(TaskHistoryStatus.Failed);
    expect(failure.error.name).toBe("StaticCheckError");
    expect(interrupted.status).toBe(TaskHistoryStatus.Interrupted);
    expect(interrupted.error.name).toBe("AbortError");
    expect(interrupted.error.recoverable).toBe(false);
  });

  it("应拒绝被类型断言伪装成可恢复的 AbortError（中断错误）", () => {
    expect(() =>
      createSandboxError({
        name: "AbortError",
        message: "Sandbox aborted",
        recoverable: true,
        reason: "owner_interrupt",
      } as unknown as AbortError),
    ).toThrow(/recoverable must be false/);
  });
});
