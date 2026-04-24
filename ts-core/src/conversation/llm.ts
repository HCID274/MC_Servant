/**
 * OpenAI（开放人工智能） 兼容闲聊调用适配。
 *
 * 1. 最短闭环：封装 `POST /chat/completions`（对话补全接口） 的最小请求与响应解析。
 * 2. 诊断留痕：为每次调用生成 `llm`（大语言模型） JSONL（结构化日志） 摘要，覆盖阶段、模型、成功与失败信息。
 * 3. 入口收口：只负责 Stage 2-Chat（闲聊回复） 路径，不冒充规划器或分诊器。
 */

import type { JsonlErrorSnapshot, LlmJsonlLine } from "../diagnostics/contracts.js";
import { createLlmLogLine, createLlmLogRef } from "../diagnostics/logs.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import type { ConversationHistoryTurn, ConversationReplyMode } from "./contracts.js";

/** OpenAI（开放人工智能） 兼容闲聊客户端配置。 */
export interface ConversationLlmConfig {
  /** OpenAI（开放人工智能） 兼容基础地址。 */
  readonly base_url: string;
  /** OpenAI（开放人工智能） 兼容接口密钥。 */
  readonly api_key: string;
  /** 默认模型名。 */
  readonly model: string;
  /** 默认 Bot 名称。 */
  readonly bot_name: string;
  /** 默认主人称谓。 */
  readonly owner_name: string;
  /** 单次请求超时。 */
  readonly timeout_ms: number;
}

/** 单条 OpenAI（开放人工智能） 兼容对话消息。 */
export interface ConversationLlmMessage {
  /** 消息角色。 */
  readonly role: "system" | "user" | "assistant";
  /** 消息文本。 */
  readonly content: string;
}

/** 闲聊调用的诊断摘要。 */
export interface ConversationLlmDiagnosticRecord {
  /** 调用阶段。 */
  readonly stage: "chat";
  /** 模型名。 */
  readonly model: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 结构化日志引用。 */
  readonly log_ref: string;
  /** 是否成功。 */
  readonly ok: boolean;
  /** 失败摘要。 */
  readonly error_summary?: string;
  /** 本次调用生成的 JSONL（结构化日志） 行。 */
  readonly lines: readonly LlmJsonlLine[];
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
  /** 可选记忆摘要。 */
  readonly memory_context?: string;
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

/** OpenAI（开放人工智能） 兼容聊天请求依赖。 */
export interface ConversationLlmDependencies {
  /** 可注入 fetch（网络请求） 实现。 */
  readonly fetch?: typeof fetch;
  /** 可注入当前时间。 */
  readonly now?: () => Date;
  /** 诊断回调。 */
  readonly onDiagnostic?: (record: ConversationLlmDiagnosticRecord) => void | Promise<void>;
}

/** 闲聊客户端暴露的最小能力。 */
export interface ConversationLlmClient {
  /** 基于真实 OpenAI（开放人工智能） 兼容接口生成闲聊回复。 */
  generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult>;
}

/** 闲聊调用失败错误；包含最小诊断摘要。 */
export class ConversationLlmChatError extends Error {
  /** 失败时已生成的诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;

  /**
   * 创建携带诊断摘要的闲聊调用错误。
   *
   * @param message 错误消息
   * @param diagnostics 失败诊断
   * @param options 原始 cause（原因）
   */
  constructor(
    message: string,
    diagnostics: ConversationLlmDiagnosticRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationLlmChatError";
    this.diagnostics = diagnostics;
  }
}

/** 创建只读的 OpenAI（开放人工智能） 兼容配置。 */
export function createConversationLlmConfig(
  input: Omit<ConversationLlmConfig, "base_url"> & {
    /** OpenAI（开放人工智能） 兼容基础地址。 */
    readonly base_url: string;
  },
): ConversationLlmConfig {
  assertNonEmptyString(input.base_url, "base_url");
  assertNonEmptyString(input.api_key, "api_key");
  assertNonEmptyString(input.model, "model");
  assertNonEmptyString(input.bot_name, "bot_name");
  assertNonEmptyString(input.owner_name, "owner_name");

  if (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0) {
    throw new Error("timeout_ms must be a positive number");
  }

  return Object.freeze({
    base_url: input.base_url.replace(/\/+$/u, ""),
    api_key: input.api_key.trim(),
    model: input.model.trim(),
    bot_name: input.bot_name.trim(),
    owner_name: input.owner_name.trim(),
    timeout_ms: input.timeout_ms,
  });
}

/** 组装 Stage 2-Chat（闲聊回复） 的最小消息列表。 */
export function createConversationChatMessages(
  input: ConversationLlmChatInput & Pick<ConversationLlmConfig, "bot_name" | "owner_name">,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const botName = input.bot_name.trim();
  const ownerName = input.owner_name.trim();
  const historyMessages =
    input.history?.flatMap<ConversationLlmMessage>((turn) => {
      const role = turn.role === "bot" ? "assistant" : "user";
      const content =
        turn.role === "bot" ? `[${botName}] ${turn.content}` : `[${ownerName}] ${turn.content}`;

      return Object.freeze([
        Object.freeze({
          role,
          content,
        }),
      ]);
    }) ?? [];

  const systemSections = [
    `你是 ${botName}，一个在 Minecraft 中的贴心猫娘女仆。你的主人是 ${ownerName}。`,
    "绝对规则：",
    "- 每句回复结尾必须加“喵”或“喵~”",
    "- 回复简短自然，不超过 3 句话",
    "- 不要输出 JSON，不要输出动作计划，只说话",
    ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
  ];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: systemSections.join("\n"),
    }),
    ...historyMessages,
    Object.freeze({
      role: "user",
      content: `[${ownerName}] ${input.message}`,
    }),
  ]);
}

