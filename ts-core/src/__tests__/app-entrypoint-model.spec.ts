import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppStartupSummary,
  createOnlineConversationActorStateProjectionProvider,
  renderAppStartupSummary,
  runAppEntrypoint,
  startAppOnlineRuntime,
} from "../app/index.js";
import type { AppRuntimeCoreResources } from "../app/index.js";
import {
  BotStatus,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createRuntimeReadyGate,
} from "../runtime/index.js";
import type { MineflayerBotHandle } from "../runtime/transport.js";
import { createConversationWorkerTask } from "../workers/contracts.js";

class FakeEntrypointMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username = "bot-online";

  constructor(private readonly events: string[]) {
    super();
  }

  chat(text: string): void {
    this.events.push(`chat:${text}`);
  }

  quit(): void {
    this.events.push("mineflayer.quit");
    this.emit("end");
  }
}

describe("app entrypoint（应用启动入口） 骨架", () => {
  it("应把纯装配结果转换为可读的启动摘要", () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-entrypoint",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        MC_EXTERNAL_AUTH_REQUIRED: "true",
        MC_EXTERNAL_AUTH_SECRET: "hunter2",
      },
    });
    const summary = createAppStartupSummary(bootstrap);

    expect(summary.bot_id).toBe("bot-entrypoint");
    expect(summary.initial_status).toBe("initializing");
    expect(summary.external_auth_initial_config.state.status).toBe("pending");
    expect(summary.external_auth_initial_config.entrypoint).toBe("game_chat_command");
    expect(summary.external_auth_initial_config.state.action_summary?.command_preview).toBe(
      "/login <redacted>",
    );
    expect(summary.external_auth_initial_config.state).not.toHaveProperty("secret");
    expect(summary.ready_gate.ready).toBe(false);
    expect(summary.ready_gate.can_emit_bot_ready).toBe(false);
    expect(summary.ready_gate.blocked_by).toEqual([
      "runtime_initializing",
      "external_auth_pending",
    ]);
    expect(summary.startup_plan.map((step) => step.name)).toEqual(
      bootstrap.lifecycle.startup.map((step) => step.name),
    );
    expect(summary.shutdown_plan.map((step) => step.name)).toEqual(
      bootstrap.lifecycle.shutdown.map((step) => step.name),
    );
    expect(summary.io_boundary.mode).toBe("bootstrap_only");
    expect(summary.io_boundary.connects_real_io).toBe(false);
    expect(summary.io_boundary.pending_targets).toEqual([
      "redis",
      "postgres",
      "fastify",
      "socket.io",
      "mineflayer",
    ]);
  });

  it("应把启动摘要渲染并输出到可注入写入端", () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-render",
      now: "2026-04-14T00:00:00.000Z",
    });
    const messages: string[] = [];
    const summary = runAppEntrypoint({
      bootstrap,
      write: (message) => {
        messages.push(message);
      },
    });
    const rendered = renderAppStartupSummary(summary);

    expect(messages).toEqual([rendered]);
    expect(rendered).toContain("TS Core bootstrap summary");
    expect(rendered).toContain("initial_status: initializing");
    expect(rendered).toContain("external_auth_initial_config.status: not_required");
    expect(rendered).toContain("ready_gate.status: blocked");
    expect(rendered).toContain("ready_gate.can_emit_bot_ready: false");
    expect(rendered).toContain("io_boundary.mode: bootstrap_only");
    expect(rendered).toContain("load_config");
    expect(rendered).toContain("interrupt_runtime");
  });

  it("应确保脚本、容器命令与根导出入口边界保持一致", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as {
      main: string;
      scripts: Record<string, string>;
      types: string;
    };
    const tsconfig = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../tsconfig.json"), "utf8"),
    ) as {
      exclude: string[];
    };
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../../Dockerfile"), "utf8");
    const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
    const rootIndex = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");

    expect(packageJson.main).toBe("dist/src/index.js");
    expect(packageJson.types).toBe("dist/src/index.d.ts");
    expect(packageJson.scripts.dev).toBe("tsx watch src/main.ts");
    expect(packageJson.scripts.start).toBe("node dist/src/main.js");
    expect(tsconfig.exclude).toContain("src/__tests__");
    expect(dockerfile).toContain("COPY --from=build /app/dist/src ./dist/src");
    expect(dockerfile).not.toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).toContain('CMD ["node", "dist/src/main.js"]');
    expect(readme).toContain("pnpm dev");
    expect(readme).toContain("pnpm start");
    expect(rootIndex).not.toContain("./main");
    expect(rootIndex).not.toContain("console.");
    expect(rootIndex).not.toContain("process.");
  });

  it("应按真实在线入口顺序启动 HTTP（超文本传输协议） 、Mineflayer（Minecraft 协议客户端） 与 ConversationWorker（对话工作线程） 并逆序关闭", async () => {
    const events: string[] = [];
    const env = {
      MC_EXTERNAL_AUTH_REQUIRED: "true",
      MC_EXTERNAL_AUTH_SECRET: "hunter2",
    };
    const bootstrap = createAppBootstrapContract({
      botId: "bot-online",
      now: "2026-04-15T00:00:00.000Z",
      env,
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => {
                events.push("postgres.close");
              },
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => {
              events.push("postgres.ready");
            },
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => {
              events.push("redis.ready");
            },
            closeClient: async () => {
              events.push("redis.close");
            },
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => {
                events.push(`queue.close:${name}`);
              },
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => {
                events.push("http.listen");

                return "http://127.0.0.1:0";
              };
              server.close = async () => {
                events.push("http.close");

                return originalClose();
              };

              return server;
            },
          },
        },
        runtime: {
          externalAuthSecret: createAppExternalAuthSecretFromEnvironment({ env }),
          transport: {
            createBot: () => {
              events.push("mineflayer.create");
              const bot = new FakeEntrypointMineflayerBot(events);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => {
            events.push("bot.worker.start");

            return {
              close: async () => {
                events.push("bot.worker.close");
              },
            };
          },
        },
        conversationWorker: {
          createWorker: () => {
            events.push("conversation.worker.start");

            return {
              close: async () => {
                events.push("conversation.worker.close");
              },
            };
          },
        },
      },
    });

    expect(runtime.listen_address).toBe("http://127.0.0.1:0");
    expect(events).toEqual([
      "postgres.ready",
      "redis.ready",
      "http.listen",
      "mineflayer.create",
      "chat:/login hunter2",
      "bot.worker.start",
      "conversation.worker.start",
    ]);
    expect(bootstrap.auth.state.status).toBe("pending");
    expect(runtime.runtime.actor.getSnapshot().external_auth.status).toBe("authenticated");

    await runtime.close();

    expect(events.slice(7)).toEqual([
      "conversation.worker.close",
      "bot.worker.close",
      "mineflayer.quit",
      "http.close",
      "queue.close:brain",
      "queue.close:bot:bot-online:exec",
      "queue.close:msg:bot-online",
      "redis.close",
      "postgres.close",
    ]);
  });

  it("应在真实在线入口把闲聊消息接到 OpenAI（开放人工智能） 兼容 LLM（大语言模型） 并写回聊天", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });
            const requestBody =
              init?.body === undefined
                ? undefined
                : (JSON.parse(String(init.body)) as {
                    messages?: Array<{ role: string; content: string }>;
                  });
            const userMessage = requestBody?.messages?.at(-1)?.content ?? "";
            const assistantContent = userMessage.includes("Bot 状态：")
              ? '{"intent":"chat","priority":"normal","reason":"普通闲聊"}'
              : "当然可以，我在这里";

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 5,
                },
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot(events);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
      write: (message) => {
        writes.push(message);
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-llm-online",
        message: {
          bot_id: "bot-llm-online",
          message_id: "msg-online-chat",
          content: "陪我聊聊天",
          intent_epoch: 1,
          snapshot_ts: 1_713_952_800_000,
        },
      }),
    });

    expect(bootstrap.llm).toEqual({
      enabled: true,
      provider: "openai_compatible",
      base_url: "http://127.0.0.1:8045/v1",
      model: "bl-auto",
      api_key_injected: true,
    });
    expect(llmRequests).toHaveLength(2);
    expect(llmRequests[0]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: {
        model: "bl-auto",
        messages: expect.any(Array),
      },
    });
    expect(llmRequests[1]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: {
        model: "bl-auto",
        messages: expect.any(Array),
      },
    });
    const chatRequestBody = llmRequests[1]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(chatRequestBody.messages?.[0]?.content).toContain("当前状态摘要：当前状态：idle");
    expect(chatRequestBody.messages?.[0]?.content).toContain("世界交互：已就绪");
    expect(events).toContain("chat:当然可以，我在这里喵~");
    expect(writes).toContain(
      "TS Core LLM chat ok: model=bl-auto message_id=msg-online-chat log_ref=llm/2026-04-24/chat-msg-online-chat.jsonl",
    );
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-llm-online",
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      bot: {
        bot_id: "bot-llm-online",
        status: "idle",
        mineflayer: {
          connected: true,
          world_ready: true,
          username: "bot-online",
        },
        workers: {
          conversation: true,
          bot: true,
        },
        llm: {
          stage: "chat",
          message_id: "msg-online-chat",
          status: "ok",
          model: "bl-auto",
          log_ref: "llm/2026-04-24/chat-msg-online-chat.jsonl",
          created_at: "2026-04-24T10:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(statusResponse.json())).not.toContain("sk-local-dev");
    const messageResponse = await runtime.services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-llm-online",
        message_id: "msg-online-http",
        content: "HTTP 入口测试",
      },
    });
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-llm-online&after_seq=0&limit=10",
    });

    expect(messageResponse.statusCode).toBe(202);
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toMatchObject({
      bot_id: "bot-llm-online",
      after_seq: 0,
      limit: 10,
      events: [
        {
          seq: 1,
          bot_id: "bot-llm-online",
          type: "task.accepted",
          payload: {
            job_id: "job-online",
            message_id: "msg-online-http",
            epoch: 0,
          },
        },
      ],
    });
    const replayAfterSeqResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-llm-online&after_seq=1&limit=10",
    });

    expect(replayAfterSeqResponse.json()).toMatchObject({
      events: [],
    });

    await runtime.close();
  });

  it("应在真实在线状态投影中保留 sandbox_code（沙箱代码） interrupted（已中断） 终态", () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const descriptor = createMineflayerTransportDescriptor({
      botId: "bot-sandbox-interrupted",
    });
    const actor = {
      getSnapshot: () =>
        Object.freeze({
          bot_id: "bot-sandbox-interrupted",
          status: BotStatus.IDLE,
          transport: Object.freeze({
            bot_id: "bot-sandbox-interrupted" as const,
            state: "connected" as const,
            connected: true,
            world_ready: true,
            descriptor,
            username: "bot-online",
            last_error: null,
          }),
          ready_gate: createRuntimeReadyGate({
            status: BotStatus.IDLE,
            externalAuth,
          }),
          external_auth: externalAuth,
          external_auth_plan: createExternalAuthExecutionPlan(externalAuth),
          current_task: null,
          emitted_events: Object.freeze([]),
          chat_writes: Object.freeze([]),
          skill_executions: Object.freeze([]),
          sandbox_executions: Object.freeze([
            {
              message_id: "msg-sandbox-stop",
              status: "interrupted" as const,
              total_steps: 2,
            },
          ]),
        }),
    } as AppRuntimeCoreResources<"bot-sandbox-interrupted">["actor"];
    const provider = createOnlineConversationActorStateProjectionProvider(actor);

    const projection = provider();

    expect(projection.recent_sandbox).toEqual({
      message_id: "msg-sandbox-stop",
      status: "interrupted",
      total_steps: 2,
    });
    expect(projection.summary).toContain("最近沙箱：interrupted");
    expect(projection.summary).not.toContain("最近沙箱：failed");
  });

  it("应在真实在线入口把 LLM（大语言模型） 失败摘要脱敏后再暴露到 status（状态接口）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const writes: string[] = [];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-error-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async () => {
            throw new Error(
              "upstream failed LLM_API_KEY=sk-local-dev postgres://user:pg-pass@localhost/db redis://:redis-pass@localhost EasyAuth密码=hunter2",
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot([]);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
      write: (message) => {
        writes.push(message);
      },
    });

    try {
      if (processor === undefined) {
        throw new Error("conversation processor must be captured");
      }

      await expect(
        processor({
          data: createConversationWorkerTask({
            bot_id: "bot-llm-error-online",
            message: {
              bot_id: "bot-llm-error-online",
              message_id: "msg-online-error",
              content: "触发失败",
              intent_epoch: 1,
              snapshot_ts: 1_713_952_800_000,
            },
          }),
        }),
      ).rejects.toThrow("sk-local-dev");

      const statusResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/status?bot_id=bot-llm-error-online",
      });
      const statusBody = statusResponse.json();
      const statusText = JSON.stringify(statusBody);

      expect(statusResponse.statusCode).toBe(200);
      expect(statusBody).toMatchObject({
        bot: {
          llm: {
            stage: "chat",
            message_id: "msg-online-error",
            status: "error",
            model: "bl-auto",
            log_ref: "llm/2026-04-24/chat-msg-online-error.jsonl",
            error_summary: expect.stringContaining("<redacted>"),
          },
        },
      });
      expect(statusText).toContain("upstream failed");
      expect(statusText).not.toContain("sk-local-dev");
      expect(statusText).not.toContain("pg-pass");
      expect(statusText).not.toContain("redis-pass");
      expect(statusText).not.toContain("hunter2");
      expect(writes.join("\n")).not.toContain("sk-local-dev");
    } finally {
      await runtime.close();
    }
  });

  it("应在真实在线入口把自然语言坐标任务接到 LLM（大语言模型） 分诊与规划，并入 goTo（前往坐标） 执行队列", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-plan-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });
            const requestBody =
              init?.body === undefined
                ? undefined
                : (JSON.parse(String(init.body)) as {
                    messages?: Array<{ role: string; content: string }>;
                  });
            const userMessage = requestBody?.messages?.at(-1)?.content ?? "";
            const assistantContent = userMessage.includes("主人的指令：")
              ? '{"type":"skill_call","reply":"收到，我这就过去","skill":"goTo","params":{"x":10,"y":64,"z":-5}}'
              : '{"intent":"task","priority":"urgent","reason":"主人给了明确坐标移动指令"}';

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (jobName: string, data: unknown, options: unknown) => {
                queueAdds.push({ name, jobName, data, options });

                return { id: "job-online" };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot([]);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-plan-online",
        message: {
          bot_id: "bot-plan-online",
          message_id: "msg-online-plan",
          content: "请去坐标 x=10 y=64 z=-5",
          intent_epoch: 3,
          snapshot_ts: 1_713_952_800_002,
        },
      }),
    });

    expect(llmRequests).toHaveLength(2);
    expect(queueAdds).toEqual([
      {
        name: "bot:bot-plan-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-plan-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-plan",
            priority: "urgent",
            skill: "goTo",
            params: { x: 10, y: 64, z: -5 },
          }),
        }),
        options: {
          jobId: "msg-online-plan",
          priority: 1,
        },
      },
    ]);
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-plan-online",
      message_id: "msg-online-plan",
      content: "收到，我这就过去喵~",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-plan-online",
      message_id: "msg-online-plan",
      skill: "goTo",
      priority: "urgent",
    });
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-plan-online",
    });

    expect(statusResponse.json()).toMatchObject({
      bot: {
        llm: {
          stage: "plan",
          message_id: "msg-online-plan",
          status: "ok",
          model: "bl-auto",
          log_ref: "llm/2026-04-24/plan-msg-online-plan.jsonl",
        },
      },
    });

    await runtime.close();
  });

  it("应在真实在线入口把 mine（挖掘） / collect（捡拾） / equip（装备） 三类自然语言任务规划为单个 skill_call（技能调用） 并入执行队列", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-skill-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });
            const requestBody =
              init?.body === undefined
                ? undefined
                : (JSON.parse(String(init.body)) as {
                    messages?: Array<{ role: string; content: string }>;
                  });
            const userMessage = requestBody?.messages?.at(-1)?.content ?? "";
            let assistantContent =
              '{"intent":"task","priority":"normal","reason":"主人给了明确技能指令"}';

            if (userMessage.includes("主人的指令：")) {
              if (userMessage.includes("挖两块石头")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我去挖石头","skill":"mine","params":{"blockName":"stone","count":2}}';
              } else if (userMessage.includes("把地上的圆石捡起来")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我去捡圆石","skill":"collect","params":{"itemName":"cobblestone","radius":6}}';
              } else {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我先把石镐拿在手上","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}';
              }
            }

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (jobName: string, data: unknown, options: unknown) => {
                queueAdds.push({ name, jobName, data, options });

                return { id: "job-online" };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot([]);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-mine",
          content: "去挖两块石头",
          intent_epoch: 5,
          snapshot_ts: 1_713_952_800_010,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-collect",
          content: "把地上的圆石捡起来",
          intent_epoch: 6,
          snapshot_ts: 1_713_952_800_011,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-equip",
          content: "把石镐拿在手上",
          intent_epoch: 7,
          snapshot_ts: 1_713_952_800_012,
        },
      }),
    });

    expect(llmRequests).toHaveLength(6);
    expect(queueAdds).toEqual([
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          exec_job: expect.objectContaining({
            message_id: "msg-online-mine",
            priority: "normal",
            skill: "mine",
            params: { blockName: "stone", count: 2 },
          }),
        }),
        options: {
          jobId: "msg-online-mine",
          priority: 5,
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          exec_job: expect.objectContaining({
            message_id: "msg-online-collect",
            priority: "normal",
            skill: "collect",
            params: { itemName: "cobblestone", radius: 6 },
          }),
        }),
        options: {
          jobId: "msg-online-collect",
          priority: 5,
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          exec_job: expect.objectContaining({
            message_id: "msg-online-equip",
            priority: "normal",
            skill: "equip",
            params: { itemName: "stone_pickaxe", destination: "hand" },
          }),
        }),
        options: {
          jobId: "msg-online-equip",
          priority: 5,
        },
      },
    ]);
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-mine",
      skill: "mine",
      priority: "normal",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-collect",
      skill: "collect",
      priority: "normal",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-equip",
      skill: "equip",
      priority: "normal",
    });

    await runtime.close();
  });

  it("应在真实在线入口把 modify（修改） 分诊结果降级为 chat（闲聊），而不是误走规划", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-modify-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });

            const assistantContent =
              llmRequests.length === 1
                ? '{"intent":"modify","priority":"urgent","reason":"主人要求修改当前移动目标"}'
                : "好的，我先记下这个修改请求喵~";

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: assistantContent,
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (jobName: string, data: unknown, options: unknown) => {
                queueAdds.push({ name, jobName, data, options });

                return { id: "job-online" };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot([]);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-modify-online",
        message: {
          bot_id: "bot-modify-online",
          message_id: "msg-online-modify",
          content: "把刚才的目标改成去 10 64 -5",
          intent_epoch: 4,
          snapshot_ts: 1_713_952_800_003,
        },
      }),
    });

    expect(llmRequests).toHaveLength(2);
    expect(queueAdds).toEqual([]);
    expect(runtime.conversation_worker.getEvents()).not.toContainEqual(
      expect.objectContaining({
        type: "task.accepted",
        message_id: "msg-online-modify",
      }),
    );
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-modify-online",
      message_id: "msg-online-modify",
      content: "好的，我先记下这个修改请求喵~",
    });
    expect(llmRequests[1]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: expect.objectContaining({
        model: "bl-auto",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "[主人] 把刚才的目标改成去 10 64 -5",
          }),
        ]),
      }),
    });

    await runtime.close();
  });

  it("应在真实在线入口保留 cancel（取消） 的分诊语义并跳过 LLM（大语言模型） 调用", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const interrupts: unknown[] = [];
    const chats: string[] = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-cancel-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });

            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: "不应触发",
                    },
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          },
          now: () => new Date("2026-04-24T10:00:00.000Z"),
        },
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({}),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => ({}),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async () => ({ id: "job-online" }),
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalClose = server.close.bind(server);

              server.listen = async () => "http://127.0.0.1:0";
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              const bot = new FakeEntrypointMineflayerBot(chats);

              setTimeout(() => bot.emit("spawn"), 0);

              return bot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          interruptRuntimeSink: async ({ signal }) => {
            interrupts.push(signal);
          },
          createWorker: ({ processor: capturedProcessor }) => {
            processor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });

    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cancel-online",
        message: {
          bot_id: "bot-cancel-online",
          message_id: "msg-online-cancel",
          content: "取消",
          intent_epoch: 2,
          snapshot_ts: 1_713_952_800_001,
        },
      }),
    });

    expect(llmRequests).toEqual([]);
    expect(interrupts).toEqual([
      {
        source: {
          type: "triage",
          intent_epoch: 2,
        },
        reason: "cancel",
      },
    ]);
    expect(chats).toEqual(["chat:好的，已经停下来了喵~"]);
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cancel-online",
      message_id: "msg-online-cancel",
      content: "好的，已经停下来了喵~",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-cancel-online",
      message_id: "msg-online-cancel",
      reason: "online_explicit_cancel",
    });

    await runtime.close();
  });
});
