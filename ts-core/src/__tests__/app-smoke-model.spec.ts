import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createAppRuntimeCoreResources } from "../app/bootstrap/runtime-core.js";
import {
  assertAppLifecyclePlan,
  createAppBootstrapContract,
  createAppProcessRuntime,
  createAppSmokeAssembly,
} from "../app/index.js";
import { ExecPriority, createCodeJob } from "../core-ports/tasking.js";
import type { MineflayerBotHandle } from "../runtime/transport/types.js";

class FakeAppMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username: string;
  readonly game = {
    dimension: "minecraft:overworld",
  };
  readonly registry = {
    itemsByName: {
      oak_log: {
        id: 41,
      },
    },
    items: {
      "41": {
        id: 41,
        name: "oak_log",
      },
    },
    blocksByName: {
      oak_log: {
        id: 40,
        name: "oak_log",
        material: "mineable/axe",
        diggable: true,
        drops: [41],
        states: [{ name: "axis" }],
      },
    },
  };
  readonly inventoryItems = [{ type: 41, name: "oak_log", count: 8 }];
  readonly inventory = {
    items: () => this.inventoryItems,
    emptySlotCount: () => 35,
    slots: [],
  };
  readonly entity = {
    position: { x: 0, y: 64, z: 0 },
    velocity: { y: 0 },
  };
  readonly heldItem = null;

  constructor(
    username: string,
    private readonly onQuit: () => void = () => undefined,
  ) {
    super();
    this.username = username;
  }

  quit(): void {
    this.onQuit();
    this.emit("end");
  }

  loadPlugin(): void {
    // 测试替身只需要满足 Mineflayer（Minecraft 协议客户端） 插件加载形态。
  }

  chat(): void {
    // 测试替身只验证 BotActor（机器人执行代理） 聊天写入路径可达。
  }
}

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
    expect(assembly.resources.create_order).toEqual(["postgres", "redis"]);
    expect(assembly.resources.close_order).toEqual(["redis", "postgres"]);
    expect(assembly.resources.postgres.descriptor).toBe(assembly.postgres);
    expect(assembly.resources.redis.keys).toBe(assembly.redis);
    expect(assembly.resources.redis.descriptor.url).toBe("redis://cache.internal:6380");
    expect(assembly.runtime_resources.create_order).toEqual([
      "observation",
      "mineflayer_transport",
      "bot_actor",
    ]);
    expect(assembly.runtime_resources.close_order).toEqual([
      "bot_actor",
      "mineflayer_transport",
      "observation",
    ]);
    expect(assembly.runtime_resources.mineflayer_transport.descriptor.bot_id).toBe("bot-app");
    expect(assembly.runtime_resources.bot_actor.initial_status).toBe("initializing");
    expect(assembly.services.create_order).toEqual(["workers", "http"]);
    expect(assembly.services.close_order).toEqual(["http", "workers"]);
    expect(assembly.services.workers.catalog).toBe(assembly.workers);
    expect(assembly.services.http.routes[2].path).toBe("/api/message");
    expect(assembly.workers.conversation.queue).toBe("msg:bot-app");
    expect(assembly.runtime.initial_status).toBe("initializing");
    expect(assembly.runtime.external_auth.status).toBe("not_required");
    expect(assembly.runtime.ready_gate.ready).toBe(false);
    expect(assembly.runtime.ready_gate.blocked_by).toEqual(["runtime_initializing"]);
    expect(assembly.auth.entrypoint).toBe("none");
    expect(assembly.interfaces.health.service).toBe("ts-core");
    expect(assembly.sandbox.resource_limits.memory_limit_mb).toBe(128);
    expect(assembly.diagnostics.catalog.channels).toHaveLength(4);
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
      "stop_http",
      "stop_workers",
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
    expect(smoke.resources.redis.reuse_for).toBe("bullmq_shared_connection");
    expect(smoke.runtime_resources.observation.mode).toBe("event_driven_cache");
    expect(smoke.runtime_resources.mineflayer_transport.descriptor.host).toBe("localhost");
    expect(smoke.services.http.listen).toEqual({
      host: "0.0.0.0",
      port: 3000,
    });
    expect(smoke.health.status).toBe("ok");
    expect(smoke.readiness).toContainEqual(
      expect.objectContaining({
        subsystem: "http",
        readiness: "planned",
        dependencies: ["runtime", "workers", "realtime"],
      }),
    );
  });

  it("应从 env（环境变量） 装配统一 thinking（思考） 配置", () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-thinking",
      now: "2026-05-03T00:00:00.000Z",
      env: {
        LLM_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "mimo-v2.5",
        LLM_ENABLE_THINKING: "false",
        LLM_REASONING_EFFORT: "none",
        LLM_FORCE_THINKING_MODELS: "mimo-v2.5-pro, gpt-5.5",
      },
    });

    expect(bootstrap.llm).toMatchObject({
      enabled: true,
      model: "mimo-v2.5",
      enable_thinking: false,
      reasoning_effort: "none",
      force_thinking_models: ["mimo-v2.5-pro", "gpt-5.5"],
    });
  });

  it("应把空字符串可选 MC 环境变量视为未设置", () => {
    const assembly = createAppBootstrapContract({
      botId: "bot-empty-mc-options",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        MC_HOST: "mc.example.internal",
        MC_PORT: "25565",
        MC_USERNAME: "maid-bot",
        MC_VERSION: "",
        MC_AUTH: "",
        MC_WORLD_DIMENSION_MAP:
          "cherry=minecraft:overworld,resource=minecraft:overworld,minecraft:the_nether=minecraft:the_nether",
      },
    });

    expect(assembly.runtime_resources.mineflayer_transport.descriptor.host).toBe(
      "mc.example.internal",
    );
    expect(assembly.runtime_resources.mineflayer_transport.descriptor.username).toBe("maid-bot");
    expect(assembly.runtime_resources.mineflayer_transport.descriptor.version).toBeNull();
    expect(assembly.runtime_resources.mineflayer_transport.descriptor.auth).toBeNull();
    expect(assembly.runtime_resources.mineflayer_transport.descriptor.world_dimension_map).toEqual({
      cherry: "minecraft:overworld",
      resource: "minecraft:overworld",
      "minecraft:the_nether": "minecraft:the_nether",
    });
  });

  it("运行时核心首连 MC 失败时应保留资源并暴露不可用快照", async () => {
    const closeOrder: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-mc-unavailable",
      now: "2026-04-15T00:00:00.000Z",
    });

    const runtime = await createAppRuntimeCoreResources(bootstrap, {
      transport: {
        createBot: () => {
          const bot = new FakeAppMineflayerBot("bot-mc-unavailable", () => {
            closeOrder.push("runtime_transport");
          });

          setTimeout(() => bot.emit("end"), 0);

          return bot;
        },
      },
    });
    const snapshot = runtime.actor.getSnapshot();

    expect(snapshot.status).toBe("initializing");
    expect(snapshot.transport.connected).toBe(false);
    expect(snapshot.transport.state).toBe("failed");
    expect(snapshot.transport.last_error).toContain("ended before login or spawn");

    await runtime.close();

    expect(closeOrder).toContain("runtime_transport");
  });

  it("运行时核心装配应注入通用 ensure（确保） 语义入口", async () => {
    const closeOrder: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-ensure-logs",
      now: "2026-05-05T00:00:00.000Z",
    });

    const runtime = await createAppRuntimeCoreResources(bootstrap, {
      transport: {
        createBot: () => {
          const bot = new FakeAppMineflayerBot("bot-ensure-logs", () => {
            closeOrder.push("runtime_transport");
          });

          setTimeout(() => bot.emit("spawn"), 0);

          return bot;
        },
      },
    });
    const outcome = await runtime.actor.executeCode(
      createCodeJob({
        message_id: "ensure-logs-existing",
        intent_epoch: 1,
        snapshot_ts: Date.parse("2026-05-05T00:00:00.000Z"),
        priority: ExecPriority.Normal,
        code: "await ensure(async () => ({ done: true }), until.has('oak_log', 4)); await report('done')",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.step_results[0]).toMatchObject({
      action: "report",
      status: "ok",
    });

    await runtime.close();

    expect(closeOrder).toContain("runtime_transport");
  });

  it("应拒绝已设置但非法的 MC 环境变量", () => {
    expect(() =>
      createAppBootstrapContract({
        botId: "bot-blank-host",
        now: "2026-04-14T00:00:00.000Z",
        env: {
          MC_HOST: "   ",
        },
      }),
    ).toThrow("MC_HOST must not be blank");

    expect(() =>
      createAppBootstrapContract({
        botId: "bot-invalid-port",
        now: "2026-04-14T00:00:00.000Z",
        env: {
          MC_PORT: "25565x",
        },
      }),
    ).toThrow("MC_PORT must be an integer string");

    expect(() =>
      createAppBootstrapContract({
        botId: "bot-out-of-range-port",
        now: "2026-04-14T00:00:00.000Z",
        env: {
          MC_PORT: "70000",
        },
      }),
    ).toThrow("MC_PORT must be at most 65535");
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
    expect(missingSecretAssembly.auth.state).not.toHaveProperty("secret");
    expect(missingSecretAssembly.runtime.initial_status).toBe("initializing");
    expect(missingSecretAssembly.runtime.ready_gate.ready).toBe(false);
    expect(missingSecretAssembly.runtime.ready_gate.blocked_by).toContain("external_auth_failed");
    expect(injectedSecretAssembly.auth.state.status).toBe("pending");
    expect(injectedSecretAssembly.auth.entrypoint).toBe("game_chat_command");
    expect(injectedSecretAssembly.auth.secret_injected).toBe(true);
    expect(injectedSecretAssembly.auth.state.action_summary?.command_preview).toBe(
      "/login <redacted>",
    );
    expect(injectedSecretAssembly.auth.state).not.toHaveProperty("secret");
    expect(injectedSecretAssembly.runtime.external_auth.status).toBe("pending");
    expect(injectedSecretAssembly.runtime.external_auth).not.toHaveProperty("secret");
    expect(injectedSecretAssembly.runtime.scaffold.externalAuth.status).toBe("pending");
    expect(injectedSecretAssembly.runtime.scaffold.externalAuth).not.toHaveProperty("secret");
    expect(injectedSecretAssembly.runtime.scaffold.externalAuthPlan).toEqual({
      status: "pending",
      action_summary: {
        kind: "login_command",
        entrypoint: "game_chat_command",
        target: "minecraft_chat",
        command_preview: "/login <redacted>",
        retry_allowed: true,
      },
      retry_allowed: true,
      ready_for_idle: false,
    });
    expect(injectedSecretAssembly.runtime.scaffold.externalAuthPlan).not.toHaveProperty(
      "next_action",
    );
    expect(injectedSecretAssembly.runtime.ready_gate.ready).toBe(false);
    expect(injectedSecretAssembly.runtime.ready_gate.blocked_by).toContain("external_auth_pending");
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

  it("应按 HTTP、BullMQ、Redis、PostgreSQL 顺序关闭完整进程资源", async () => {
    const closeOrder: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-process",
      now: "2026-04-15T00:00:00.000Z",
    });
    const runtime = await createAppProcessRuntime(bootstrap, {
      infrastructure: {
        postgres: {
          createPool: () => ({
            end: async () => {
              closeOrder.push("postgres");
            },
          }),
          createDrizzle: () => ({}),
          warmupPool: async () => undefined,
        },
        redis: {
          createClient: () => ({}),
          connectClient: async () => undefined,
          closeClient: async () => {
            closeOrder.push("redis");
          },
        },
      },
      runtime: {
        transport: {
          createBot: () => {
            const bot = new FakeAppMineflayerBot("bot-process", () => {
              closeOrder.push("runtime_transport");
            });

            setTimeout(() => bot.emit("spawn"), 0);

            return bot;
          },
        },
      },
      services: {
        workers: {
          createQueue: ({ name }) => ({
            name,
            close: async () => {
              closeOrder.push(name);
            },
          }),
        },
        http: {
          createServer: () => {
            const server = Fastify();
            const originalClose = server.close.bind(server);

            server.close = async () => {
              closeOrder.push("http");
              return originalClose();
            };

            return server;
          },
        },
      },
    });

    expect(runtime.runtime.actor.getSnapshot().status).toBe("idle");

    await runtime.close();

    expect(closeOrder).toEqual([
      "http",
      "brain",
      "bot:bot-process:exec",
      "msg:bot-process",
      "runtime_transport",
      "redis",
      "postgres",
    ]);
  });

  it("服务层创建失败时应清理 Mineflayer（Minecraft 协议客户端） 与基础设施资源", async () => {
    const closeOrder: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-process-failure",
      now: "2026-04-15T00:00:00.000Z",
    });

    await expect(
      createAppProcessRuntime(bootstrap, {
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => {
                closeOrder.push("postgres");
              },
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => {
              closeOrder.push("redis");
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeAppMineflayerBot("bot-process-failure", () => {
                closeOrder.push("runtime_transport");
              });

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        services: {
          workers: {
            createQueue: () => {
              throw new Error("worker queue failure");
            },
          },
        },
      }),
    ).rejects.toThrow("worker queue failure");

    expect(closeOrder).toEqual(["runtime_transport", "redis", "postgres"]);
  });
});
