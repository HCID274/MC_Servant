import { assertNonEmptyString } from "../domain/invariants.js";

/** OpenAI compatible（OpenAI 兼容） embeddings（向量嵌入） 请求体。 */
export interface OpenAiCompatibleEmbeddingRequest {
  readonly model: string;
  readonly input: string;
  readonly dimensions?: number;
}

/** OpenAI compatible（OpenAI 兼容） embeddings（向量嵌入） 响应体最小结构。 */
export interface OpenAiCompatibleEmbeddingResponse {
  readonly data?: ReadonlyArray<{
    readonly embedding?: readonly number[];
  }>;
  readonly error?: {
    readonly message?: string;
  };
}

/** Embedding API（向量接口） 配置。 */
export interface EmbeddingClientConfig {
  /** OpenAI compatible（OpenAI 兼容） base URL（基础地址），例如 http://127.0.0.1:8045/v1。 */
  readonly base_url?: string;
  /** 完整 embeddings endpoint（向量端点），配置后优先于 base_url。 */
  readonly endpoint_url?: string;
  readonly api_key: string;
  readonly model: string;
  readonly dimensions: number;
  readonly timeout_ms: number;
}

interface NormalizedEmbeddingClientConfig {
  readonly endpoint_url: string;
  readonly api_key: string;
  readonly model: string;
  readonly dimensions: number;
  readonly timeout_ms: number;
}

/** Embedding API（向量接口） 依赖注入。 */
export interface EmbeddingClientDependencies {
  readonly fetch?: typeof fetch;
}

/** BrainWorker（大脑工作线程） 使用的 embedding（向量嵌入）生成器。 */
export type TaskEventEmbeddingGenerator = (text: string) => Promise<readonly number[]>;

/** 创建 OpenAI compatible（OpenAI 兼容） embedding（向量嵌入）客户端。 */
export function createOpenAiCompatibleEmbeddingGenerator(
  config: EmbeddingClientConfig,
  dependencies: EmbeddingClientDependencies = {},
): TaskEventEmbeddingGenerator {
  const normalizedConfig = createEmbeddingClientConfig(config);
  const fetchImpl = dependencies.fetch ?? fetch;

  return async (text) => requestEmbeddingVector({ config: normalizedConfig, fetchImpl, text });
}

function createEmbeddingClientConfig(
  input: EmbeddingClientConfig,
): NormalizedEmbeddingClientConfig {
  assertNonEmptyString(input.api_key, "api_key");
  assertNonEmptyString(input.model, "model");

  if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
    throw new Error("dimensions must be a positive integer");
  }
  if (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0) {
    throw new Error("timeout_ms must be positive");
  }

  const endpointUrl = resolveEmbeddingEndpointUrl(input);

  return Object.freeze({
    endpoint_url: endpointUrl,
    api_key: input.api_key.trim(),
    model: input.model.trim(),
    dimensions: input.dimensions,
    timeout_ms: input.timeout_ms,
  });
}

function resolveEmbeddingEndpointUrl(input: EmbeddingClientConfig): string {
  if (input.endpoint_url !== undefined) {
    assertNonEmptyString(input.endpoint_url, "endpoint_url");

    return input.endpoint_url.trim().replace(/\/+$/u, "");
  }

  if (input.base_url === undefined) {
    throw new Error("base_url or endpoint_url must be configured for embedding");
  }
  assertNonEmptyString(input.base_url, "base_url");

  const baseUrl = input.base_url.trim().replace(/\/+$/u, "");

  return baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
}

async function requestEmbeddingVector(input: {
  readonly config: NormalizedEmbeddingClientConfig;
  readonly fetchImpl: typeof fetch;
  readonly text: string;
}): Promise<readonly number[]> {
  assertNonEmptyString(input.text, "text");

  const requestBody = Object.freeze({
    model: input.config.model,
    input: input.text,
    dimensions: input.config.dimensions,
  } satisfies OpenAiCompatibleEmbeddingRequest);
  const response = await fetchWithTimeout(
    input.fetchImpl,
    input.config.endpoint_url,
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
  const payload = (await response.json()) as OpenAiCompatibleEmbeddingResponse;

  if (!response.ok) {
    throw new Error(extractEmbeddingErrorMessage(payload, response.status));
  }

  const embedding = payload.data?.[0]?.embedding;
  if (embedding === undefined) {
    throw new Error("Embedding response missing data[0].embedding");
  }
  if (embedding.length !== input.config.dimensions) {
    throw new Error(
      `Embedding response dimension mismatch: expected ${input.config.dimensions}, got ${embedding.length}`,
    );
  }

  return Object.freeze([...embedding]);
}

function extractEmbeddingErrorMessage(
  payload: OpenAiCompatibleEmbeddingResponse,
  status: number,
): string {
  const message = payload.error?.message;

  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : `Embedding request failed with status ${status}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("Embedding request timed out"));
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
