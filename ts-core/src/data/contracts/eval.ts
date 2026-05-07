/** eval（评测） JSONL（结构化日志） 契约版本。 */
export const EVAL_JSONL_SCHEMA_VERSION = "ts-core.eval.v1" as const;

/** eval JSONL 行类型清单。 */
export const EVAL_JSONL_KINDS = ["case", "run", "attempt", "metric"] as const;

/** eval JSONL 行类型联合。 */
export type EvalJsonlKind = (typeof EVAL_JSONL_KINDS)[number];

/** 当前轻量 LLM（大语言模型）评测覆盖的阶段。 */
export const EVAL_LLM_STAGES = ["triage", "plan", "chat", "report"] as const;

/** eval LLM 阶段联合。 */
export type EvalLlmStage = (typeof EVAL_LLM_STAGES)[number];

/** runner（评测执行器）运行状态。 */
export const EVAL_RUN_STATUSES = ["started", "completed", "failed"] as const;

/** runner 运行状态联合。 */
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/** attempt（单次样本尝试）终态。 */
export const EVAL_ATTEMPT_STATUSES = ["passed", "failed", "error"] as const;

/** attempt 终态联合。 */
export type EvalAttemptStatus = (typeof EVAL_ATTEMPT_STATUSES)[number];

/** 固定指标编号。A2 依赖历史 baseline，本阶段不输出。 */
export const EVAL_METRIC_IDS = ["A1", "D1", "D2", "D3", "E2"] as const;

/** eval 指标编号联合。 */
export type EvalMetricId = (typeof EVAL_METRIC_IDS)[number];

/** 评测样本输入。字段按 stage 取用，保持 JSONL 契约轻量稳定。 */
export interface EvalCaseInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 主人消息或任务原文。 */
  readonly message?: string;
  /** 最近对话历史。 */
  readonly history?: readonly {
    readonly role: "owner" | "bot";
    readonly content: string;
  }[];
  /** Bot 状态摘要，triage 使用。 */
  readonly bot_summary?: string;
  /** Plan 阶段环境快照。 */
  readonly snapshot_context?: string;
  /** Plan 阶段分诊理由。 */
  readonly triage_reason?: string;
  /** Chat 阶段快照上下文。 */
  readonly snapshot_context_for_chat?: string;
  /** Report 阶段任务原文。 */
  readonly owner_text?: string;
  /** Report 阶段终态。 */
  readonly status?: "completed" | "failed" | "interrupted";
  /** Report 阶段确定性兜底文本。 */
  readonly deterministic_report?: string;
  /** Report 阶段事实摘要。 */
  readonly fact_summary?: string;
  /** Report 阶段必须保留的事实片段。 */
  readonly required_facts?: readonly string[];
  /** Report 阶段语气约束。 */
  readonly tone?: string;
}

/** 样本期望，只用于离线评测统计，不参与在线路由。 */
export interface EvalCaseExpectation {
  /** 期望对话路由。 */
  readonly route_kind?: "chat_reply" | "plan_exec" | "cancel_interrupt";
  /** 是否要求 Plan 输出严格 code-only。 */
  readonly code_only?: boolean;
}

/** token（令牌）节省估算探针。 */
export interface EvalTokenSavingProbe {
  /** 被两阶段路由避免的阶段。 */
  readonly avoided_stage: "plan";
  /** 若误入 Plan 会构造出的最小 Plan 输入。 */
  readonly plan_input: {
    readonly message_id: string;
    readonly message: string;
    readonly snapshot_context: string;
    readonly triage_reason?: string;
  };
}

/** case（评测样本） JSONL 行。 */
export interface EvalCaseJsonlLine {
  readonly schema_version: typeof EVAL_JSONL_SCHEMA_VERSION;
  readonly kind: "case";
  readonly case_id: string;
  readonly stage: EvalLlmStage;
  readonly tags?: readonly string[];
  readonly input: EvalCaseInput;
  readonly expect?: EvalCaseExpectation;
  readonly token_saving_probe?: EvalTokenSavingProbe;
}

/** runner 配置摘要。密钥必须在进入该结构前脱敏。 */
export interface EvalRunConfigSummary {
  readonly base_url: string;
  readonly model: string;
  readonly api_key: "<redacted>";
  readonly cases_ref?: string;
}

/** run（评测运行） JSONL 行。 */
export interface EvalRunJsonlLine {
  readonly schema_version: typeof EVAL_JSONL_SCHEMA_VERSION;
  readonly kind: "run";
  readonly run_id: string;
  readonly status: EvalRunStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly config: EvalRunConfigSummary;
  readonly case_count: number;
  readonly error_summary?: string;
}

/** token 节省估算摘要。 */
export interface EvalTokenSavingSummary {
  readonly avoided_stage: "plan";
  readonly avoided_input_tokens: number;
  readonly actual_input_tokens: number;
  readonly saved_ratio: number;
}

/** attempt（单次样本尝试） JSONL 行。 */
export interface EvalAttemptJsonlLine {
  readonly schema_version: typeof EVAL_JSONL_SCHEMA_VERSION;
  readonly kind: "attempt";
  readonly run_id: string;
  readonly case_id: string;
  readonly stage: EvalLlmStage;
  readonly status: EvalAttemptStatus;
  readonly ok: boolean;
  readonly parse_ok: boolean;
  readonly code_only_ok?: boolean;
  readonly route_kind?: EvalCaseExpectation["route_kind"];
  readonly expected_route_kind?: EvalCaseExpectation["route_kind"];
  readonly route_ok?: boolean;
  readonly planner_gate_failure_type?: string;
  readonly static_precheck_failure_type?: string;
  readonly latency_ms: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly token_saving?: EvalTokenSavingSummary;
  readonly error_summary?: string;
}

/** metric（汇总指标） JSONL 行。 */
export interface EvalMetricJsonlLine {
  readonly schema_version: typeof EVAL_JSONL_SCHEMA_VERSION;
  readonly kind: "metric";
  readonly run_id: string;
  readonly metric_id: EvalMetricId;
  readonly name: string;
  readonly scope: "run";
  readonly value: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly unit: "ratio" | "ms" | "tokens";
}

/** eval JSONL 行联合。 */
export type EvalJsonlLine =
  | EvalCaseJsonlLine
  | EvalRunJsonlLine
  | EvalAttemptJsonlLine
  | EvalMetricJsonlLine;
