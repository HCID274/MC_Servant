import { describe, expect, it } from "vitest";

import { createAppEmbeddingConfigFromEnvironment } from "../app/bootstrap/env.js";
import { createAppOnlineRuntimeDependenciesFromEnvironment } from "../main.js";

describe("createAppEmbeddingConfigFromEnvironment", () => {
  it("应在全部环境变量缺失时返回 undefined", () => {
    const result = createAppEmbeddingConfigFromEnvironment({ env: {} });

    expect(result).toBeUndefined();
  });

  it("应在 endpoint_url + api_key 齐全时返回正确配置", () => {
    const result = createAppEmbeddingConfigFromEnvironment({
      env: {
        EMBEDDING_ENDPOINT_URL: "https://embedding.local/v1/embeddings",
        EMBEDDING_API_KEY: "sk-emb",
        EMBEDDING_MODEL: "text-embedding-v4",
      },
    });

    expect(result).toEqual({
      endpoint_url: "https://embedding.local/v1/embeddings",
      api_key: "sk-emb",
      model: "text-embedding-v4",
    });
  });

  it("应在 base_url + api_key 齐全时返回正确配置", () => {
    const result = createAppEmbeddingConfigFromEnvironment({
      env: {
        EMBEDDING_BASE_URL: "https://llm.local/v1",
        EMBEDDING_API_KEY: "sk-emb",
      },
    });

    expect(result).toEqual({
      base_url: "https://llm.local/v1",
      api_key: "sk-emb",
    });
  });

  it("应在 endpoint_url 和 base_url 同时存在时全部保留", () => {
    const result = createAppEmbeddingConfigFromEnvironment({
      env: {
        EMBEDDING_ENDPOINT_URL: "https://embedding.local/v1/embeddings",
        EMBEDDING_BASE_URL: "https://llm.local/v1",
        EMBEDDING_API_KEY: "sk-emb",
      },
    });

    expect(result).toEqual({
      endpoint_url: "https://embedding.local/v1/embeddings",
      base_url: "https://llm.local/v1",
      api_key: "sk-emb",
    });
  });

  it("应在有 endpoint 但缺 api_key 时抛出", () => {
    expect(() =>
      createAppEmbeddingConfigFromEnvironment({
        env: {
          EMBEDDING_ENDPOINT_URL: "https://embedding.local/v1/embeddings",
        },
      }),
    ).toThrow("EMBEDDING_API_KEY must be configured when embedding is enabled");
  });

  it("应在有 api_key 但缺 endpoint 和 base_url 时抛出", () => {
    expect(() =>
      createAppEmbeddingConfigFromEnvironment({
        env: {
          EMBEDDING_API_KEY: "sk-emb",
        },
      }),
    ).toThrow(
      "EMBEDDING_ENDPOINT_URL or EMBEDDING_BASE_URL must be configured when embedding is enabled",
    );
  });

  it("应在仅有 model 时要求 endpoint 和 api_key", () => {
    expect(() =>
      createAppEmbeddingConfigFromEnvironment({
        env: {
          EMBEDDING_MODEL: "text-embedding-v4",
        },
      }),
    ).toThrow(
      "EMBEDDING_ENDPOINT_URL or EMBEDDING_BASE_URL must be configured when embedding is enabled",
    );
  });

  it("应在主程依赖装配中传入独立 embedding（向量）配置", () => {
    const result = createAppOnlineRuntimeDependenciesFromEnvironment({
      env: {
        LLM_API_KEY: "sk-llm",
        EMBEDDING_ENDPOINT_URL: "https://embedding.local/v1/embeddings",
        EMBEDDING_API_KEY: "sk-emb",
        EMBEDDING_MODEL: "text-embedding-v4",
      },
    });

    expect(result.llm).toEqual({ api_key: "sk-llm" });
    expect(result.embedding).toEqual({
      endpoint_url: "https://embedding.local/v1/embeddings",
      api_key: "sk-emb",
      model: "text-embedding-v4",
    });
  });
});
