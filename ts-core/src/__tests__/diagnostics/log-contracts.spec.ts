import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createAsyncDiagnosticSink,
  createCodeJob,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxExperienceDraft,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  describe,
  expect,
  it,
} from "../sandbox/diagnostics-and-execution.fixture.js";

describe("diagnostics log contracts 行为", () => {
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
      "metrics",
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
        code: "await reply('hello')",
        log_ref: taskLogRef,
      }),
    ).toThrow(/sandbox/);
  });

  it("应把每次 conversation reply（对话回复） 与上下文写入本地 JSONL（结构化日志）", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "ts-core-conversation-log-"));
    const logSink = createLocalConversationReplyLogSink({
      baseDir,
      sensitiveValues: ["sk-local-dev"],
    });

    try {
      await logSink({
        bot_id: "bot-log",
        message_id: "msg/log:1",
        created_at: "2026-05-03T01:46:56.000Z",
        owner_message: "你在哪",
        route_kind: "chat_reply",
        reply_mode: "llm",
        reply: "我在这里喵~",
        contexts: {
          state_context: "当前状态：idle",
          memory_context: "api_key=sk-local-dev",
        },
        llm_diagnostics: {
          lines: [
            {
              role: "system",
              content: "[Bot] 位置:(0,64,0)\n[世界] minecraft:overworld",
            },
          ],
        },
      });

      const content = await readFile(
        join(baseDir, "conversation", "2026-05-03", "msg_log_1.jsonl"),
        "utf8",
      );
      const line = JSON.parse(content.trim()) as {
        reply?: string;
        contexts?: { memory_context?: string };
        llm_diagnostics?: { lines?: Array<{ content?: string }> };
      };

      expect(line.reply).toBe("我在这里喵~");
      expect(line.contexts?.memory_context).toBe(`api_key=${"<redacted>"}`);
      expect(line.llm_diagnostics?.lines?.[0]?.content).toContain("[世界] minecraft:overworld");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
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

    const llmSummary = createLlmDiagnosticSummary({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
      metrics: {
        queue_wait_ms: 4,
        prompt_build_ms: 2,
        request_total_ms: 80,
        response_parse_ms: 1,
        tool_round_count: 0,
        tool_round_ms: [],
        diagnostics_write_ms: 3,
        input_tokens: 30,
        output_tokens: 10,
        tokens_per_second: 125,
        ttft_ms: null,
        ttft_unavailable: "non_streaming",
      },
    });

    expect(llmSummary).toEqual({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
      metrics: {
        queue_wait_ms: 4,
        prompt_build_ms: 2,
        request_total_ms: 80,
        response_parse_ms: 1,
        tool_round_count: 0,
        tool_round_ms: [],
        diagnostics_write_ms: 3,
        input_tokens: 30,
        output_tokens: 10,
        tokens_per_second: 125,
        ttft_ms: null,
        ttft_unavailable: "non_streaming",
      },
    });
    expect(Object.isFrozen(llmSummary)).toBe(true);

    const redactedLlmSummary = createLlmDiagnosticSummary(
      {
        stage: "chat",
        message_id: "msg-002",
        status: "error",
        model: "bl-auto",
        log_ref: "llm/2026-04-13/chat-msg-002.jsonl",
        created_at: "2026-04-13T12:00:01.000Z",
        error_summary:
          "LLM_API_KEY=sk-local-dev failed postgres://user:pg-pass@localhost/db redis://:redis-pass@localhost EasyAuth密码=hunter2",
      },
      { sensitiveValues: ["hunter2"] },
    );

    expect(redactedLlmSummary.error_summary).toContain("<redacted>");
    expect(redactedLlmSummary.error_summary).not.toContain("sk-local-dev");
    expect(redactedLlmSummary.error_summary).not.toContain("pg-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("redis-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("hunter2");
  });

  it("应让 tasks（任务执行） 摘要与运行时 started / terminal（已开始 / 终态） 生命周期对齐", () => {
    const job = createCodeJob({
      message_id: "T-008",
      intent_epoch: 6,
      snapshot_ts: 1_712_940_000,
      priority: ExecPriority.Normal,
      code: "await reply('ok')",
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
      code: "await goTo({ x: 1, y: 64, z: 2 });",
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

    expect(request.type).toBe(ExecutionTaskKind.Code);
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

  it("应创建已脱敏、限长且只读的 sandbox experience（沙箱经验）草案", () => {
    const draft = createSandboxExperienceDraft({
      bot_id: "bot-035",
      message_id: "msg-sandbox-exp",
      intent_epoch: 7,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 3456,
      log_ref: "sandbox/2026-04-26/msg-sandbox-exp.jsonl",
      code_ref: "sandbox/2026-04-26/msg-sandbox-exp.code.ts",
      code: String.raw`await reply('LLM_API_KEY=sk-local-dev password=hunter2 file=/home/hcid274/code/MC_WSL_servant/.env win=C:\Users\hcid274\.ts-core\.env')`,
      error: {
        name: "FacadeCallError",
        message: String.raw`failed with sk-local-dev postgres://user:pg-pass@localhost/db EasyAuth密码=hunter2 at /Users/dev/MC_WSL_servant/.env and C:\Users\dev\AppData\Local\ts-core\.env`,
        error_code: "path_not_found",
        recoverable: false,
      },
      sensitiveValues: ["hunter2"],
    });

    expect(draft.status).toBe(TaskHistoryStatus.Failed);
    expect(draft.code_hash).toMatch(/^sha256:/);
    expect(draft.code_preview?.length ?? 0).toBeLessThanOrEqual(240);
    expect(draft.summary.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(draft)).not.toContain("sk-local-dev");
    expect(JSON.stringify(draft)).not.toContain("pg-pass");
    expect(JSON.stringify(draft)).not.toContain("hunter2");
    expect(JSON.stringify(draft)).not.toContain("/home/hcid274/code/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain("/Users/dev/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain(String.raw`C:\Users\hcid274\.ts-core\.env`);
    expect(JSON.stringify(draft)).not.toContain(
      String.raw`C:\Users\dev\AppData\Local\ts-core\.env`,
    );
    expect(JSON.stringify(draft)).toContain("<redacted-path>");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.error ?? {})).toBe(true);

    expect(() =>
      createSandboxExperienceDraft({
        bot_id: "bot-035",
        message_id: "msg-sandbox-exp-bad",
        intent_epoch: 7,
        status: TaskHistoryStatus.Failed,
        total_steps: 0,
        duration_ms: 1,
      }),
    ).toThrow(/requires error/);
  });
});
