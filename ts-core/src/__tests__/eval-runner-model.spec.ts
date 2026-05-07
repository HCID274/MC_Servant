import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ConversationLlmEvalClient } from "../conversation/llm/index.js";
import { runConversationLlmEvalCases } from "../conversation/llm/index.js";
import type { ConversationLlmDiagnosticRecord } from "../conversation/llm/index.js";
import { ExecPriority, TaskHistoryStatus, createCodeJob } from "../core-ports/tasking.js";
import type { LlmCallMetrics } from "../diagnostics/contracts.js";
import {
  createEvalCaseJsonlLine,
  createEvalRunJsonlLine,
  createLocalProductionMetricLogSink,
  createProductionExecutionMetricSummaries,
  createProductionLlmMetricSummaries,
  createProductionMetricEventJsonlLine,
  parseEvalCaseJsonlLines,
  serializeEvalJsonlLine,
} from "../diagnostics/index.js";
import {
  createBotWorkerActions,
  createBotWorkerTask,
  createProductionMetricEventFromBotWorkerAction,
  createProductionMetricEventFromLlmDiagnostic,
} from "../workers/index.js";

describe("eval runner（离线评测执行器）契约", () => {
  it("应创建只读、脱敏且可解析的 eval JSONL 行", () => {
    const run = createEvalRunJsonlLine({
      run_id: "eval-test",
      status: "started",
      started_at: "2026-05-07T00:00:00.000Z",
      config: {
        base_url: "http://127.0.0.1:8045/v1",
        model: "bl-auto",
        api_key: "<redacted>",
      },
      case_count: 1,
    });
    const line = serializeEvalJsonlLine(run, ["sk-local-dev"]);

    expect(Object.isFrozen(run)).toBe(true);
    expect(line).not.toContain("sk-local-dev");
    expect(line).toContain('"kind":"run"');
    expect(() =>
      createEvalRunJsonlLine({
        run_id: "eval-bad",
        status: "started",
        started_at: "2026-05-07T00:00:00.000Z",
        config: {
          base_url: "http://127.0.0.1:8045/v1",
          model: "bl-auto",
          api_key: "sk-local-dev" as "<redacted>",
        },
        case_count: 1,
      }),
    ).toThrow(/api_key must be redacted/u);
  });

  it("应按行号解析 eval case JSONL", () => {
    const content = [
      JSON.stringify(
        createEvalCaseJsonlLine({
          case_id: "case_triage_chat",
          stage: "triage",
          input: {
            message_id: "msg-chat",
            message: "聊两句",
          },
          expect: {
            route_kind: "chat_reply",
          },
        }),
      ),
      '{"schema_version":"bad","kind":"case"}',
    ].join("\n");

    expect(() => parseEvalCaseJsonlLines(content)).toThrow(/line 2/u);
  });

  it("应从 attempts 汇总 A1/D1/D2/D3/E2 且不输出 A2", async () => {
    const cases = [
      createEvalCaseJsonlLine({
        case_id: "case_triage_chat",
        stage: "triage",
        input: {
          message_id: "msg-triage-chat",
          message: "今天怎么样",
          bot_summary: "idle",
        },
        expect: {
          route_kind: "chat_reply",
        },
        token_saving_probe: {
          avoided_stage: "plan",
          plan_input: {
            message_id: "msg-triage-chat-plan-probe",
            message: "今天怎么样",
            snapshot_context: "online_runtime: executable skills: goTo, collect, cutTree",
          },
        },
      }),
      createEvalCaseJsonlLine({
        case_id: "case_plan_cut_tree",
        stage: "plan",
        input: {
          message_id: "msg-plan-ok",
          message: "砍 5 个木头",
          snapshot_context: "online_runtime: executable skills: cutTree",
        },
        expect: {
          code_only: true,
        },
      }),
      createEvalCaseJsonlLine({
        case_id: "case_plan_static_fail",
        stage: "plan",
        input: {
          message_id: "msg-plan-static",
          message: "执行危险代码",
          snapshot_context: "online_runtime: executable skills: cutTree",
        },
        expect: {
          code_only: true,
        },
      }),
      createEvalCaseJsonlLine({
        case_id: "case_report_terminal_summary",
        stage: "report",
        input: {
          message_id: "msg-report",
          owner_text: "砍 5 个木头",
          status: "completed",
          deterministic_report: "已完成：砍 5 个木头，获得 oak_log x5。",
          fact_summary: "获得 oak_log x5",
          required_facts: ["oak_log x5"],
          tone: "简短",
        },
      }),
    ];
    const lines = await runConversationLlmEvalCases({
      cases,
      client: createFakeEvalClient(),
      run_id: "eval-run",
      config: {
        base_url: "http://127.0.0.1:8045/v1",
        model: "bl-auto",
        api_key: "<redacted>",
      },
      now: createTickingNow(),
    });
    const metrics = lines.filter((line) => line.kind === "metric");
    const attempts = lines.filter((line) => line.kind === "attempt");

    expect(metrics.map((metric) => metric.metric_id)).toEqual(["A1", "D1", "D2", "D3", "E2"]);
    expect(metrics.some((metric) => metric.metric_id === "A2")).toBe(false);
    expect(metrics.find((metric) => metric.metric_id === "A1")?.value).toBe(1);
    expect(metrics.find((metric) => metric.metric_id === "D1")?.value).toBe(10);
    expect(metrics.find((metric) => metric.metric_id === "D2")?.value).toBe(250);
    expect(metrics.find((metric) => metric.metric_id === "D3")?.value).toBeGreaterThan(0);
    expect(metrics.find((metric) => metric.metric_id === "E2")?.value).toBe(0.5);
    expect(
      attempts.find((attempt) => attempt.case_id === "case_plan_static_fail")
        ?.static_precheck_failure_type,
    ).toBe("eval");
  });

  it("失败路径 diagnostics input_tokens 为 0 时应回退本地估算", async () => {
    const lines = await runConversationLlmEvalCases({
      cases: [
        createEvalCaseJsonlLine({
          case_id: "case_plan_timeout_zero_usage",
          stage: "plan",
          input: {
            message_id: "msg-plan-zero-usage",
            message: "挖 5 个石头",
            snapshot_context: "online_runtime: executable skills: mine",
          },
          expect: {
            code_only: true,
          },
        }),
      ],
      client: createZeroUsageFailureEvalClient(),
      run_id: "eval-zero-usage",
      config: {
        base_url: "http://127.0.0.1:8045/v1",
        model: "bl-auto",
        api_key: "<redacted>",
      },
      now: createTickingNow(),
    });
    const attempt = lines.find((line) => line.kind === "attempt");

    expect(attempt?.kind).toBe("attempt");
    expect(attempt?.case_id).toBe("case_plan_timeout_zero_usage");
    expect(attempt?.input_tokens).toBeGreaterThan(0);
    expect(attempt?.input_tokens).not.toBe(0);
  });

  it("应创建生产指标事件并保持必填字段显式存在", () => {
    const line = createProductionMetricEventJsonlLine({
      event_id: "metric-event-1",
      event_type: "llm.stage",
      message_id: "msg-1",
      task_id: null,
      bot_id: "local-bot",
      root_goal_id: null,
      recovery_chain_id: null,
      created_at: "2026-05-07T00:00:00.000Z",
      source: "conversation_llm",
      prompt_version: null,
      model: "bl-auto",
      stage: "plan",
      ok: true,
      error_code: null,
      duration_ms: 120,
      input_tokens: 30,
      output_tokens: 10,
    });

    expect(Object.isFrozen(line)).toBe(true);
    expect(line.schema_version).toBe("ts-core.metric.v1");
    expect(line.root_goal_id).toBeNull();
    expect(line.plan_parse_ok).toBeNull();
    expect(line.plan_code_only_ok).toBeNull();
    expect(line.terminal_status).toBeNull();
    expect(line.step_count).toBeNull();
    expect(line.is_manual_intervention).toBeNull();
    expect(() =>
      createProductionMetricEventJsonlLine({
        ...line,
        event_type: "bad" as typeof line.event_type,
      }),
    ).toThrow(/event_type/u);
  });

  it("应把 Plan 输出质量诊断映射为生产指标字段并汇总 T-075R 指标", () => {
    const planOk = createProductionMetricEventFromLlmDiagnostic({
      bot_id: "local-bot",
      diagnostic: createDiagnostics({
        stage: "plan",
        messageId: "msg-plan-ok",
        requestMs: 200,
        inputTokens: 100,
        outputTokens: 20,
        planMetric: {
          plan_parse_ok: true,
          plan_code_only_ok: true,
          plan_gate_failure_type: null,
          plan_static_precheck_failure_type: null,
        },
      }),
    });
    const planGateFailed = createProductionMetricEventFromLlmDiagnostic({
      bot_id: "local-bot",
      diagnostic: createDiagnostics({
        stage: "plan",
        messageId: "msg-plan-gate",
        requestMs: 300,
        inputTokens: 120,
        outputTokens: 30,
        planMetric: {
          plan_parse_ok: true,
          plan_code_only_ok: true,
          plan_gate_failure_type: "missing_run_goal",
          plan_static_precheck_failure_type: null,
        },
      }),
    });
    const planStaticFailed = createProductionMetricEventFromLlmDiagnostic({
      bot_id: "local-bot",
      diagnostic: createDiagnostics({
        stage: "plan",
        messageId: "msg-plan-static",
        requestMs: 400,
        inputTokens: 140,
        outputTokens: 40,
        planMetric: {
          plan_parse_ok: true,
          plan_code_only_ok: true,
          plan_gate_failure_type: null,
          plan_static_precheck_failure_type: "forbidden_eval",
        },
      }),
    });
    const chat = createProductionMetricEventFromLlmDiagnostic({
      bot_id: "local-bot",
      diagnostic: createDiagnostics({
        stage: "chat",
        messageId: "msg-chat",
        requestMs: 50,
        inputTokens: 10,
        outputTokens: 5,
      }),
    });

    expect(planGateFailed).toMatchObject({
      event_type: "llm.stage",
      stage: "plan",
      plan_parse_ok: true,
      plan_code_only_ok: true,
      plan_gate_failure_type: "missing_run_goal",
      plan_static_precheck_failure_type: null,
    });

    const summaries = createProductionLlmMetricSummaries([
      planOk,
      planGateFailed,
      planStaticFailed,
      chat,
    ]);

    expect(summaries.map((summary) => summary.name)).toEqual([
      "plan_code_strict_parse_success_rate",
      "plan_code_only_success_rate",
      "plan_gate_failure_rate",
      "plan_static_precheck_failure_rate",
      "triage_average_latency_ms",
      "plan_average_latency_ms",
      "chat_average_latency_ms",
      "report_average_latency_ms",
      "llm_input_tokens_total",
      "llm_output_tokens_total",
    ]);
    expect(summaries.find((summary) => summary.name === "plan_gate_failure_rate")).toMatchObject({
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
    });
    expect(
      summaries.find((summary) => summary.name === "plan_static_precheck_failure_rate"),
    ).toMatchObject({
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
    });
    expect(summaries.find((summary) => summary.name === "plan_average_latency_ms")).toMatchObject({
      value: 300,
      numerator: 900,
      denominator: 3,
    });
    expect(summaries.find((summary) => summary.name === "llm_input_tokens_total")).toMatchObject({
      value: 370,
      numerator: 370,
      denominator: 4,
    });
  });

  it("应将 BotWorker 真实生命周期 action 映射为生产指标事件", () => {
    const task = createBotWorkerTask({
      bot_id: "local-bot",
      owner_text: "执行短任务",
      exec_job: createCodeJob({
        message_id: "msg-exec",
        intent_epoch: 1,
        snapshot_ts: 1_777_766_400_000,
        priority: ExecPriority.Normal,
        code: 'await report("done")',
      }),
    });
    const terminalAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      duration_ms: 2500,
      total_steps: 2,
      error: {
        name: "SandboxError",
        message: "blocked",
        error_code: "static_precheck_failed",
      },
      last_step: "executeCode",
    }).find((action) => action.type === "emit_task_lifecycle");

    expect(terminalAction).toBeDefined();
    if (terminalAction === undefined) {
      throw new Error("terminal action missing");
    }
    const line = createProductionMetricEventFromBotWorkerAction({
      action: terminalAction,
      created_at: "2026-05-07T00:00:00.000Z",
    });

    expect(line).toMatchObject({
      event_type: "task.failed",
      message_id: "msg-exec",
      task_id: "msg-exec",
      bot_id: "local-bot",
      source: "bot_worker",
      stage: "execution",
      ok: false,
      error_code: "static_precheck_failed",
      duration_ms: 2500,
      terminal_status: "failed",
      step_count: 2,
      is_manual_intervention: false,
    });

    const interruptedAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      duration_ms: 3000,
      total_steps: 3,
      interrupt_source: {
        type: "control",
        command: "interrupt",
      },
      reason: "owner interrupted",
    }).find((action) => action.type === "emit_task_lifecycle");

    expect(interruptedAction).toBeDefined();
    if (interruptedAction === undefined) {
      throw new Error("interrupted action missing");
    }
    const interruptedLine = createProductionMetricEventFromBotWorkerAction({
      action: interruptedAction,
      created_at: "2026-05-07T00:00:01.000Z",
    });

    expect(interruptedLine).toMatchObject({
      event_type: "task.interrupted",
      terminal_status: "interrupted",
      step_count: 3,
      is_manual_intervention: true,
      error_code: "task_interrupted",
    });
  });

  it("应汇总 BotWorker 终态生产执行指标", () => {
    const completed = createProductionMetricEventJsonlLine({
      event_id: "exec-completed",
      event_type: "task.completed",
      message_id: "msg-completed",
      task_id: "msg-completed",
      bot_id: "local-bot",
      root_goal_id: null,
      recovery_chain_id: null,
      created_at: "2026-05-07T00:00:00.000Z",
      source: "bot_worker",
      prompt_version: null,
      model: null,
      stage: "execution",
      ok: true,
      error_code: null,
      duration_ms: 120_000,
      input_tokens: null,
      output_tokens: null,
      terminal_status: "completed",
      step_count: 4,
      is_manual_intervention: false,
    });
    const failed = createProductionMetricEventJsonlLine({
      event_id: "exec-failed",
      event_type: "task.failed",
      message_id: "msg-failed",
      task_id: "msg-failed",
      bot_id: "local-bot",
      root_goal_id: null,
      recovery_chain_id: null,
      created_at: "2026-05-07T00:01:00.000Z",
      source: "bot_worker",
      prompt_version: null,
      model: null,
      stage: "execution",
      ok: false,
      error_code: "not_equipped",
      duration_ms: 60_000,
      input_tokens: null,
      output_tokens: null,
      terminal_status: "failed",
      step_count: 2,
      is_manual_intervention: false,
    });
    const interrupted = createProductionMetricEventJsonlLine({
      event_id: "exec-interrupted",
      event_type: "task.interrupted",
      message_id: "msg-interrupted",
      task_id: "msg-interrupted",
      bot_id: "local-bot",
      root_goal_id: null,
      recovery_chain_id: null,
      created_at: "2026-05-07T00:02:00.000Z",
      source: "bot_worker",
      prompt_version: null,
      model: null,
      stage: "execution",
      ok: false,
      error_code: "task_interrupted",
      duration_ms: 180_000,
      input_tokens: null,
      output_tokens: null,
      terminal_status: "interrupted",
      step_count: 3,
      is_manual_intervention: true,
    });

    const summaries = createProductionExecutionMetricSummaries([completed, failed, interrupted]);

    expect(summaries.map((summary) => summary.name)).toEqual([
      "execution_task_run_count",
      "execution_no_manual_completion_rate",
      "execution_average_duration_minutes",
      "execution_average_step_count",
      "execution_failed_count",
      "execution_interrupted_count",
      "execution_failure_code_count_by_code",
    ]);
    expect(summaries.find((summary) => summary.name === "execution_task_run_count")).toMatchObject({
      value: 3,
      numerator: 3,
      denominator: 3,
    });
    expect(
      summaries.find((summary) => summary.name === "execution_no_manual_completion_rate"),
    ).toMatchObject({
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
    });
    expect(
      summaries.find((summary) => summary.name === "execution_average_duration_minutes"),
    ).toMatchObject({
      value: 2,
      numerator: 6,
      denominator: 3,
    });
    expect(
      summaries.find((summary) => summary.name === "execution_average_step_count"),
    ).toMatchObject({
      value: 3,
      numerator: 9,
      denominator: 3,
    });
    expect(
      summaries.find((summary) => summary.name === "execution_failure_code_count_by_code"),
    ).toMatchObject({
      value: 1,
      breakdown: {
        not_equipped: 1,
      },
    });
  });

  it("应把生产指标事件落到 metrics 日期分桶 JSONL", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "ts-core-metrics-"));
    const sink = createLocalProductionMetricLogSink({
      baseDir,
      sensitiveValues: ["sk-local-dev"],
    });
    await sink(
      createProductionMetricEventJsonlLine({
        event_id: "metric-event-2",
        event_type: "llm.stage",
        message_id: "msg-2",
        task_id: null,
        bot_id: "local-bot",
        root_goal_id: null,
        recovery_chain_id: null,
        created_at: "2026-05-07T00:00:00.000Z",
        source: "conversation_llm",
        prompt_version: null,
        model: "bl-auto",
        stage: "plan",
        ok: false,
        error_code: "llm_stage_failed",
        duration_ms: 15000,
        input_tokens: 320,
        output_tokens: 0,
      }),
    );

    const content = await readFile(
      join(baseDir, "metrics", "2026-05-07", "production-metrics.jsonl"),
      "utf8",
    );

    expect(content).toContain('"schema_version":"ts-core.metric.v1"');
    expect(content).toContain('"event_type":"llm.stage"');
    expect(content).not.toContain("sk-local-dev");
  });
});

