/** 生产指标事件 JSONL 契约版本。 */
export const PRODUCTION_METRIC_SCHEMA_VERSION = "ts-core.metric.v1" as const;

/** 生产指标事件类型。 */
export const PRODUCTION_METRIC_EVENT_TYPES = [
  "llm.stage",
  "conversation.plan_accepted",
  "conversation.plan_discarded",
  "task.started",
  "task.completed",
  "task.failed",
  "task.interrupted",
  "task.discarded",
] as const;

export type ProductionMetricEventType = (typeof PRODUCTION_METRIC_EVENT_TYPES)[number];

/** 生产指标事件来源。 */
export const PRODUCTION_METRIC_SOURCES = [
  "conversation_llm",
  "conversation_worker",
  "bot_worker",
] as const;

export type ProductionMetricSource = (typeof PRODUCTION_METRIC_SOURCES)[number];

/** 生产指标阶段。 */
export const PRODUCTION_METRIC_STAGES = [
  "triage",
  "chat",
  "plan",
  "report",
  "brain",
  "execution",
  "recovery",
] as const;

export type ProductionMetricStage = (typeof PRODUCTION_METRIC_STAGES)[number];

/** 生产指标任务终态。 */
export const PRODUCTION_METRIC_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "discarded",
] as const;

export type ProductionMetricTerminalStatus = (typeof PRODUCTION_METRIC_TERMINAL_STATUSES)[number];

/** 每次真实运行自动落盘的生产指标事件。 */
export interface ProductionMetricEventJsonlLine {
  readonly schema_version: typeof PRODUCTION_METRIC_SCHEMA_VERSION;
  readonly event_id: string;
  readonly event_type: ProductionMetricEventType;
  readonly message_id: string | null;
  readonly task_id: string | null;
  readonly bot_id: string;
  readonly root_goal_id: string | null;
  readonly recovery_chain_id: string | null;
  readonly created_at: string;
  readonly source: ProductionMetricSource;
  readonly prompt_version: string | null;
  readonly model: string | null;
  readonly stage: ProductionMetricStage;
  readonly ok: boolean;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly plan_parse_ok: boolean | null;
  readonly plan_code_only_ok: boolean | null;
  readonly plan_gate_failure_type: string | null;
  readonly plan_static_precheck_failure_type: string | null;
  readonly terminal_status: ProductionMetricTerminalStatus | null;
  readonly step_count: number | null;
  readonly is_manual_intervention: boolean | null;
}
