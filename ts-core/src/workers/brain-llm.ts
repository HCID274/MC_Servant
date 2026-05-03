import type { ConversationLlmConfig, ConversationLlmMessage } from "../conversation/llm.js";
import { requestChatCompletionPayload } from "../conversation/llm/http.js";
import { extractAssistantReply, parseJsonRecord } from "../conversation/llm/parsers.js";
import type { SnapshotPosition } from "../core-ports/observation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import {
  BOT_MEMORY_KIND_VALUES,
  type BotMemoryKind,
  type BotMemorySnapshot,
  type BrainTaskCard,
} from "../data/index.js";
import { assertNonEmptyString } from "../domain/invariants.js";

/** BrainWorker（大脑工作线程） 使用的 LLM（大语言模型） 端口。 */
export interface BrainWorkerLlmClient {
  /** 当前模型名，用于记录 bot_rolling_summary.llm_model（滚动摘要模型）。 */
  readonly model: string;
  /** 失败任务根因 takeaway（要点）。 */
  generateFailureTakeaway(input: BrainFailureTakeawayInput): Promise<string>;
  /** 会话静默后的 takeaway（要点）。 */
  generateSessionTakeaway(input: BrainSessionTakeawayInput): Promise<string>;
  /** A.5（滚动摘要） 整块重压。 */
  compressRollingSummary(content: string): Promise<string>;
  /** C 层长期记忆 rubric（评分规则） 候选识别。 */
  generateMemoryCandidates(
    input: BrainMemoryRubricInput,
  ): Promise<readonly BrainMemoryRubricCandidate[]>;
  /** C 层长期记忆容量超限时的二次决策。 */
  resolveMemoryCapacity(input: BrainMemoryCapacityInput): Promise<BrainMemoryCapacityResolution>;
}

/** 失败任务 takeaway（要点） 输入。 */
export interface BrainFailureTakeawayInput {
  /** 任务卡。 */
  readonly task_card: BrainTaskCard;
  /** 最多 50 行 JSONL（结构化日志） 文本；无日志时用任务卡兜底。 */
  readonly log_excerpt: string;
}

/** 会话级 takeaway（要点） 输入。 */
export interface BrainSessionTakeawayInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 当前 A.5（滚动摘要） 内容。 */
  readonly rolling_summary: string;
}

/** rubric（评分规则） 候选识别输入。 */
export interface BrainMemoryRubricInput {
  /** 主人原文。 */
  readonly owner_text: string;
  /** 任务卡。 */
  readonly task_card: BrainTaskCard;
  /** 已有 bot_memory（长期记忆） 三类资产。 */
  readonly existing_memory: BotMemorySnapshot;
  /** 主人发话时坐标；用于解析“这里 / 这边 / 脚下 / 我家”等指示语。 */
  readonly owner_position?: SnapshotPosition;
}

/** rubric（评分规则） 候选识别输出项。 */
export interface BrainMemoryRubricCandidate {
  /** 记忆类型。 */
  readonly kind: BotMemoryKind;
  /** 候选内容。 */
  readonly content: string;
  /** 置信度。 */
  readonly confidence: number;
  /** 入选理由。 */
  readonly reason?: string;
}

/** 容量超限二次 LLM（大语言模型） 决策输入。 */
export interface BrainMemoryCapacityInput {
  /** 记忆类型。 */
  readonly kind: BotMemoryKind;
  /** 当前内容。 */
  readonly existing_content: string;
  /** 新候选内容。 */
  readonly candidate_content: string;
  /** 最大字符数。 */
  readonly max_chars: number;
}

/** 容量超限二次 LLM（大语言模型） 决策结果。 */
export type BrainMemoryCapacityResolution = Readonly<{
  /** 资产变更操作。 */
  readonly op: "merge" | "replace" | "delete";
  /** 写回内容；delete（删除） 可为空。 */
  readonly content: string;
  /** 决策理由。 */
  readonly reason?: string;
}>;

/** BrainWorker（大脑工作线程） LLM（大语言模型） 依赖。 */
export interface BrainWorkerLlmDependencies {
  readonly fetch?: typeof fetch;
}