function createFakeEvalClient(): ConversationLlmEvalClient {
  return {
    async generateCompositeTriage(input) {
      expect(input.message_id).toBe("msg-triage-chat");
      return {
        chat: {},
      };
    },
    async generateCodePlan(input) {
      const diagnostics = createDiagnostics({
        stage: "plan",
        messageId: input.message_id,
        requestMs: 250,
        inputTokens: 100,
        outputTokens: 30,
      });
      if (input.message_id === "msg-plan-static") {
        return {
          code: 'eval("1")',
          diagnostics,
        };
      }

      return {
        code: 'await reply("好"); const task = await runGoal("砍树", async () => {}); await report(task);',
        diagnostics,
      };
    },
    async generateChatReply(input) {
      return {
        mode: "llm",
        reply: `reply:${input.message}`,
        diagnostics: createDiagnostics({
          stage: "chat",
          messageId: input.message_id,
          requestMs: 90,
          inputTokens: 50,
          outputTokens: 12,
        }),
      };
    },
    async generateReport(input) {
      return {
        reply: input.deterministic_report,
        diagnostics: createDiagnostics({
          stage: "report",
          messageId: input.message_id,
          requestMs: 80,
          inputTokens: 40,
          outputTokens: 10,
        }),
      };
    },
  };
}

