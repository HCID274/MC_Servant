import type {
  ConversationLlmConfig,
  ConversationLlmMessage,
  ConversationLlmToolCall,
} from "./types.js";

/** OpenAI compatible（OpenAI 兼容） function tool（函数工具） 声明。 */
export interface OpenAiCompatibleFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/** OpenAI compatible（OpenAI 兼容） chat.completions（对话补全） 请求体。 */
export interface OpenAiCompatibleChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ConversationLlmMessage[];
  readonly chat_template_kwargs?: {
    readonly enable_thinking?: boolean;
  };
  readonly reasoning_effort?: string;
  readonly tools?: readonly OpenAiCompatibleFunctionTool[];
  readonly tool_choice?: "auto" | "none";
}

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
      readonly tool_calls?: readonly ConversationLlmToolCall[];
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
  tools?: readonly OpenAiCompatibleFunctionTool[];
  tool_choice?: "auto" | "none";
}): Promise<OpenAiCompatibleChatCompletionResponse> {
  const requestBody = createChatCompletionRequestBody({
    config: input.config,
    messages: input.messages,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice }),
  });
  const response = await fetchWithTimeout(
    input.fetchImpl,
    `${input.config.base_url}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.config.api_key}`,
      },
      body: JSON.stringify(requestBody),
    },
    input.config.timeout_ms,
  );
  const payload = (await response.json()) as OpenAiCompatibleChatCompletionResponse;

  if (!response.ok) {
    throw new Error(extractOpenAiErrorMessage(payload, response.status));
  }

  return payload;
}

/** 将统一 thinking（思考） 配置转换为具体供应商请求参数。 */
export function createChatCompletionRequestBody(input: {
  config: ConversationLlmConfig;
  messages: readonly ConversationLlmMessage[];
  tools?: readonly OpenAiCompatibleFunctionTool[];
  tool_choice?: "auto" | "none";
}): OpenAiCompatibleChatCompletionRequest {
  const model = input.config.model.trim();
  const thinkingEnabled = isThinkingEnabledForModel(input.config);
  const body: OpenAiCompatibleChatCompletionRequest = {
    model,
    messages: input.messages,
    ...(isMimoModel(model)
      ? {
          chat_template_kwargs: {
            enable_thinking: thinkingEnabled,
          },
        }
      : {}),
    ...(!isMimoModel(model) && thinkingEnabled && input.config.reasoning_effort !== "none"
      ? { reasoning_effort: input.config.reasoning_effort }
      : {}),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice }),
  };

  return Object.freeze(body);
}

function isThinkingEnabledForModel(config: ConversationLlmConfig): boolean {
  const normalizedModel = normalizeModelName(config.model);

  if (
    config.force_thinking_models.some(
      (forcedModel) => normalizeModelName(forcedModel) === normalizedModel,
    )
  ) {
    return true;
  }

  return config.enable_thinking;
}

function isMimoModel(model: string): boolean {
  return normalizeModelName(model).startsWith("mimo-");
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
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
