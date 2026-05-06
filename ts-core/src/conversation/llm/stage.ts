import type { BrainSearchInput } from "../../data/contracts/index.js";
import type { LlmCallMetrics, LlmLogStage } from "../../diagnostics/contracts.js";
import { createLlmLogLine, createLlmLogRef } from "../../diagnostics/logs.js";
import { BRAIN_SEARCH_MAX_TOOL_ROUNDS, createBrainSearchToolResult } from "../brain-context.js";
import {
  createConversationLlmDiagnosticRecord,
  createErrorSnapshot,
  createLlmInvocationLines,
  createUnixSeconds,
} from "./diagnostics.js";
import type {
  OpenAiCompatibleChatCompletionResponse,
  OpenAiCompatibleFunctionTool,
} from "./http.js";
import { requestChatCompletionPayload } from "./http.js";
import { extractAssistantReply, extractAssistantToolCalls } from "./parsers.js";
import type { ConversationLlmSearchTool } from "./types.js";
import type {
  ConversationLlmConfig,
  ConversationLlmDependencies,
  ConversationLlmDiagnosticRecord,
  ConversationLlmMessage,
} from "./types.js";

/** LLM（大语言模型） 阶段执行器的公共依赖。 */
export interface ConversationLlmStageRuntime {
  /** LLM（大语言模型） 配置。 */
  readonly config: ConversationLlmConfig;
  /** 可注入 fetch（网络请求） 实现。 */
  readonly fetchImpl: typeof fetch;
  /** 当前时间来源。 */
  readonly now: () => Date;
  /** 诊断回调。 */
  readonly onDiagnostic?: ConversationLlmDependencies["onDiagnostic"];
  /** 单调时钟，用于性能分段统计。 */
  readonly monotonicNow?: () => number;
}

/** LLM（大语言模型） 阶段执行输入。 */
export interface ConversationLlmStageInput<TResult> extends ConversationLlmStageRuntime {
  /** 当前阶段。 */
  readonly stage: LlmLogStage;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 已组装的 OpenAI（开放人工智能） 兼容消息。 */
  readonly messages: readonly ConversationLlmMessage[];
  /** 队列等待耗时。 */
  readonly queue_wait_ms?: number;
  /** prompt（提示词）构建耗时。 */
  readonly prompt_build_ms?: number;
  /** assistant（助手） 文本解析器。 */
  readonly parse: (content: string) => TResult;
  /** 失败策略。 */
  readonly onFailure: (input: ConversationLlmStageFailure) => TResult | Promise<TResult>;
  /** 可选 search() tool（工具）；仅 Stage 2-Chat / Stage 2-Plan 使用。 */
  readonly searchTool?: ConversationLlmSearchTool;
  /** search() tool（工具） 所属 Bot（机器人） 标识。 */
  readonly searchToolBotId?: string;
  /** search 工具最多执行次数；未指定时使用 Brain 默认上限。 */
  readonly searchToolMaxCalls?: number;
}

/** LLM（大语言模型） 阶段失败上下文。 */
export interface ConversationLlmStageFailure {
  /** 原始错误。 */
  readonly error: unknown;
  /** 失败诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
  /** 脱敏后的错误快照。 */
  readonly errorSnapshot: ReturnType<typeof createErrorSnapshot>;
}

