import { describe, expect, it } from "vitest";

import {
  type ConversationLlmDiagnosticRecord,
  type ConversationLlmReportInput,
  createConversationLlmClient,
  createConversationLlmConfig,
} from "../conversation/index.js";
import { ExecutionTaskKind } from "../core-ports/foundation.js";
import { ExecPriority, TaskHistoryStatus, createCodeJob } from "../core-ports/tasking.js";
import { createBotWorkerActions, createBotWorkerTask } from "../workers/contracts.js";
import { createTaskResultReporter } from "../workers/index.js";

describe("ReportLLM 终态润色", () => {
  it("TaskResultReporter 应先生成模板，再用受限事实输入调用 ReportLLM", async () => {
    const reportInputs: ConversationLlmReportInput[] = [];
    const reporter = createTaskResultReporter({
      reportLlm: {
        generateReport: async (input) => {
          reportInputs.push(input);

          return {
            reply:
              "任务完成啦，cobblestone x5、cherry_log x16 都到手了，耗时 73s，世界 multiworld:resource喵~",
            diagnostics: createFakeDiagnostic("ok"),
          };
        },
      },
    });
    const actions = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-report",
        exec_job: createCodeJob({
          message_id: "msg-report-success",
          intent_epoch: 1,
          snapshot_ts: 1,
          priority: ExecPriority.Normal,
        }),
        owner_text: "先挖5个石头，再砍5颗木头，最后回到我这",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 6,
      duration_ms: 73_000,
      result_summary: {
        task_type: ExecutionTaskKind.Code,
        operation: "挖石头、砍木头并返回主人身边",
        completed_count: 21,
        inventory_delta: [
          { item_name: "cobblestone", count: 5 },
          { item_name: "cherry_log", count: 16 },
        ],
        world_key: "multiworld:resource",
      },
    });

    const reply = await reporter.consume(actions[1]);

    expect(reply?.content).toBe(
      "任务完成啦，cobblestone x5、cherry_log x16 都到手了，耗时 73s，世界 multiworld:resource喵~",
    );
    expect(reportInputs).toHaveLength(1);
    expect(reportInputs[0]).toMatchObject({
      message_id: "msg-report-success:task_result",
      owner_text: "先挖5个石头，再砍5颗木头，最后回到我这",
      status: "completed",
      required_facts: [
        "完成",
        "cobblestone x5",
        "cherry_log x16",
        "73s",
        "世界 multiworld:resource",
      ],
    });
    expect(reportInputs[0]?.deterministic_report).toContain("cobblestone x5");
    expect(JSON.stringify(reportInputs[0])).not.toContain("await");
    expect(JSON.stringify(reportInputs[0])).not.toContain("api.bot");
    await expect(reporter.consume(actions[1])).resolves.toBeNull();
  });

  it("ReportLLM 调用失败时应回退确定性模板且不改变任务结果", async () => {
    const reporter = createTaskResultReporter({
      reportLlm: {
        generateReport: async () => {
          throw new Error("report gateway unavailable");
        },
      },
    });
    const actions = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-report",
        exec_job: createCodeJob({
          message_id: "msg-report-fallback",
          intent_epoch: 1,
          snapshot_ts: 1,
          priority: ExecPriority.Normal,
        }),
        owner_text: "挖铁矿",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 800,
      error: {
        name: "FacadeCallError",
        message: "not_equipped:iron_ore",
        error_code: "not_equipped",
        details: {
          failure_stage: "mine",
          recoverable: true,
        },
      },
      last_step: "mine",
    });

    const reply = await reporter.consume(actions[1]);

    expect(reply?.content).toContain("任务失败：code 失败码 not_equipped");
    expect(reply?.content).toContain("阶段 mine");
  });

  it("ConversationLlmClient 的 report 阶段应校验事实，失败时记录 fallback diagnostics", async () => {
    const diagnostics: ConversationLlmDiagnosticRecord[] = [];
    const client = createConversationLlmClient(createTestLlmConfig(), {
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "完成啦，东西都拿到了喵~" } }],
            usage: { prompt_tokens: 20, completion_tokens: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      now: () => new Date("2026-05-06T00:00:00.000Z"),
      onDiagnostic: (record) => diagnostics.push(record),
    });

    const result = await client.generateReport({
      message_id: "msg-report-validate",
      owner_text: "挖石头",
      status: "completed",
      deterministic_report: "任务完成：挖到 cobblestone x5，耗时 12s，世界 multiworld:resource喵~",
      fact_summary: "状态=任务完成；结果=cobblestone x5；耗时=12s；世界 multiworld:resource",
      required_facts: ["完成", "cobblestone x5", "12s", "世界 multiworld:resource"],
      tone: "短句汇报",
    });

    expect(result.reply).toBe(
      "任务完成：挖到 cobblestone x5，耗时 12s，世界 multiworld:resource喵~",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "report",
      message_id: "msg-report-validate",
      ok: false,
    });
    expect(diagnostics[0]?.lines.at(-1)).toMatchObject({
      meta: {
        fallback: true,
        fallback_reason: "ReportLLM output missing fact:cobblestone x5",
        input_fact_summary:
          "状态=任务完成；结果=cobblestone x5；耗时=12s；世界 multiworld:resource",
        output_summary: "完成啦，东西都拿到了喵~",
      },
    });
  });

  it("ConversationLlmClient 的 report 阶段成功时应记录 report diagnostics", async () => {
    const diagnostics: ConversationLlmDiagnosticRecord[] = [];
    const client = createConversationLlmClient(createTestLlmConfig(), {
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    "任务完成啦，cobblestone x5 已经到手，耗时 12s，世界 multiworld:resource喵~",
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 12 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      now: () => new Date("2026-05-06T00:00:00.000Z"),
      onDiagnostic: (record) => diagnostics.push(record),
    });

    const result = await client.generateReport({
      message_id: "msg-report-ok",
      owner_text: "挖石头",
      status: "completed",
      deterministic_report: "任务完成：挖到 cobblestone x5，耗时 12s，世界 multiworld:resource喵~",
      fact_summary: "状态=任务完成；结果=cobblestone x5；耗时=12s；世界 multiworld:resource",
      required_facts: ["完成", "cobblestone x5", "12s", "世界 multiworld:resource"],
      tone: "短句汇报",
    });

    expect(result.reply).toContain("cobblestone x5");
    expect(diagnostics[0]).toMatchObject({
      stage: "report",
      message_id: "msg-report-ok",
      ok: true,
    });
    expect(diagnostics[0]?.lines.at(-1)).toMatchObject({
      meta: {
        fallback: false,
        fallback_reason: null,
        input_fact_summary:
          "状态=任务完成；结果=cobblestone x5；耗时=12s；世界 multiworld:resource",
      },
    });
  });
});

function createTestLlmConfig() {
  return createConversationLlmConfig({
    base_url: "http://127.0.0.1:8045/v1",
    api_key: "sk-local-dev",
    model: "bl-auto",
    enable_thinking: false,
    reasoning_effort: "none",
    force_thinking_models: [],
    bot_name: "bot-report",
    owner_name: "主人",
    timeout_ms: 1_000,
  });
}

function createFakeDiagnostic(status: "ok" | "error"): ConversationLlmDiagnosticRecord {
  return {
    stage: "report",
    model: "bl-auto",
    message_id: "msg-report-success:task_result",
    log_ref: "llm/2026-05-06/report-msg-report-success:task_result.jsonl",
    created_at: "2026-05-06T00:00:00.000Z",
    ok: status === "ok",
    lines: [],
    metrics: {
      queue_wait_ms: 0,
      prompt_build_ms: 0,
      request_total_ms: 1,
      response_parse_ms: 0,
      tool_round_count: 0,
      tool_round_ms: [],
      diagnostics_write_ms: null,
      input_tokens: 1,
      output_tokens: 1,
      tokens_per_second: 1,
      ttft_ms: null,
      ttft_unavailable: "non_streaming",
    },
  };
}