/** 创建 OpenAI compatible（OpenAI 兼容） BrainWorker（大脑工作线程） LLM（大语言模型） 客户端。 */
export function createOpenAiCompatibleBrainWorkerLlmClient(
  config: ConversationLlmConfig,
  dependencies: BrainWorkerLlmDependencies = {},
): BrainWorkerLlmClient {
  const fetchImpl = dependencies.fetch ?? fetch;

  return Object.freeze({
    model: config.model,
    async generateFailureTakeaway(input: BrainFailureTakeawayInput): Promise<string> {
      assertNonEmptyString(input.log_excerpt, "log_excerpt");

      return clampSingleLine(
        await requestPlainText({
          config,
          fetchImpl,
          messages: createFailureTakeawayMessages(input),
        }),
        80,
      );
    },
    async generateSessionTakeaway(input: BrainSessionTakeawayInput): Promise<string> {
      assertNonEmptyString(input.bot_id, "bot_id");
      assertNonEmptyString(input.rolling_summary, "rolling_summary");

      return clampSingleLine(
        await requestPlainText({
          config,
          fetchImpl,
          messages: createSessionTakeawayMessages(input),
        }),
        120,
      );
    },
    async compressRollingSummary(content: string): Promise<string> {
      assertNonEmptyString(content, "content");

      return clampMultiline(
        await requestPlainText({
          config,
          fetchImpl,
          messages: createRollingSummaryCompressionMessages(content),
        }),
        1000,
      );
    },
    async generateMemoryCandidates(
      input: BrainMemoryRubricInput,
    ): Promise<readonly BrainMemoryRubricCandidate[]> {
      assertNonEmptyString(input.owner_text, "owner_text");

      return parseRubricCandidates(
        await requestPlainText({
          config,
          fetchImpl,
          messages: createMemoryRubricMessages(input),
        }),
      );
    },
    async resolveMemoryCapacity(
      input: BrainMemoryCapacityInput,
    ): Promise<BrainMemoryCapacityResolution> {
      assertNonEmptyString(input.candidate_content, "candidate_content");

      return parseMemoryCapacityResolution(
        await requestPlainText({
          config,
          fetchImpl,
          messages: createMemoryCapacityMessages(input),
        }),
        input.max_chars,
      );
    },
  });
}

function createFailureTakeawayMessages(
  input: BrainFailureTakeawayInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的任务复盘器。只输出一句中文要点，不写解释。",
    },
    {
      role: "user",
      content: [
        '基于以下任务执行日志,用一句中文写出"下次该注意什么":',
        "",
        "要求：",
        "- 保留：失败根因 / 关键决策点 / 应规避的前置条件",
        "- 去掉：坐标数字、时间戳、中间步骤",
        "- 不超过 80 字",
        "",
        "任务卡：",
        JSON.stringify({
          owner_text: input.task_card.owner_text,
          execution: input.task_card.execution,
          result:
            input.task_card.result.status === TaskHistoryStatus.Failed
              ? input.task_card.result
              : { status: input.task_card.result.status },
        }),
        "",
        "日志：",
        input.log_excerpt,
      ].join("\n"),
    },
  ]);
}

function createSessionTakeawayMessages(
  input: BrainSessionTakeawayInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的会话复盘器。只输出一句中文要点，不写标题。",
    },
    {
      role: "user",
      content: [
        "主人与 Bot 的会话已经静默 5 分钟。基于近期滚动摘要写一句会话级 takeaway。",
        "",
        "要求：",
        "- 保留：本轮会话中仍有后续价值的目标、偏好、失败教训",
        "- 去掉：临时寒暄、坐标数字、时间戳",
        "- 不超过 120 字",
        "",
        `Bot: ${input.bot_id}`,
        "",
        "近期滚动摘要：",
        input.rolling_summary,
      ].join("\n"),
    },
  ]);
}

function createRollingSummaryCompressionMessages(
  content: string,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的近期记忆压缩器。只输出压缩后的中文流水摘要。",
    },
    {
      role: "user",
      content: [
        '将以下流水摘要重新压缩为一段 ≤1000 字的中文摘要,作为 Bot 的"近期记忆"。',
        "",
        "要求：",
        "- 保留：近期反复出现的事实、未完成的事项、最近的失败/教训",
        "- 去掉：重复描述、过于细节的步骤",
        "- 输出纯流水形式,不分 section,按时间从旧到新",
        "",
        "原文：",
        content,
      ].join("\n"),
    },
  ]);
}

