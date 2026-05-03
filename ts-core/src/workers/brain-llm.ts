import type { ConversationLlmConfig, ConversationLlmMessage } from "../conversation/llm.js";
import { requestChatCompletionPayload } from "../conversation/llm/http.js";
import { extractAssistantReply } from "../conversation/llm/parsers.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import type { BrainTaskCard } from "../data/index.js";
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
