import type { BotMemorySnapshot } from "./bot-memory.js";
import type { BotRollingSummaryRecord } from "./brain-summary.js";

/** Brain search（大脑检索） 支持的 B 层命中类别。 */
export const BRAIN_SEARCH_KIND_VALUES = ["task", "takeaway"] as const;

/** Brain search（大脑检索） 命中类别联合。 */
export type BrainSearchKind = (typeof BRAIN_SEARCH_KIND_VALUES)[number];

/** Brain search（大脑检索） 输入契约。 */
export interface BrainSearchInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 自然语言查询。 */
  readonly query: string;
  /** 可选搜索类别；缺省同时查 task/takeaway。 */
  readonly kinds?: readonly BrainSearchKind[];
  /** 命中数量，默认 5，上限 10。 */
  readonly top_k?: number;
}

/** Brain search（大脑检索） 单条命中。 */
export interface BrainSearchHit {
  /** task_events（任务事件） 主键。 */
  readonly id: string;
  /** task_history（任务历史） 主键。 */
  readonly task_id: string;
  /** 主人原文。 */
  readonly owner_text: string;
  /** 可选 takeaway（要点）。 */
  readonly takeaway?: string;
  /** task_card（任务卡） 原始结构。 */
  readonly task_card: unknown;
  /** 创建时间 ISO 字符串。 */
  readonly created_at: string;
  /** RRF（倒数排序融合）或等价排序分数。 */
  readonly score: number;
}

/** Brain search（大脑检索） 输出契约。 */
export interface BrainSearchResult {
  readonly hits: readonly BrainSearchHit[];
}

/** ConversationWorker（对话工作线程） 常驻 Brain context（大脑上下文）。 */
export interface ConversationBrainContext {
  /** A.5 rolling summary（滚动摘要）。 */
  readonly rolling_summary?: BotRollingSummaryRecord;
  /** C layer（长期资产）。 */
  readonly memory?: BotMemorySnapshot;
}
