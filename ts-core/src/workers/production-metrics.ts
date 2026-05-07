import type { ConversationLlmDiagnosticRecord } from "../conversation/llm/index.js";
import { classifyFailureCode } from "../core-ports/task-result.js";
import { TaskHistoryStatus, createRecoveryChainId } from "../core-ports/tasking.js";
import type { ProductionMetricEventJsonlLine } from "../data/contracts/index.js";
import {
  type ProductionMetricLogSink,
  createProductionMetricEventJsonlLine,
} from "../diagnostics/index.js";
import type { BotWorkerAction, EmitTaskLifecycleAction } from "./contracts.js";

export type WorkerProductionMetricSink = ProductionMetricLogSink;

/** 将 LLM diagnostics（诊断）映射为生产指标事件。 */
export function createProductionMetricEventFromLlmDiagnostic(input: {
  readonly bot_id: string;
  readonly diagnostic: ConversationLlmDiagnosticRecord;
}): ReturnType<typeof createProductionMetricEventJsonlLine> {
  return createProductionMetricEventJsonlLine({
    event_type: "llm.stage",
    message_id: input.diagnostic.message_id,
    task_id: null,
    bot_id: input.bot_id,
    root_goal_id: null,
    recovery_chain_id: null,
    created_at: input.diagnostic.created_at,
    source: "conversation_llm",
    prompt_version: null,
    model: input.diagnostic.model,
    stage: input.diagnostic.stage,
    ok: input.diagnostic.ok,
    error_code: input.diagnostic.ok ? null : "llm_stage_failed",
    duration_ms: input.diagnostic.metrics.request_total_ms,
    input_tokens: input.diagnostic.metrics.input_tokens,
    output_tokens: input.diagnostic.metrics.output_tokens,
    plan_parse_ok: input.diagnostic.plan_metric?.plan_parse_ok ?? null,
    plan_code_only_ok: input.diagnostic.plan_metric?.plan_code_only_ok ?? null,
    plan_gate_failure_type: input.diagnostic.plan_metric?.plan_gate_failure_type ?? null,
    plan_static_precheck_failure_type:
      input.diagnostic.plan_metric?.plan_static_precheck_failure_type ?? null,
  });
}

/** 将 BotWorker（机器人工作线程）生命周期动作映射为生产指标事件。 */
export function createProductionMetricEventFromBotWorkerAction(input: {
  readonly action: BotWorkerAction;
  readonly created_at: string;
}): ReturnType<typeof createProductionMetricEventJsonlLine> | null {
  if (input.action.type !== "emit_task_lifecycle") {
    return null;
  }

  const lifecycle = input.action.lifecycle;
  const payload = lifecycle.payload;
  const durationMs = "duration_ms" in payload ? payload.duration_ms : null;
  const terminalStatus = readTerminalStatus(lifecycle.status);
  const recoveryChainId = readLifecycleRecoveryChainId(input.action.bot_id, lifecycle);
  const replanCount = readLifecycleReplanCount(lifecycle, terminalStatus);

  return createProductionMetricEventJsonlLine({
    event_type: lifecycle.event_type,
    message_id: payload.message_id,
    task_id: payload.job_id,
    bot_id: input.action.bot_id,
    root_goal_id: null,
    recovery_chain_id: recoveryChainId,
    created_at: input.created_at,
    source: "bot_worker",
    prompt_version: null,
    model: null,
    stage: "execution",
    ok:
      lifecycle.status === TaskHistoryStatus.Completed ||
      lifecycle.status === TaskHistoryStatus.Started,
    error_code: readLifecycleErrorCode(lifecycle),
    duration_ms: durationMs,
    input_tokens: null,
    output_tokens: null,
    terminal_status: terminalStatus,
    step_count: "total_steps" in payload ? payload.total_steps : null,
    is_manual_intervention:
      terminalStatus === null ? null : readLifecycleManualIntervention(lifecycle),
    recovery_class: readLifecycleRecoveryClass(lifecycle),
    replan_count: replanCount,
  });
}

function readTerminalStatus(
  status: EmitTaskLifecycleAction["lifecycle"]["status"],
): ProductionMetricEventJsonlLine["terminal_status"] {
  switch (status) {
    case TaskHistoryStatus.Completed:
      return "completed";
    case TaskHistoryStatus.Failed:
      return "failed";
    case TaskHistoryStatus.Interrupted:
      return "interrupted";
    case TaskHistoryStatus.Discarded:
      return "discarded";
    default:
      return null;
  }
}

function readLifecycleManualIntervention(action: EmitTaskLifecycleAction["lifecycle"]): boolean {
  const payload = action.payload;

  if (
    "interrupt_source" in payload &&
    payload.interrupt_source !== null &&
    typeof payload.interrupt_source === "object" &&
    "type" in payload.interrupt_source
  ) {
    return payload.interrupt_source.type === "control";
  }

  return false;
}

function readLifecycleErrorCode(action: EmitTaskLifecycleAction["lifecycle"]): string | null {
  const payload = action.payload;

  if ("error" in payload && payload.error.error_code !== undefined) {
    return payload.error.error_code;
  }

  if ("discard_reason" in payload) {
    return payload.discard_reason;
  }

  if ("reason" in payload) {
    return "task_interrupted";
  }

  return action.status === TaskHistoryStatus.Failed ? "task_failed" : null;
}

function readLifecycleRecoveryChainId(
  botId: string,
  action: EmitTaskLifecycleAction["lifecycle"],
): string | null {
  const payload = action.payload;

  if ("recovery_chain_id" in payload && typeof payload.recovery_chain_id === "string") {
    return payload.recovery_chain_id;
  }

  if (action.status === TaskHistoryStatus.Failed) {
    return createRecoveryChainId({
      bot_id: botId,
      message_id: payload.message_id,
    });
  }

  return null;
}

function readLifecycleReplanCount(
  action: EmitTaskLifecycleAction["lifecycle"],
  terminalStatus: ProductionMetricEventJsonlLine["terminal_status"],
): number | null {
  const payload = action.payload;

  if ("replan_count" in payload && typeof payload.replan_count === "number") {
    return payload.replan_count;
  }

  return terminalStatus === "failed" ? 0 : null;
}

function readLifecycleRecoveryClass(
  action: EmitTaskLifecycleAction["lifecycle"],
): ProductionMetricEventJsonlLine["recovery_class"] {
  if (action.status !== TaskHistoryStatus.Failed) {
    return null;
  }

  const failureCode =
    readLifecycleResultSummaryFailureCode(action) ?? readLifecycleErrorCode(action);
  return classifyFailureCode(failureCode ?? undefined);
}

function readLifecycleResultSummaryFailureCode(
  action: EmitTaskLifecycleAction["lifecycle"],
): string | null {
  const payload = action.payload;

  if (!("result_summary" in payload) || payload.result_summary === undefined) {
    return null;
  }

  return payload.result_summary.failure?.failure_code ?? null;
}