function createMemoryRubricMessages(
  input: BrainMemoryRubricInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的长期记忆筛选器。只输出 JSON，不输出解释。",
    },
    {
      role: "user",
      content: [
        "判断当前任务是否产生了值得长期保留的资产。",
        "",
        "输入：",
        `- 主人原句：${input.owner_text}`,
        `- 任务卡：${JSON.stringify(input.task_card)}`,
        ...(input.owner_position === undefined
          ? ["- 主人当前坐标：不可得"]
          : [
              `- 主人发话时坐标：x=${input.owner_position.x} y=${input.owner_position.y} z=${input.owner_position.z}`,
            ]),
        `- 已有 USER：${input.existing_memory.USER}`,
        `- 已有 MEMORY：${input.existing_memory.MEMORY}`,
        `- 已有 SKILL：${input.existing_memory.SKILL}`,
        "",
        "只输出 JSON，结构：",
        '{"candidates":[{"kind":"USER|MEMORY|SKILL","content":"...","confidence":0.0,"reason":"..."}]}',
        "",
        "判断规则：",
        "- 主人偏好/沟通风格 → USER",
        "- 世界/项目稳定事实（坐标、地标命名）→ MEMORY",
        "- 若主人说“这里 / 这边 / 脚下 / 我家 / 基地”且主人发话时坐标可得，必须以主人发话时坐标作为该地点坐标",
        "- 复用 SOP 流程模板（不是 ts skill，是流程套路）→ SKILL",
        "- 一次性任务结果、临时日志、TS 源码、背包 diff → confidence < 0.6 或不输出",
        "- 与现有条目冲突或更新 → 输出 kind 相同的新条目，reason 写覆盖原因",
        "- 精确重复已有条目 → 不输出",
      ].join("\n"),
    },
  ]);
}

function createMemoryCapacityMessages(
  input: BrainMemoryCapacityInput,
): readonly ConversationLlmMessage[] {
  return Object.freeze([
    {
      role: "system",
      content: "你是 Minecraft Bot 的长期记忆容量管理器。只输出 JSON。",
    },
    {
      role: "user",
      content: [
        `bot_memory.${input.kind} 超过 ${input.max_chars} 字容量。`,
        "",
        "已有内容：",
        input.existing_content,
        "",
        "新候选：",
        input.candidate_content,
        "",
        "从 merge / replace / delete 里选择一个：",
        "- merge：合并去重后保留最有长期价值的信息",
        "- replace：新候选明显覆盖旧内容时替换",
        "- delete：新候选价值不足或无法安全压缩时删除最旧/低价值信息",
        "",
        `只输出 JSON：{"op":"merge|replace|delete","content":"写回内容，必须不超过 ${input.max_chars} 字","reason":"..."}`,
      ].join("\n"),
    },
  ]);
}

async function requestPlainText(input: {
  readonly config: ConversationLlmConfig;
  readonly fetchImpl: typeof fetch;
  readonly messages: readonly ConversationLlmMessage[];
}): Promise<string> {
  const payload = await requestChatCompletionPayload({
    config: input.config,
    fetchImpl: input.fetchImpl,
    messages: input.messages,
  });

  return extractAssistantReply(payload);
}

function parseRubricCandidates(content: string): readonly BrainMemoryRubricCandidate[] {
  const record = parseJsonRecord(content);
  const rawCandidates = record.candidates;

  if (!Array.isArray(rawCandidates)) {
    throw new Error("memory rubric response must contain candidates array");
  }

  return Object.freeze(
    rawCandidates.map((candidate) => createRubricCandidateFromRecord(candidate)),
  );
}

function createRubricCandidateFromRecord(value: unknown): BrainMemoryRubricCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("memory rubric candidate must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const content = record.content;
  const confidence = record.confidence;
  const reason = record.reason;

  if (typeof kind !== "string" || !(BOT_MEMORY_KIND_VALUES as readonly string[]).includes(kind)) {
    throw new Error("memory rubric candidate kind is invalid");
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("memory rubric candidate content must be non-empty");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error("memory rubric candidate confidence must be finite");
  }
  const candidateKind = kind as BotMemoryKind;

  return Object.freeze({
    kind: candidateKind,
    content: clampSingleLine(content, 600),
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(typeof reason === "string" && reason.trim().length > 0
      ? { reason: clampSingleLine(reason, 160) }
      : {}),
  });
}

function parseMemoryCapacityResolution(
  content: string,
  maxChars: number,
): BrainMemoryCapacityResolution {
  const record = parseJsonRecord(content);
  const op = record.op;
  const resolvedContent = record.content;
  const reason = record.reason;

  if (op !== "merge" && op !== "replace" && op !== "delete") {
    throw new Error("memory capacity op must be merge, replace, or delete");
  }
  if (typeof resolvedContent !== "string") {
    throw new Error("memory capacity content must be a string");
  }

  return Object.freeze({
    op,
    content: clampMultiline(resolvedContent, maxChars),
    ...(typeof reason === "string" && reason.trim().length > 0
      ? { reason: clampSingleLine(reason, 160) }
      : {}),
  });
}

function clampSingleLine(value: string, maxChars: number): string {
  return clampByChars(value.replace(/\s+/gu, " ").trim(), maxChars);
}

function clampMultiline(value: string, maxChars: number): string {
  return clampByChars(value.trim(), maxChars);
}

function clampByChars(value: string, maxChars: number): string {
  const chars = Array.from(value);

  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join("");
}