/** 创建 OpenAI（开放人工智能） 兼容闲聊客户端。 */
export function createConversationLlmClient(
  config: ConversationLlmConfig,
  dependencies: ConversationLlmDependencies = {},
): ConversationLlmClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async generateChatReply(input: ConversationLlmChatInput): Promise<ConversationLlmChatResult> {
      const startedAt = now();
      const startedAtMs = startedAt.getTime();
      const messages = createConversationChatMessages({
        ...input,
        bot_name: input.bot_name ?? config.bot_name,
        owner_name: input.owner_name ?? config.owner_name,
      });
      const logRef = createLlmLogRef({
        date: startedAt.toISOString().slice(0, 10),
        stage: "chat",
        message_id: input.message_id,
      });
      const invocationLines = Object.freeze([
        createLlmLogLine({
          t: createUnixSeconds(startedAt),
          stage: "chat",
          model: config.model,
          msg_id: input.message_id,
        }),
        ...messages.map((message) =>
          createLlmLogLine({
            t: createUnixSeconds(startedAt),
            role: message.role,
            content: message.content,
          }),
        ),
      ]);

      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          `${config.base_url}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.api_key}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages,
            }),
          },
          config.timeout_ms,
        );
        const payload = (await response.json()) as OpenAiCompatibleChatCompletionResponse;

        if (!response.ok) {
          throw new Error(extractOpenAiErrorMessage(payload, response.status));
        }

        const reply = extractAssistantReply(payload);
        const finishedAt = now();
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
          ok: true,
          lines: [
            ...invocationLines,
            createLlmLogLine({
              t: createUnixSeconds(finishedAt),
              meta: {
                input_tokens: payload.usage?.prompt_tokens ?? 0,
                output_tokens: payload.usage?.completion_tokens ?? 0,
                ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                ok: true,
              },
            }),
          ],
        });

        await dependencies.onDiagnostic?.(diagnostics);

        return Object.freeze({
          mode: "llm",
          reply,
          diagnostics,
        });
      } catch (error) {
        const finishedAt = now();
        const errorSnapshot = createErrorSnapshot(error);
        const diagnostics = createConversationLlmDiagnosticRecord({
          stage: "chat",
          model: config.model,
          message_id: input.message_id,
          log_ref: logRef,
          ok: false,
          error_summary: errorSnapshot.message,
          lines: [
            ...invocationLines,
            createLlmLogLine({
              t: createUnixSeconds(finishedAt),
              meta: {
                input_tokens: 0,
                output_tokens: 0,
                ms: Math.max(0, finishedAt.getTime() - startedAtMs),
                ok: false,
              },
              err: errorSnapshot,
            }),
          ],
        });

        await dependencies.onDiagnostic?.(diagnostics);

        throw new ConversationLlmChatError(errorSnapshot.message, diagnostics, {
          cause: error,
        });
      }
    },
  });
}

/**
 * 创建只读诊断摘要。
 *
 * @param input 原始诊断输入
 * @returns 冻结后的诊断对象
 */
function createConversationLlmDiagnosticRecord(
  input: ConversationLlmDiagnosticRecord,
): ConversationLlmDiagnosticRecord {
  return Object.freeze({
    ...input,
    lines: Object.freeze([...input.lines]),
  });
}

/**
 * 提取 OpenAI（开放人工智能） 兼容返回中的回复文本。
 *
 * @param payload 接口返回
 * @returns 第一条 assistant（助手） 回复文本
 */
function extractAssistantReply(payload: OpenAiCompatibleChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("LLM response does not contain assistant text");
}

/**
 * 提取 OpenAI（开放人工智能） 兼容错误摘要。
 *
 * @param payload 接口返回
 * @param status HTTP（超文本传输协议） 状态码
 * @returns 可读错误摘要
 */
function extractOpenAiErrorMessage(
  payload: OpenAiCompatibleChatCompletionResponse,
  status: number,
): string {
  const message = payload.error?.message;

  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }

  return `LLM request failed with status ${status}`;
}

/**
 * 将未知错误转换为 JSONL（结构化日志） 错误快照。
 *
 * @param error 原始错误
 * @returns 只读错误快照
 */
function createErrorSnapshot(error: unknown): JsonlErrorSnapshot {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name,
      message: error.message,
    });
  }

  return Object.freeze({
    name: "UnknownError",
    message: "Unknown LLM request error",
  });
}

/**
 * 以超时保护执行 fetch（网络请求）。
 *
 * @param fetchImpl 注入的 fetch（网络请求） 实现
 * @param input 请求地址
 * @param init 请求参数
 * @param timeoutMs 超时毫秒
 * @returns fetch（网络请求） 返回值
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("LLM request timed out"));
  }, timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 创建 Unix 时间戳（秒）。
 *
 * @param value 时间对象
 * @returns 秒级时间戳
 */
function createUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

interface OpenAiCompatibleChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?:
        | string
        | ReadonlyArray<{
            readonly type?: string;
            readonly text?: string;
          }>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly error?: {
    readonly message?: string;
  };
}
