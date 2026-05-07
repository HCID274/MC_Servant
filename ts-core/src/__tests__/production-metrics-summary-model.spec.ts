import { describe, expect, it } from "vitest";

import type { ProductionMetricEventJsonlLine } from "../data/contracts/index.js";
import {
  createProductionMetricEventJsonlLine,
  createProductionMetricReport,
  parseProductionMetricJsonlLines,
  readProductionMetricTaskType,
} from "../diagnostics/index.js";

describe("生产指标汇总报告", () => {
  it("应按窗口、Bot、模型、prompt 版本和任务类型汇总语义化指标", () => {
    const recoveryChainId = "recovery:local-bot:msg-root";
    const events = [
      createMetricEvent({
        event_id: "triage",
        event_type: "llm.stage",
        message_id: "msg-triage",
        created_at: "2026-05-07T00:00:00.000Z",
        source: "conversation_llm",
        prompt_version: "plan-v1",
        model: "bl-auto",
        stage: "triage",
        duration_ms: 100,
        input_tokens: 10,
        output_tokens: 2,
      }),
      createMetricEvent({
        event_id: "plan",
        event_type: "llm.stage",
        message_id: "msg-plan",
        created_at: "2026-05-07T00:01:00.000Z",
        source: "conversation_llm",
        prompt_version: "plan-v1",
        model: "bl-auto",
        stage: "plan",
        duration_ms: 200,
        input_tokens: 30,
        output_tokens: 5,
        plan_parse_ok: true,
        plan_code_only_ok: true,
      }),
      createMetricEvent({
        event_id: "completed",
        event_type: "task.completed",
        message_id: "msg-completed",
        task_id: "msg-completed",
        created_at: "2026-05-07T00:02:00.000Z",
        source: "bot_worker",
        stage: "execution",
        ok: true,
        duration_ms: 120_000,
        terminal_status: "completed",
        step_count: 4,
        is_manual_intervention: false,
      }),
      createMetricEvent({
        event_id: "recoverable-root",
        event_type: "task.failed",
        message_id: "msg-root",
        task_id: "msg-root",
        recovery_chain_id: recoveryChainId,
        created_at: "2026-05-07T00:03:00.000Z",
        source: "bot_worker",
        stage: "execution",
        ok: false,
        error_code: "not_equipped",
        duration_ms: 60_000,
        terminal_status: "failed",
        step_count: 1,
        is_manual_intervention: false,
        recovery_class: "recoverable",
        replan_count: 0,
      }),
      createMetricEvent({
        event_id: "recovered",
        event_type: "task.completed",
        message_id: "msg-recovered",
        task_id: "msg-recovered",
        recovery_chain_id: recoveryChainId,
        created_at: "2026-05-07T00:04:00.000Z",
        source: "bot_worker",
        stage: "execution",
        ok: true,
        duration_ms: 180_000,
        terminal_status: "completed",
        step_count: 3,
        is_manual_intervention: false,
        replan_count: 2,
      }),
      createMetricEvent({
        event_id: "outside-window",
        event_type: "llm.stage",
        message_id: "msg-old",
        created_at: "2026-05-06T23:59:59.000Z",
        source: "conversation_llm",
        model: "other-model",
        stage: "chat",
        duration_ms: 50,
        input_tokens: 1,
        output_tokens: 1,
      }),
    ];
    const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const parsedEvents = parseProductionMetricJsonlLines(content, "test-metrics.jsonl");
    const report = createProductionMetricReport({
      events: parsedEvents,
      filters: {
        from: "2026-05-07",
        to: "2026-05-07",
        bot_id: "local-bot",
      },
      now: () => new Date("2026-05-07T12:00:00.000Z"),
    });
    const overall = report.groups.find((group) => group.group_by === "overall");
    const modelGroup = report.groups.find(
      (group) => group.group_by === "model" && group.group_value === "bl-auto",
    );
    const recoveryGroup = report.groups.find(
      (group) => group.group_by === "task_type" && group.group_value === "failure_recovery",
    );

    expect(report.event_count).toBe(5);
    expect(
      overall?.metrics.llm.find((metric) => metric.name === "llm_input_tokens_total"),
    ).toMatchObject({
      value: 40,
      numerator: 40,
      denominator: 2,
    });
    expect(
      overall?.metrics.execution.find((metric) => metric.name === "execution_task_run_count"),
    ).toMatchObject({
      value: 3,
    });
    expect(
      overall?.metrics.recovery.find((metric) => metric.name === "average_replan_count_to_success"),
    ).toMatchObject({
      value: 2,
    });
    expect(modelGroup?.event_count).toBe(2);
    expect(recoveryGroup?.event_count).toBe(2);
    expect(report.resume_summary_zh).toContain("Plan 严格解析成功率 100.0%");
    expect(JSON.stringify(report)).not.toMatch(
      /"A1"|"D1"|"D2"|"D3"|"E2"|"B1"|"B2"|"B3"|"C1"|"C2"/u,
    );
  });

  it("应从生产指标事件推导任务类型", () => {
    expect(
      readProductionMetricTaskType(
        createMetricEvent({
          event_id: "plan-discarded",
          event_type: "conversation.plan_discarded",
          source: "conversation_worker",
          stage: "plan",
          ok: false,
        }),
      ),
    ).toBe("conversation_plan_discarded");
  });
});

function createMetricEvent(
  overrides: Partial<ProductionMetricEventJsonlLine> & {
    readonly event_id: string;
    readonly event_type: ProductionMetricEventJsonlLine["event_type"];
    readonly source: ProductionMetricEventJsonlLine["source"];
    readonly stage: ProductionMetricEventJsonlLine["stage"];
    readonly ok?: boolean;
  },
): ProductionMetricEventJsonlLine {
  return createProductionMetricEventJsonlLine({
    event_id: overrides.event_id,
    event_type: overrides.event_type,
    message_id: overrides.message_id ?? null,
    task_id: overrides.task_id ?? null,
    bot_id: overrides.bot_id ?? "local-bot",
    root_goal_id: overrides.root_goal_id ?? null,
    recovery_chain_id: overrides.recovery_chain_id ?? null,
    created_at: overrides.created_at ?? "2026-05-07T00:00:00.000Z",
    source: overrides.source,
    prompt_version: overrides.prompt_version ?? null,
    model: overrides.model ?? null,
    stage: overrides.stage,
    ok: overrides.ok ?? false,
    error_code: overrides.error_code ?? null,
    duration_ms: overrides.duration_ms ?? null,
    input_tokens: overrides.input_tokens ?? null,
    output_tokens: overrides.output_tokens ?? null,
    plan_parse_ok: overrides.plan_parse_ok ?? null,
    plan_code_only_ok: overrides.plan_code_only_ok ?? null,
    plan_gate_failure_type: overrides.plan_gate_failure_type ?? null,
    plan_static_precheck_failure_type: overrides.plan_static_precheck_failure_type ?? null,
    terminal_status: overrides.terminal_status ?? null,
    step_count: overrides.step_count ?? null,
    is_manual_intervention: overrides.is_manual_intervention ?? null,
    recovery_class: overrides.recovery_class ?? null,
    replan_count: overrides.replan_count ?? null,
  });
}