/** LLM（大语言模型） 阶段成功结果。 */
export interface ConversationLlmStageSuccess<TResult> {
  /** 解析后的阶段结果。 */
  readonly value: TResult;
  /** 成功诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;
}

/**
 * 执行单个 LLM（大语言模型） 阶段。
 *
 * 统一 startedAt（开始时间）、日志引用、请求、token（令牌） 统计、成功诊断与失败诊断，调用方只保留消息构建、解析和失败策略差异。
 */
export async function executeStage<TResult>(
  input: ConversationLlmStageInput<TResult>,
): Promise<ConversationLlmStageSuccess<TResult>> {
  const startedAt = input.now();
  const startedAtMs = startedAt.getTime();
  const monotonicNow = input.monotonicNow ?? createDefaultMonotonicNow;
  const stageStartedAt = monotonicNow();
  const logRef = createLlmLogRef({
    date: startedAt.toISOString().slice(0, 10),
    stage: input.stage,
    message_id: input.message_id,
  });
  const invocationLines = createLlmInvocationLines({
    t: createUnixSeconds(startedAt),
    stage: input.stage,
    model: input.config.model,
    message_id: input.message_id,
    messages: input.messages,
  });
  let latestPayload: Awaited<ReturnType<typeof requestChatCompletionPayload>> | undefined;
  let latestRequestTotalMs = 0;
  let latestResponseParseMs = 0;
  let latestToolRoundMs: readonly number[] = [];
  let latestExtraLines: readonly ReturnType<typeof createLlmLogLine>[] = [];

  try {
    const toolExecution = await executeSearchToolLoop(input, monotonicNow);
    let payload = toolExecution.payload;
    latestPayload = payload;
    latestRequestTotalMs = toolExecution.requestTotalMs;
    latestToolRoundMs = toolExecution.toolRoundMs;
    latestExtraLines = toolExecution.extraLines;
    const parseStartedAt = monotonicNow();
    let value: TResult;
    try {
      try {
        value = input.parse(extractAssistantReply(payload));
      } catch (error) {
        if (!shouldRetryWithoutSearch(input, toolExecution, error)) {
          throw error;
        }

        const retryExecution = await executeSearchToolLoop(
          createStageInputWithoutSearch(input),
          monotonicNow,
        );
        payload = retryExecution.payload;
        latestPayload = payload;
        latestRequestTotalMs += retryExecution.requestTotalMs;
        latestExtraLines = Object.freeze([
          ...toolExecution.extraLines,
          ...retryExecution.extraLines,
        ]);
        value = input.parse(extractAssistantReply(payload));
      }
    } finally {
      latestResponseParseMs = elapsedMs(monotonicNow, parseStartedAt);
    }
    const finishedAt = input.now();
    const metrics = createLlmCallMetrics({
      input,
      payload,
      request_total_ms: toolExecution.requestTotalMs,
      response_parse_ms: latestResponseParseMs,
      tool_round_ms: toolExecution.toolRoundMs,
    });
    const diagnostics = createConversationLlmDiagnosticRecord({
      stage: input.stage,
      model: input.config.model,
      message_id: input.message_id,
      log_ref: logRef,
      created_at: finishedAt.toISOString(),
      ok: true,
      metrics,
      lines: [
        ...invocationLines,
        ...latestExtraLines,
        createLlmLogLine({
          t: createUnixSeconds(finishedAt),
          meta: {
            input_tokens: payload.usage?.prompt_tokens ?? 0,
            output_tokens: payload.usage?.completion_tokens ?? 0,
            ms: Math.max(0, finishedAt.getTime() - startedAtMs),
            ok: true,
            metrics,
          },
        }),
      ],
    });

    await input.onDiagnostic?.(diagnostics);

    return Object.freeze({
      value,
      diagnostics,
    });
  } catch (error) {
    const finishedAt = input.now();
    const errorSnapshot = createErrorSnapshot(error);
    const metrics = createLlmCallMetrics({
      input,
      ...(latestPayload === undefined ? {} : { payload: latestPayload }),
      request_total_ms:
        latestRequestTotalMs > 0 ? latestRequestTotalMs : elapsedMs(monotonicNow, stageStartedAt),
      response_parse_ms: latestResponseParseMs,
      tool_round_ms: latestToolRoundMs,
    });
    const diagnostics = createConversationLlmDiagnosticRecord({
      stage: input.stage,
      model: input.config.model,
      message_id: input.message_id,
      log_ref: logRef,
      created_at: finishedAt.toISOString(),
      ok: false,
      metrics,
      error_summary: errorSnapshot.message,
      lines: [
        ...invocationLines,
        ...latestExtraLines,
        createLlmLogLine({
          t: createUnixSeconds(finishedAt),
          meta: {
            input_tokens: 0,
            output_tokens: 0,
            ms: Math.max(0, finishedAt.getTime() - startedAtMs),
            ok: false,
            metrics,
          },
          err: errorSnapshot,
        }),
      ],
    });

    await input.onDiagnostic?.(diagnostics);

    return Object.freeze({
      value: await input.onFailure({
        error,
        diagnostics,
        errorSnapshot,
      }),
      diagnostics,
    });
  }
}

async function executeSearchToolLoop<TResult>(
  input: ConversationLlmStageInput<TResult>,
  monotonicNow: () => number,
): Promise<{
  readonly payload: Awaited<ReturnType<typeof requestChatCompletionPayload>>;
  readonly extraLines: readonly ReturnType<typeof createLlmLogLine>[];
  readonly requestTotalMs: number;
  readonly toolRoundMs: readonly number[];
}> {
  if (input.searchTool === undefined) {
    const requestStartedAt = monotonicNow();
    const payload = await requestChatCompletionPayload({
      fetchImpl: input.fetchImpl,
      config: input.config,
      messages: input.messages,
    });
    const requestMs = elapsedMs(monotonicNow, requestStartedAt);

    return Object.freeze({
      payload,
      extraLines: [createAssistantTranscriptLine(payload, input.now())],
      requestTotalMs: requestMs,
      toolRoundMs: Object.freeze([]),
    });
  }

  let messages = [...input.messages];
  const extraLines: ReturnType<typeof createLlmLogLine>[] = [];
  const toolRoundMs: number[] = [];
  let requestTotalMs = 0;
  let executedSearchCalls = 0;
  const maxSearchCalls = Math.max(0, input.searchToolMaxCalls ?? BRAIN_SEARCH_MAX_TOOL_ROUNDS);

  for (let round = 0; round <= maxSearchCalls; round += 1) {
    const roundStartedAt = monotonicNow();
    const requestStartedAt = monotonicNow();
    const payload = await requestChatCompletionPayload({
      fetchImpl: input.fetchImpl,
      config: input.config,
      messages,
      tools: [SEARCH_TOOL_DEFINITION],
      tool_choice: executedSearchCalls >= maxSearchCalls ? "none" : "auto",
    });
    requestTotalMs += elapsedMs(monotonicNow, requestStartedAt);
    const toolCalls = extractAssistantToolCalls(payload)
      .filter((toolCall) => toolCall.function.name === "search")
      .slice(0, Math.max(0, maxSearchCalls - executedSearchCalls));

    if (toolCalls.length === 0 || executedSearchCalls >= maxSearchCalls) {
      extraLines.push(createAssistantTranscriptLine(payload, input.now()));

      return Object.freeze({
        payload,
        extraLines,
        requestTotalMs,
        toolRoundMs: Object.freeze([...toolRoundMs]),
      });
    }

    extraLines.push(createAssistantTranscriptLine(payload, input.now()));

    messages = [
      ...messages,
      Object.freeze({
        role: "assistant",
        content: "",
        tool_calls: toolCalls,
      }),
    ];

    for (const toolCall of toolCalls) {
      const searchInput = parseSearchToolInput({
        bot_id: input.searchToolBotId ?? "",
        rawArguments: toolCall.function.arguments,
      });
      const content = await executeSearchToolCall({
        searchTool: input.searchTool,
        searchInput,
      });
      messages.push(
        Object.freeze({
          role: "tool",
          tool_call_id: toolCall.id,
          content,
        }),
      );
      extraLines.push(
        createLlmLogLine({
          t: createUnixSeconds(input.now()),
          role: "tool",
          content,
        }),
      );
    }
    toolRoundMs.push(elapsedMs(monotonicNow, roundStartedAt));
    executedSearchCalls += toolCalls.length;
  }

  throw new Error("search tool loop failed to produce final response");
}

function shouldRetryWithoutSearch<TResult>(
  input: ConversationLlmStageInput<TResult>,
  toolExecution: {
    readonly toolRoundMs: readonly number[];
  },
  error: unknown,
): boolean {
  return (
    input.stage === "plan" &&
    input.searchTool !== undefined &&
    toolExecution.toolRoundMs.length > 0 &&
    error instanceof Error &&
    error.message === "LLM response does not contain assistant text"
  );
}

function createStageInputWithoutSearch<TResult>(
  input: ConversationLlmStageInput<TResult>,
): ConversationLlmStageInput<TResult> {
  const {
    searchTool: _searchTool,
    searchToolBotId: _searchToolBotId,
    searchToolMaxCalls: _searchToolMaxCalls,
    ...rest
  } = input;

  return rest;
}

function createLlmCallMetrics(input: {
  readonly input: Pick<ConversationLlmStageInput<unknown>, "queue_wait_ms" | "prompt_build_ms">;
  readonly payload?: Awaited<ReturnType<typeof requestChatCompletionPayload>>;
  readonly request_total_ms: number;
  readonly response_parse_ms: number;
  readonly tool_round_ms: readonly number[];
}): LlmCallMetrics {
  const inputTokens = input.payload?.usage?.prompt_tokens ?? 0;
  const outputTokens = input.payload?.usage?.completion_tokens ?? 0;
  const denominatorSeconds = Math.max(0.001, input.request_total_ms / 1000);

  return Object.freeze({
    queue_wait_ms: normalizeDuration(input.input.queue_wait_ms ?? 0),
    prompt_build_ms: normalizeDuration(input.input.prompt_build_ms ?? 0),
    request_total_ms: normalizeDuration(input.request_total_ms),
    response_parse_ms: normalizeDuration(input.response_parse_ms),
    tool_round_count: input.tool_round_ms.length,
    tool_round_ms: Object.freeze(input.tool_round_ms.map(normalizeDuration)),
    diagnostics_write_ms: null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tokens_per_second: normalizeDuration(outputTokens / denominatorSeconds),
    ttft_ms: null,
    ttft_unavailable: "non_streaming",
  });
}

function createDefaultMonotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function elapsedMs(now: () => number, startedAt: number): number {
  return normalizeDuration(now() - startedAt);
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}

function createAssistantTranscriptLine(
  payload: Awaited<ReturnType<typeof requestChatCompletionPayload>>,
  now: Date,
): ReturnType<typeof createLlmLogLine> {
  const message = payload.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];

