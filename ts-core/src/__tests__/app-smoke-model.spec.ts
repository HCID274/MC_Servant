import { describe, expect, it } from "vitest";

import {
  assertAppLifecyclePlan,
  createAppBootstrapContract,
  createAppSmokeAssembly,
} from "../app/index.js";

describe("app（应用装配） 骨架", () => {
  it("应生成对齐启动 / 关闭顺序的组合根", () => {
    const assembly = createAppBootstrapContract({
      botId: "bot-app",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        PG_HOST: "pg.internal",
        PG_PORT: "5433",
        PG_DATABASE: "mc_servant",
        PG_USER: "servant",
        REDIS_URL: "redis://cache.internal:6380",
        LOGS_BASE_DIR: "./app-logs",
      },
    });

    expect(assembly.postgres.host).toBe("pg.internal");
    expect(assembly.postgres.port).toBe(5433);
    expect(assembly.redis.state).toBe("bot:bot-app:state");
    expect(assembly.workers.conversation.queue).toBe("msg:bot-app");
    expect(assembly.runtime.initial_status).toBe("initializing");
    expect(assembly.runtime.external_auth.status).toBe("not_required");
    expect(assembly.auth.entrypoint).toBe("none");
    expect(assembly.interfaces.health.service).toBe("ts-core");
    expect(assembly.sandbox.resource_limits.memory_limit_mb).toBe(128);
    expect(assembly.diagnostics.catalog.channels).toHaveLength(3);
    expect(assembly.lifecycle.startup.map((step) => step.name)).toEqual([
      "load_config",
      "prepare_diagnostics",
      "prepare_sandbox",
      "prepare_redis",
      "prepare_postgres",
      "prepare_runtime",
      "start_workers",
      "start_realtime",
      "start_http",
      "emit_bot_ready",
    ]);
    expect(assembly.lifecycle.shutdown.map((step) => step.name)).toEqual([
      "interrupt_runtime",
      "transition_runtime_shutdown",
      "stop_workers",
      "stop_http",
      "stop_realtime",
      "disconnect_runtime_transport",
      "release_redis",
      "release_postgres",
    ]);
  });

  it("应生成单 Bot 无 MC 冒烟摘要并暴露依赖关系", () => {
    const smoke = createAppSmokeAssembly({
      botId: "bot-smoke",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        PG_POOL_MIN: "3",
        PG_POOL_MAX: "9",
        LOGS_DIR: "./legacy-logs",
      },
      botConfig: {
        logs: {
          retention: {
            llmLogDays: 14,
          },
        },
      },
    });

    expect(smoke.config.logs.baseDir).toBe("./legacy-logs");
    expect(smoke.config.logs.retention.llmLogDays).toBe(14);
    expect(smoke.postgres.pool.min).toBe(3);
    expect(smoke.postgres.pool.max).toBe(9);
    expect(smoke.redis.queues.exec).toBe("bull:bot:bot-smoke:exec:*");
    expect(smoke.health.status).toBe("ok");
    expect(smoke.readiness).toContainEqual(
      expect.objectContaining({
        subsystem: "http",
        readiness: "planned",
        dependencies: ["runtime", "workers", "realtime"],
      }),
    );
  });

  it("应暴露需要认证但缺少注入密钥的失败路径，以及已注入密钥的待认证路径", () => {
    const missingSecretAssembly = createAppBootstrapContract({
      botId: "bot-auth-missing",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        MC_EXTERNAL_AUTH_REQUIRED: "true",
      },
    });
    const injectedSecretAssembly = createAppBootstrapContract({
      botId: "bot-auth-ready",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        MC_EXTERNAL_AUTH_REQUIRED: "true",
        MC_EXTERNAL_AUTH_SECRET: "hunter2",
      },
    });

    expect(missingSecretAssembly.auth.state.status).toBe("failed");
    expect(missingSecretAssembly.auth.entrypoint).toBe("game_chat_command");
    expect(missingSecretAssembly.auth.secret_injected).toBe(false);
    expect(missingSecretAssembly.runtime.initial_status).toBe("initializing");
    expect(injectedSecretAssembly.auth.state.status).toBe("pending");
    expect(injectedSecretAssembly.auth.entrypoint).toBe("game_chat_command");
    expect(injectedSecretAssembly.auth.secret_injected).toBe(true);
    expect(injectedSecretAssembly.runtime.external_auth.status).toBe("pending");
  });

  it("应拒绝空 bot 标识与倒置的生命周期顺序", () => {
    expect(() =>
      createAppBootstrapContract({
        botId: "",
        now: "2026-04-14T00:00:00.000Z",
      }),
    ).toThrow("botId must be a non-empty string");

    expect(() =>
      assertAppLifecyclePlan({
        startup: [
          {
            name: "start_http",
            phase: "startup",
            subsystem: "http",
            depends_on: ["start_realtime"],
            description: "invalid",
          },
          {
            name: "start_realtime",
            phase: "startup",
            subsystem: "realtime",
            depends_on: [],
            description: "invalid",
          },
        ],
        shutdown: [],
      }),
    ).toThrow("Lifecycle step start_http must be ordered after start_realtime");
  });
});
