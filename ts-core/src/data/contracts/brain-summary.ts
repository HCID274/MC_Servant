import { assertNonEmptyString } from "../../domain/invariants.js";

/** bot_rolling_summary（滚动摘要） 当前行快照。 */
export interface BotRollingSummaryRecord {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** A.5（滚动记忆） 摘要正文。 */
  readonly content: string;
  /** 当前字符数。 */
  readonly char_count: number;
  /** 最近一次重压使用的 LLM（大语言模型） 模型。 */
  readonly llm_model?: string;
  /** 更新时间。 */
  readonly updated_at: string;
}

/** bot_rolling_summary（滚动摘要） 写入输入。 */
export interface BotRollingSummaryWrite {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** A.5（滚动记忆） 摘要正文。 */
  readonly content: string;
  /** 最近一次重压使用的 LLM（大语言模型） 模型。 */
  readonly llm_model?: string;
  /** 更新时间。 */
  readonly updated_at: string;
}

/** 创建只读 bot_rolling_summary（滚动摘要） 快照。 */
export function createBotRollingSummaryRecord(
  input: BotRollingSummaryRecord,
): BotRollingSummaryRecord {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.updated_at, "updated_at");
  assertNonNegativeInteger(input.char_count, "char_count");

  return Object.freeze({
    bot_id: input.bot_id,
    content: input.content,
    char_count: input.char_count,
    ...(input.llm_model === undefined ? {} : { llm_model: input.llm_model }),
    updated_at: input.updated_at,
  });
}

/** 创建只读 bot_rolling_summary（滚动摘要） 写入对象。 */
export function createBotRollingSummaryWrite(
  input: BotRollingSummaryWrite,
): BotRollingSummaryWrite {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.updated_at, "updated_at");

  return Object.freeze({
    bot_id: input.bot_id,
    content: input.content,
    ...(input.llm_model === undefined ? {} : { llm_model: input.llm_model }),
    updated_at: input.updated_at,
  });
}

/** 计算滚动摘要字符数；按 Unicode code point（码点） 计数，避免中文被按 UTF-16 半个字符拆开。 */
export function countRollingSummaryChars(content: string): number {
  return Array.from(content).length;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
