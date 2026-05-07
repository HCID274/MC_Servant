import { describe, expect, it } from "vitest";

import type { ConversationLlmEvalClient } from "../conversation/llm/index.js";
import { runConversationLlmEvalCases } from "../conversation/llm/index.js";
import type { ConversationLlmDiagnosticRecord } from "../conversation/llm/index.js";
import type { LlmCallMetrics } from "../diagnostics/contracts.js";
import {
  createEvalCaseJsonlLine,
  createEvalRunJsonlLine,
  parseEvalCaseJsonlLines,
  serializeEvalJsonlLine,
} from "../diagnostics/index.js";

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
  };
}

function createTickingNow(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(1_777_766_400_000 + tick * 10);
  };
}
