import type {
  BrainSearchHit,
  BrainSearchResult,
  ConversationBrainContext,
} from "../data/contracts/index.js";

export const BRAIN_SEARCH_MAX_TOOL_ROUNDS = 3;
export const BRAIN_SEARCH_MAX_HITS_CHARS = 2000;
export const BRAIN_SEARCH_MAX_SNIPPET_CHARS = 300;

/** 渲染 Triage / Chat 共享的 A.5 + C(USER/MEMORY) 常驻上下文。 */
export function renderConversationBrainContext(input: {
  readonly context?: ConversationBrainContext;
  readonly includeSkill: boolean;
}): string | undefined {
  const sections = [
    renderNamedSection("A.5滚动摘要", input.context?.rolling_summary?.content),
    renderNamedSection("C.USER", input.context?.memory?.USER),
    renderNamedSection("C.MEMORY", input.context?.memory?.MEMORY),
    ...(input.includeSkill ? [renderNamedSection("C.SKILL", input.context?.memory?.SKILL)] : []),
  ].filter(isNonEmptyString);

  return sections.length === 0 ? undefined : sections.join("\n");
}

/** 将 brain.search（大脑检索） 命中压缩为 tool_result（工具结果） JSON。 */
export function createBrainSearchToolResult(input: {
  readonly query: string;
  readonly result: BrainSearchResult;
}): string {
  let totalChars = 0;
  let omitted = 0;
  const hits: Array<{
    readonly task_id: string;
    readonly created_at: string;
    readonly score: number;
    readonly snippet: string;
  }> = [];

  for (const hit of input.result.hits) {
    const snippet = createBrainSearchSnippet(hit);
    const limitedSnippet = truncateByCodePoint(snippet, BRAIN_SEARCH_MAX_SNIPPET_CHARS);
    const nextTotal = totalChars + Array.from(limitedSnippet).length;

    if (nextTotal > BRAIN_SEARCH_MAX_HITS_CHARS) {
      omitted += 1;
      continue;
    }

    totalChars = nextTotal;
    hits.push(
      Object.freeze({
        task_id: hit.task_id,
        created_at: hit.created_at,
        score: hit.score,
        snippet: limitedSnippet,
      }),
    );
  }

  return JSON.stringify({
    query: input.query,
    hits,
    ...(omitted === 0 ? {} : { omitted, note: "还有匹配被截断，请细化 query 重试。" }),
  });
}

function createBrainSearchSnippet(hit: BrainSearchHit): string {
  return [
    `主人：${hit.owner_text}`,
    hit.takeaway === undefined ? undefined : `要点：${hit.takeaway}`,
    `任务卡：${stringifyCompact(hit.task_card)}`,
  ]
    .filter(isNonEmptyString)
    .join("\n");
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    void error;
    return String(value);
  }
}

function renderNamedSection(name: string, content: string | undefined): string | undefined {
  const trimmed = content?.trim();

  return trimmed === undefined || trimmed.length === 0 ? undefined : `[${name}]\n${trimmed}`;
}

function truncateByCodePoint(value: string, maxChars: number): string {
  const chars = Array.from(value);

  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