function createZeroUsageFailureEvalClient(): ConversationLlmEvalClient {
  return {
    async generateCompositeTriage() {
      throw new Error("unexpected triage call");
    },
    async generateCodePlan(input) {
      const error = new Error("LLM request timed out") as Error & {
        diagnostics: ConversationLlmDiagnosticRecord;
      };
      error.diagnostics = createDiagnostics({
        stage: "plan",
        messageId: input.message_id,
        requestMs: 300,
        inputTokens: 0,
        outputTokens: 0,
      });
      throw error;
    },
    async generateChatReply() {
      throw new Error("unexpected chat call");
    },
    async generateReport() {
      throw new Error("unexpected report call");
    },
  };
}

function createDiagnostics(input: {
  stage: ConversationLlmDiagnosticRecord["stage"];
  messageId: string;
  requestMs: number;
  inputTokens: number;
  outputTokens: number;
  planMetric?: ConversationLlmDiagnosticRecord["plan_metric"];
}): ConversationLlmDiagnosticRecord {
  const metrics: LlmCallMetrics = {
    queue_wait_ms: 0,
    prompt_build_ms: 1,
    request_total_ms: input.requestMs,
    response_parse_ms: 1,
    tool_round_count: 0,
    tool_round_ms: [],
    diagnostics_write_ms: null,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    tokens_per_second: 10,
    ttft_ms: null,
    ttft_unavailable: "non_streaming",
  };

  return {
    stage: input.stage,
    model: "bl-auto",
    message_id: input.messageId,
    log_ref: `llm/2026-05-07/${input.messageId}.jsonl`,
    created_at: "2026-05-07T00:00:00.000Z",
    ok: true,
    lines: [],
    metrics,
    ...(input.planMetric === undefined ? {} : { plan_metric: input.planMetric }),
  };
}

function createTickingNow(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(1_777_766_400_000 + tick * 10);
  };
}
