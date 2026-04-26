import type { ConversationLlmConfig, ConversationLlmMessage } from "./types.js";

/** OpenAI 兼容 chat.completions（对话补全） 响应的最小结构。 */
export interface OpenAiCompatibleChatCompletionResponse {
  /** 候选回复集合。 */
  readonly choices?: ReadonlyArray<{
    /** assistant（助手） 消息。 */
    readonly message?: {
      /** 回复文本或分片文本。 */
      readonly content?:
        | string
        | ReadonlyArray<{
            /** 分片类型。 */
            readonly type?: string;
            /** 文本分片。 */
            readonly text?: string;
          }>;
    };
  }>;
  /** token（令牌） 用量。 */
  readonly usage?: {
    /** 输入 token（令牌） 数。 */
    readonly prompt_tokens?: number;
    /** 输出 token（令牌） 数。 */
    readonly completion_tokens?: number;
  };
  /** 错误载荷。 */
  readonly error?: {
    /** 错误消息。 */
    readonly message?: string;
  };
}

/** 发起一次最小 OpenAI 兼容 chat.completions（对话补全） 请求。 */
export async function requestChatCompletionPayload(input: {
  fetchImpl: typeof fetch;
  config: ConversationLlmConfig;
  messages: readonly ConversationLlmMessage[];
}): Promise<OpenAiCompatibleChatCompletionResponse> {
  const response = await fetchWithTimeout(
    input.fetchImpl,
    `${input.config.base_url}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.config.api_key}`,
      },
      body: JSON.stringify({
        model: input.config.model,
        messages: input.messages,
      }),
    },
    input.config.timeout_ms,
  );
  const payload = (await response.json()) as OpenAiCompatibleChatCompletionResponse;

  if (!response.ok) {
    throw new Error(extractOpenAiErrorMessage(payload, response.status));
  }

  return payload;
}

/** 提取 OpenAI 兼容错误摘要。 */
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

/** 以超时保护执行 fetch（网络请求）。 */
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
