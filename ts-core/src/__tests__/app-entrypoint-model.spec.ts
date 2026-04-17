import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppStartupSummary,
  renderAppStartupSummary,
  runAppEntrypoint,
  startAppOnlineRuntime,
} from "../app/index.js";
import type { MineflayerBotHandle } from "../runtime/transport.js";

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
});
