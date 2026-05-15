import { createProductionMetricEventJsonlLine } from "../../../diagnostics/index.js";
import type { PlanExecHandlerInput, PlanningFailureReason } from "./types.js";

export async function emitPlanAcceptedMetric(input: {
  readonly request: Pick<PlanExecHandlerInput, "task" | "dependencies">;
  readonly task_id: string;
  readonly recovery_chain_id?: string;
  readonly recovery_class?: "recoverable" | "unknown";
  readonly replan_count?: number;
}): Promise<void> {
  try {
    await input.request.dependencies.productionMetricSink?.(
      createProductionMetricEventJsonlLine({
        event_type: "conversation.plan_accepted",
        message_id: input.request.task.message.message_id,
        task_id: input.task_id,
        bot_id: input.request.task.bot_id,
        root_goal_id: null,
        recovery_chain_id: input.recovery_chain_id ?? null,
        created_at: new Date().toISOString(),
        source: "conversation_worker",
        prompt_version: null,
        model: null,
        stage: "plan",
        ok: true,
        error_code: null,
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
        recovery_class: input.recovery_class ?? null,
        replan_count: input.replan_count ?? null,
      }),
    );
  } catch (error) {
    // 生产指标是旁路诊断，不能影响真实规划入队；stderr 是最低可观测记录。
    logMetricSideEffectFailure("conversation.plan_accepted", error);
  }
}

export async function emitPlanDiscardedMetric(input: {
  readonly request: Pick<PlanExecHandlerInput, "task" | "dependencies">;
  readonly reason: PlanningFailureReason;
  readonly recovery_chain_id?: string;
  readonly recovery_class?: "recoverable" | "implementation_blocker" | "unknown";
  readonly replan_count?: number;
}): Promise<void> {
  try {
    await input.request.dependencies.productionMetricSink?.(
      createProductionMetricEventJsonlLine({
        event_type: "conversation.plan_discarded",
        message_id: input.request.task.message.message_id,
        task_id: null,
        bot_id: input.request.task.bot_id,
        root_goal_id: null,
        recovery_chain_id: input.recovery_chain_id ?? null,
        created_at: new Date().toISOString(),
        source: "conversation_worker",
        prompt_version: null,
        model: null,
        stage: "plan",
        ok: false,
        error_code: input.reason,
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
        recovery_class: input.recovery_class ?? null,
        replan_count: input.replan_count ?? null,
      }),
    );
  } catch (error) {
    // 生产指标是旁路诊断，不能影响真实回复；stderr 是最低可观测记录。
    logMetricSideEffectFailure("conversation.plan_discarded", error);
  }
}

function logMetricSideEffectFailure(eventType: string, error: unknown): void {
  console.warn("[conversation-worker] production metric sink failed", {
    event_type: eventType,
    error_summary: summarizeError(error),
  });
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
