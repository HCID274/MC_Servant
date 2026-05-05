import { SKILL_DIRECTORY } from "../../core-ports/skills.js";
import type { BrainSearchInput, BrainSearchResult } from "../../data/contracts/index.js";
import type { LlmCallMetrics, LlmJsonlLine, LlmLogStage } from "../../diagnostics/contracts.js";
import type {
  ConversationCompositeTriage,
  ConversationHistoryTurn,
  ConversationReplyMode,
  ConversationSandboxCodePlanDraft,
  ConversationSkillCallPlanDraft,
} from "../contracts.js";

export interface ConversationLlmConfig {
  /** OpenAI 兼容基础地址。 */
  readonly base_url: string;
  /** OpenAI 兼容接口密钥。 */
  readonly api_key: string;
  /** 默认模型名。 */
  readonly model: string;
  /** 是否允许 thinking（思考） 模式；默认关闭以降低短任务延迟。 */
  readonly enable_thinking: boolean;
  /** reasoning effort（推理强度） 的统一语义，none 表示不主动请求推理。 */
  readonly reasoning_effort: string;
  /** 强制开启 thinking（思考） 模式的模型清单。 */
  readonly force_thinking_models: readonly string[];
  /** 默认 Bot 名称。 */
  readonly bot_name: string;
  /** 默认主人称谓。 */
  readonly owner_name: string;
  /** 单次请求超时。 */
  readonly timeout_ms: number;
}

/** OpenAI compatible（OpenAI 兼容） tool call（工具调用）。 */
export interface ConversationLlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/** 单条 OpenAI 兼容对话消息。 */
export interface ConversationLlmMessage {
  /** 消息角色。 */
  readonly role: "system" | "user" | "assistant" | "tool";
  /** 消息文本。 */
  readonly content: string;
  /** assistant（助手） 发出的 tool call（工具调用）。 */
  readonly tool_calls?: readonly ConversationLlmToolCall[];
  /** tool result（工具结果） 对应的 tool call id。 */
  readonly tool_call_id?: string;
}

/** ConversationWorker（对话工作线程） 暴露给 LLM（大语言模型） 的 Brain search（大脑检索）工具。 */
export type ConversationLlmSearchTool = (
  input: BrainSearchInput,
) => BrainSearchResult | Promise<BrainSearchResult>;

/** 闲聊调用的诊断摘要。 */
export interface ConversationLlmDiagnosticRecord {
  /** 调用阶段。 */
  readonly stage: LlmLogStage;
  /** 模型名。 */
  readonly model: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 结构化日志引用。 */
  readonly log_ref: string;
  /** 创建时间。 */
  readonly created_at: string;
  /** 是否成功。 */
  readonly ok: boolean;
  /** 失败摘要。 */
  readonly error_summary?: string;
  /** 本次调用生成的 JSONL（结构化日志） 行。 */
  readonly lines: readonly LlmJsonlLine[];
  /** 本次调用的分段性能指标。 */
  readonly metrics: LlmCallMetrics;
}

/** 闲聊回复生成结果。 */
export interface ConversationGeneratedReply {
  /** 回复模式。 */
  readonly mode: ConversationReplyMode;
  /** 回复文本。 */
  readonly reply: string;
  /** 可选诊断摘要。 */
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
}

/** 闲聊请求输入。 */
export interface ConversationLlmChatInput {
  /** 目标 Bot（机器人） 标识；search() tool（工具） 启用时必需。 */
  readonly bot_id?: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 最近对话历史。 */
  readonly history?: readonly ConversationHistoryTurn[];
  /** 可选 Bot 名称覆盖。 */
  readonly bot_name?: string;
  /** 可选主人称谓覆盖。 */
  readonly owner_name?: string;
  /** 可选 Chat（闲聊） 路径快照上下文。 */
  readonly snapshot_context?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
  /** A.5 + C 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
  /** 可选当前状态摘要。 */
  readonly state_context?: string;
  /** 可选 Brain search（大脑检索） tool（工具）。 */
  readonly search_tool?: ConversationLlmSearchTool;
  /** 从消息入队到本阶段 LLM（大语言模型） 调用开始前的等待耗时。 */
  readonly queue_wait_ms?: number;
}