  return createLlmLogLine({
    t: createUnixSeconds(now),
    role: "assistant" as const,
    content: normalizeAssistantContentForLog(message?.content),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  });
}

function normalizeAssistantContentForLog(
  content: NonNullable<
    NonNullable<OpenAiCompatibleChatCompletionResponse["choices"]>[number]["message"]
  >["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
  }

  return "";
}

async function executeSearchToolCall(input: {
  readonly searchTool: ConversationLlmSearchTool;
  readonly searchInput: BrainSearchInput;
}): Promise<string> {
  try {
    return createBrainSearchToolResult({
      query: input.searchInput.query,
      result: await input.searchTool(input.searchInput),
    });
  } catch (error) {
    return JSON.stringify({
      query: input.searchInput.query,
      hits: [],
      error: error instanceof Error ? error.message : "brain.search failed",
    });
  }
}

const SEARCH_TOOL_DEFINITION = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "search",
    description: "查找长期任务历史。仅在 A.5 滚动摘要 / C 层 MEMORY 不够回答主人问题时使用",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({ type: "string", description: "自然语言查询" }),
        kinds: Object.freeze({
          type: "array",
          items: Object.freeze({ enum: ["task", "takeaway"] }),
          description: "默认两者都查",
        }),
        top_k: Object.freeze({ type: "integer", default: 5, maximum: 10 }),
      }),
      required: ["query"],
    }),
  }),
} satisfies OpenAiCompatibleFunctionTool);

function parseSearchToolInput(input: {
  readonly bot_id: string;
  readonly rawArguments: string;
}): BrainSearchInput {
  const parsed = JSON.parse(input.rawArguments) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("search tool arguments must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim().length === 0) {
    throw new Error("search tool query must be a non-empty string");
  }

  return Object.freeze({
    bot_id: input.bot_id,
    query: record.query.trim(),
    ...(Array.isArray(record.kinds)
      ? {
          kinds: record.kinds.filter(
            (kind): kind is "task" | "takeaway" => kind === "task" || kind === "takeaway",
          ),
        }
      : {}),
    ...(typeof record.top_k === "number" ? { top_k: record.top_k } : {}),
  });
}