/** 分诊请求输入。 */
export interface ConversationLlmTriageInput {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 最近对话历史。 */
  readonly history?: readonly ConversationHistoryTurn[];
  /** 一行 Bot 状态摘要。 */
  readonly bot_summary?: string;
  /** A.5 + C(USER/MEMORY) 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
  /** 从消息入队到本阶段 LLM（大语言模型） 调用开始前的等待耗时。 */
  readonly queue_wait_ms?: number;
}

/** 最小移动规划请求输入。 */
export interface ConversationLlmPlanInput {
  /** 目标 Bot（机器人） 标识；search() tool（工具） 启用时必需。 */
  readonly bot_id?: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 当前主人消息。 */
  readonly message: string;
  /** 规划时的一行环境快照。 */
  readonly snapshot_context: string;
  /** 分诊理由。 */
  readonly triage_reason?: string;
  /** 可选任务历史摘要。 */
  readonly task_history_context?: string;
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
  /** A.5 + C 常驻 Brain context（大脑上下文）。 */
  readonly brain_context?: string;
  /** 可选 Brain search（大脑检索） tool（工具）。 */
  readonly search_tool?: ConversationLlmSearchTool;
  /** 从消息入队到本阶段 LLM（大语言模型） 调用开始前的等待耗时。 */
  readonly queue_wait_ms?: number;
}

/** 闲聊调用成功结果。 */
export interface ConversationLlmChatResult {
  /** 固定为 `llm`（大语言模型） 回复。 */
  readonly mode: "llm";
  /** 原始回复文本。 */
  readonly reply: string;
  /** 诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
}

/** 在线最小真实规划允许的技能集合。 */
export const ONLINE_PLAN_SKILLS = Object.freeze([
  SKILL_DIRECTORY.goTo,
  SKILL_DIRECTORY.mine,
  SKILL_DIRECTORY.cutTree,
  SKILL_DIRECTORY.collect,
  SKILL_DIRECTORY.equip,
] as const);

/** 最小技能规划成功结果。 */
export type ConversationLlmPlanResult = (
  | Extract<ConversationSkillCallPlanDraft, { skill: (typeof ONLINE_PLAN_SKILLS)[number] }>
  | ConversationSandboxCodePlanDraft
) & {
  /** 可选诊断摘要；在线调用成功时用于 conversation（对话） 本地完整日志。 */
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
};

/** OpenAI 兼容聊天请求依赖。 */
export interface ConversationLlmDependencies {
  /** 可注入 fetch（网络请求） 实现。 */
  readonly fetch?: typeof fetch;
  /** 可注入当前时间。 */
  readonly now?: () => Date;
  /** 可注入单调时钟，用于性能分段指标。 */
  readonly monotonicNow?: () => number;
  /** 诊断回调。 */
  readonly onDiagnostic?: (record: ConversationLlmDiagnosticRecord) => void | Promise<void>;
}

/** 闲聊客户端暴露的最小能力。 */
export interface ConversationLlmClient {
  /** 基于真实 OpenAI 兼容接口执行 Stage 1-Composite Triage（复合分诊）。 */
  generateCompositeTriage(input: ConversationLlmTriageInput): Promise<ConversationCompositeTriage>;
  /** 基于真实 OpenAI 兼容接口生成闲聊回复。 */
  generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult>;
  /** 基于真实 OpenAI 兼容接口生成最小单技能 `skill_call`（技能调用） 规划。 */
  generateSkillPlan(input: ConversationLlmPlanInput): Promise<ConversationLlmPlanResult>;
}
