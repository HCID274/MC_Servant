import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createAppServerBridgeConfigFromEnvironment } from "../app/bootstrap/env.js";
import {
  bindOnlineResourceServiceBlockUpdates,
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppStartupSummary,
  createOnlineConversationActorStateProjectionProvider,
  createRealtimeEventFromBotWorkerAction,
  createRealtimeEventFromConversationReply,
  renderAppStartupSummary,
  runAppEntrypoint,
  startAppOnlineRuntime,
} from "../app/index.js";
import type { AppRuntimeCoreResources } from "../app/index.js";
import {
  ConversationLlmPlanError,
  createConversationCompositeTriage,
  createSkillCallPlanDraft,
} from "../conversation/index.js";
import { ExecutionTaskKind } from "../core-ports/foundation.js";
import { ExecPriority, TaskHistoryStatus, createSandboxCodeJob } from "../core-ports/tasking.js";
import { createBrainTaskCard } from "../data/index.js";
import { ConversationPriority } from "../domain/contracts.js";
import { SERVER_BRIDGE_PROTOCOL_VERSION } from "../interfaces/index.js";
import { createObservationRuntimeCache } from "../observation/index.js";
import {
  BotStatus,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createRuntimeReadyGate,
} from "../runtime/index.js";
import type { MineflayerBotHandle } from "../runtime/transport.js";
import {
  type BotWorkerTask,
  type BrainWorkerTask,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainWorkerTask,
  createConversationWorkerTask,
} from "../workers/contracts.js";
import { type BrainWorkerRuntimeDependencies, createTaskResultReporter } from "../workers/index.js";
import { createTaskResultSummaryFromSandboxResult } from "../workers/task-result-summary.js";
import { createResourceService } from "../world-model/index.js";

class FakeEntrypointMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username = "bot-online";
  readonly entity = {
    id: "bot-online",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  readonly players: Record<
    string,
    { entity?: { id: string; username: string; position: { x: number; y: number; z: number } } }
  > = {};

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

  setOwnerPosition(
    ownerName: string,
    position: { readonly x: number; readonly y: number; readonly z: number },
  ): void {
    this.players[ownerName] = {
      entity: {
        id: ownerName,
        username: ownerName,
        position: { x: position.x, y: position.y, z: position.z },
      },
    };
  }
}

function waitForWsOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForWsClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

function readNextWsText(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      resolve(data.toString("utf8"));
    });
    socket.once("error", reject);
  });
}

function createFakeIntentEpochRedisClient(initialEpoch = 0): {
  readonly incr: () => Promise<number>;
  readonly get: () => Promise<string>;
} {
  let epoch = initialEpoch;

  return {
    async incr() {
      epoch += 1;

      return epoch;
    },
    async get() {
      return String(epoch);
    },
  };
}

function createNoopBrainWorkerDependencies(): Partial<BrainWorkerRuntimeDependencies> {
  return {
    generateEmbedding: async () => [0.1],
    persistTaskEvent: async () => undefined,
    createWorker: () => ({
      close: async () => undefined,
    }),
  };
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

  it("应把 worker（工作线程） 输出动作转换为只读 replay（补拉）事件", () => {
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: createSandboxCodeJob({
        message_id: "msg-realtime-action",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: "return true",
      }),
    });
    const startedAction = createBotWorkerActions({ task, phase: "started" })[0];
    const discardedAction = createBotWorkerActions({
      task,
      phase: "discarded",
      discard_reason: "intent_epoch_stale",
      current_epoch: 2,
    })[0];
    const completedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 10,
    });
    const failedAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 12,
      error: {
        name: "Error",
        message: "boom",
      },
    })[0];
    const interruptedAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 13,
      interrupt_source: {
        type: "triage",
        intent_epoch: 3,
      },
      reason: "cancel",
    })[0];
    const replyEvent = createRealtimeEventFromConversationReply({
      botId: "bot-realtime-action",
      messageId: "msg-realtime-action",
      content: "收到喵~",
      createdAt: "2026-04-25T00:00:00.000Z",
    });

    const converted = [
      startedAction,
      discardedAction,
      completedActions[0],
      failedAction,
      interruptedAction,
    ].map((action) =>
      createRealtimeEventFromBotWorkerAction({
        action,
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    );

    expect(converted.map((event) => event?.type)).toEqual([
      "task.started",
      "task.discarded",
      "task.completed",
      "task.failed",
      "task.interrupted",
    ]);
    expect(converted[2]).toMatchObject({
      bot_id: "bot-realtime-action",
      payload: {
        job_id: "msg-realtime-action",
        status: "completed",
        message_id: "msg-realtime-action",
        total_steps: 1,
      },
    });
    expect(
      createRealtimeEventFromBotWorkerAction({
        action: completedActions[1],
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(replyEvent).toEqual({
      bot_id: "bot-realtime-action",
      type: "chat.reply",
      created_at: "2026-04-25T00:00:00.000Z",
      payload: {
        message_id: "msg-realtime-action",
        content: "收到喵~",
      },
    });
    expect(Object.isFrozen(replyEvent.payload)).toBe(true);
  });

  it("应把任务终态转换为游戏聊天可见结果且同一终态只汇报一次", () => {
    const action = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-realtime-action",
        exec_job: {
          type: ExecutionTaskKind.SkillCall,
          message_id: "msg-mine-failed-reply",
          intent_epoch: 3,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skillCall: {
            skill: "mine",
            params: { blockName: "stone", count: 5 },
          },
          skill: "mine",
          params: { blockName: "stone", count: 5 },
        },
        owner_text: "给我挖5个石头",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 0,
      duration_ms: 23,
      error: {
        name: "Error",
        message: "not_equipped:stone:requires_wooden_or_stone_pickaxe",
      },
      last_step: "executeSkill",
    });
    const completedAction = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-realtime-action",
        exec_job: {
          type: ExecutionTaskKind.SkillCall,
          message_id: "msg-cut-tree-completed-reply",
          intent_epoch: 4,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skillCall: {
            skill: "cutTree",
            params: { count: 12 },
          },
          skill: "cutTree",
          params: { count: 12 },
        },
        owner_text: "砍12块木头",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 2,
      duration_ms: 3100,
      result_summary: {
        task_type: ExecutionTaskKind.SkillCall,
        operation: "cutTree",
        target: "oak_log",
        requested_count: 12,
        completed_count: 12,
        inventory_delta: [{ item_name: "oak_log", count: 12 }],
        world_key: "minecraft:overworld",
      },
    });

    const reporter = createTaskResultReporter();
    const failureReply = reporter.consume(action[1]);
    const completedReply = reporter.consume(completedAction[1]);

    expect(failureReply).toMatchObject({
      message_id: "msg-mine-failed-reply:task_result",
    });
    expect(failureReply?.content).toContain("任务失败：mine 失败码 not_equipped");
    expect(failureReply?.content).toContain("阶段 executeSkill");
    expect(failureReply?.content).toContain("可恢复");
    expect(completedReply?.content).toContain("任务完成：砍到 oak_log x12");
    expect(completedReply?.content).toContain("已捡拾掉落物");
    expect(reporter.consume(completedAction[1])).toBeNull();
  });

  it("应汇报 sandbox TS（沙箱 TypeScript） 报错与中断终态", () => {
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: createSandboxCodeJob({
        message_id: "msg-sandbox-result",
        intent_epoch: 5,
        snapshot_ts: 1777906762364,
        priority: ExecPriority.Normal,
        code: "await api.bot.mine('iron_ore', 1)",
      }),
      owner_text: "挖铁矿",
    });
    const failedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 900,
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
        },
      },
      last_step: "mine",
      result_summary: {
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
        world_key: "minecraft:overworld",
      },
    });
    const interruptedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 1200,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner requested cancel",
      result_summary: {
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
        world_key: "minecraft:overworld",
      },
    });

    const reporter = createTaskResultReporter();
    const failedReply = reporter.consume(failedActions[1]);
    const interruptedReply = reporter.consume(interruptedActions[1]);

    expect(failedReply?.content).toContain(
      "任务失败：mine 失败码 resource_not_found，阶段 mine，可恢复",
    );
    expect(failedReply?.content).toContain("下一步建议换位置或扩大搜索范围");
    expect(interruptedReply?.content).toContain("任务已取消：mine 已停止");
    expect(interruptedReply?.content).not.toContain("任务完成");
  });

  it("应在 sandbox TS（沙箱 TypeScript） 前置成功后准确汇报后续失败操作", () => {
    const sandboxJob = createSandboxCodeJob({
      message_id: "msg-sandbox-step-failure",
      intent_epoch: 6,
      snapshot_ts: 1777906762364,
      priority: ExecPriority.Normal,
      code: [
        "await api.bot.craft('wooden_pickaxe', 1)",
        "await api.bot.equip('wooden_pickaxe')",
        "await api.bot.mine('iron_ore', 1)",
      ].join("\n"),
    });
    const sandboxResult = {
      status: TaskHistoryStatus.Failed,
      summary: { total_steps: 3 },
      step_results: [
        {
          action: "craft",
          status: "ok",
          params: { itemName: "wooden_pickaxe", count: 1 },
          result: { ok: true, data: { item_name: "wooden_pickaxe", completed_count: 1 } },
        },
        {
          action: "equip",
          status: "ok",
          params: { itemName: "wooden_pickaxe" },
          result: { skill: "equip", item_name: "wooden_pickaxe" },
        },
        {
          action: "mine",
          status: "err",
          params: { blockName: "iron_ore", count: 1 },
          error: {
            name: "FacadeCallError",
            message: "resource_not_found:iron_ore",
            error_code: "resource_not_found",
          },
        },
      ],
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        method: "mine",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
          target_progress: {
            action: "mine",
            target: "iron_ore",
            requested_count: 1,
            completed_count: 0,
          },
        },
      },
    } as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: sandboxJob,
      owner_text: "做镐再挖铁矿",
    });
    const failedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 3,
      duration_ms: 1600,
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
        },
      },
      last_step: "mine",
      result_summary: createTaskResultSummaryFromSandboxResult(sandboxJob, sandboxResult),
    });

    const reporter = createTaskResultReporter();
    const failedReply = reporter.consume(failedActions[1]);

    expect(failedReply?.content).toContain(
      "任务失败：mine 失败码 resource_not_found，阶段 mine，可恢复",
    );
    expect(failedReply?.content).not.toContain("equip 失败码 resource_not_found");
    expect(failedReply?.content).not.toContain("craft 失败码 resource_not_found");
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-online",
    });
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-online&after_seq=0&limit=10",
    });
    const publicOnlineText = JSON.stringify({
      status: statusResponse.json(),
      replay: replayResponse.json(),
    });

    expect(publicOnlineText).not.toContain("hunter2");
    expect(publicOnlineText).not.toContain("/login hunter2");

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

  it("应在在线入口用显式 embedding endpoint（向量端点）驱动 BrainWorker（大脑工作线程）持久化 task_events（任务事件）", async () => {
    const events: string[] = [];
    const embeddingRequests: Array<{ url: string; body: unknown }> = [];
    const persistedDrafts: unknown[] = [];
    const appMemoryWrites: unknown[] = [];
    const appCandidateWrites: unknown[] = [];
    const appAuditWrites: unknown[] = [];
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-online-brain",
      now: "2026-05-03T00:00:00.000Z",
      env: {
        EMBEDDING_DIMENSIONS: "3",
      },
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        embedding: {
          endpoint_url: "https://embedding.local/v1/embeddings",
          api_key: "sk-embedding",
          model: "text-embedding-v4",
          fetch: async (url, init) => {
            embeddingRequests.push({
              url: String(url),
              body: JSON.parse(String(init?.body)),
            });

            return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
              status: 200,
            });
          },
        },
        brainWorker: {
          now: () => new Date("2026-05-03T01:00:00.000Z"),
          async persistTaskEvent(draft) {
            persistedDrafts.push(draft);
          },
          llm: {
            model: "bl-auto",
            async generateFailureTakeaway() {
              throw new Error("failure takeaway should not run");
            },
            async generateSessionTakeaway() {
              throw new Error("session takeaway should not run");
            },
            async compressRollingSummary(content) {
              return content;
            },
            async generateMemoryCandidates() {
              return [
                {
                  kind: "MEMORY",
                  content: "主基地旁边有盾牌补给点",
                  confidence: 0.9,
                  reason: "稳定地点事实",
                },
              ];
            },
            async resolveMemoryCapacity() {
              throw new Error("capacity should not run");
            },
          },
          async loadBotMemory() {
            return {
              USER: "",
              MEMORY: "",
              SKILL: "",
            };
          },
          async insertMemoryCandidate(candidate) {
            appCandidateWrites.push(candidate);
          },
          async decideMemoryCandidate() {
            return undefined;
          },
          async writeBotMemory(memory) {
            appMemoryWrites.push(memory);
          },
          async appendMemoryAudit(audit) {
            appAuditWrites.push(audit);
          },
          createWorker: ({ processor }) => {
            brainProcessor = processor;
            events.push("brain.worker.start");

            return {
              close: async () => {
                events.push("brain.worker.close");
              },
            };
          },
        },
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
              add: async () => ({ id: "job-online-brain" }),
              close: async () => {
                events.push(`queue.close:${name}`);
              },
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();

              server.listen = async () => "http://127.0.0.1:0";

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
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    await brainProcessor?.({
      data: createBrainWorkerTask({
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        intent_epoch: 3,
        status: TaskHistoryStatus.Completed,
        owner_text: "把这个东西捡起来",
        task_card: createBrainTaskCard({
          task_id: "msg-online-brain",
          message_id: "msg-online-brain",
          intent_epoch: 3,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          owner_text: "把这个东西捡起来",
          execution: {
            type: ExecutionTaskKind.SkillCall,
            skill: "collect",
            params: {},
          },
          result: {
            status: TaskHistoryStatus.Completed,
            duration_ms: 1000,
            total_steps: 1,
          },
        }),
      }),
    });

    expect(embeddingRequests).toEqual([
      {
        url: "https://embedding.local/v1/embeddings",
        body: {
          model: "text-embedding-v4",
          input: "把这个东西捡起来",
          dimensions: 3,
        },
      },
    ]);
    expect(persistedDrafts).toEqual([
      expect.objectContaining({
        id: "task-event:bot-online-brain:msg-online-brain",
        task_id: "msg-online-brain",
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        owner_text: "把这个东西捡起来",
        embedding: [0.1, 0.2, 0.3],
        created_at: "2026-05-03T01:00:00.000Z",
      }),
    ]);
    expect(appCandidateWrites).toMatchObject([
      {
        id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        content: "主基地旁边有盾牌补给点",
        status: "pending",
      },
    ]);
    expect(appMemoryWrites).toEqual([
      {
        bot_id: "bot-online-brain",
        kind: "MEMORY",
        content: "主基地旁边有盾牌补给点",
        updated_at: "2026-05-03T01:00:00.000Z",
      },
    ]);
    expect(appAuditWrites).toMatchObject([
      {
        kind: "MEMORY",
        op: "insert",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
      },
    ]);
    expect(runtime.brain_worker.getEvents()).toEqual([
      {
        type: "brain.task_event.persisted",
        bot_id: "bot-online-brain",
        message_id: "msg-online-brain",
        task_id: "msg-online-brain",
        event_id: "task-event:bot-online-brain:msg-online-brain",
        status: TaskHistoryStatus.Completed,
      },
      {
        type: "brain.memory_candidate.recorded",
        bot_id: "bot-online-brain",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        status: "pending",
      },
      {
        type: "brain.memory.promoted",
        bot_id: "bot-online-brain",
        candidate_id: "memory-candidate:task-event:bot-online-brain:msg-online-brain:0",
        kind: "MEMORY",
        op: "insert",
      },
    ]);

    await runtime.close();
  });

  it("应把 server-bridge 主人发话时坐标透传到 BrainWorker rubric（评分规则）", async () => {
    const rubricInputs: unknown[] = [];
    let fakeBot: FakeEntrypointMineflayerBot | undefined;
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let capturedBrainTask: BrainWorkerTask | undefined;
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
        SERVER_BRIDGE_CONVERSATION_ENABLED: "true",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const runtime = await startAppOnlineRuntime({
      bootstrap: createAppBootstrapContract({
        botId: "bot-owner-position-memory",
        now: "2026-05-03T00:00:00.000Z",
      }),
      dependencies: {
        serverBridge: {
          ...serverBridge,
          now: () => "2026-05-03T00:00:10.000Z",
        },
        brainWorker: {
          now: () => new Date("2026-05-03T00:01:00.000Z"),
          async generateEmbedding() {
            return [0.1, 0.2, 0.3];
          },
          async persistTaskEvent() {
            return undefined;
          },
          llm: {
            model: "bl-auto",
            async generateFailureTakeaway() {
              throw new Error("failure takeaway should not run");
            },
            async generateSessionTakeaway() {
              throw new Error("session takeaway should not run");
            },
            async compressRollingSummary(content) {
              return content;
            },
            async generateMemoryCandidates(input) {
              rubricInputs.push(input);

              return [
                {
                  kind: "MEMORY",
                  content: "家的位置坐标：x=120, y=64, z=-300",
                  confidence: 0.91,
                  reason: "主人发话时站在这里",
                },
              ];
            },
            async resolveMemoryCapacity() {
              throw new Error("capacity should not run");
            },
          },
          async loadBotMemory() {
            return {
              USER: "",
              MEMORY: "",
              SKILL: "",
            };
          },
          async insertMemoryCandidate() {
            return undefined;
          },
          async decideMemoryCandidate() {
            return undefined;
          },
          async writeBotMemory() {
            return undefined;
          },
          async appendMemoryAudit() {
            return undefined;
          },
          createWorker: ({ processor }) => {
            brainProcessor = processor;

            return {
              close: async () => undefined,
            };
          },
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
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (_jobName, data, options) => {
                if (name === "msg:bot-owner-position-memory") {
                  setTimeout(() => {
                    void conversationProcessor?.({ data });
                  }, 0);
                }
                if (name === "bot:bot-owner-position-memory:exec") {
                  throw new Error("location memory must not enter bot exec queue");
                }
                if (name === "brain") {
                  capturedBrainTask = data as BrainWorkerTask;
                }

                return { id: String(options?.jobId ?? "job-online") };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
              server.close = async () => originalClose();

              return server;
            },
          },
        },
        runtime: {
          transport: {
            createBot: () => {
              fakeBot = new FakeEntrypointMineflayerBot([]);
              fakeBot.setOwnerPosition("Steve", { x: 120, y: 64, z: -300 });

              setTimeout(() => fakeBot?.emit("spawn"), 0);

              return fakeBot;
            },
          },
        },
        botWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
        conversationWorker: {
          triage: () =>
            createConversationCompositeTriage({
              chat: {},
            }),
          replyGenerator: () =>
            Promise.resolve({
              mode: "llm" as const,
              reply: "我记住这里了喵~",
            }),
          createWorker: ({ processor }) => {
            conversationProcessor = processor;

            return {
              close: async () => undefined,
            };
          },
        },
      },
    });
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-05-03T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "hello",
      });

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-owner-position-memory",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "这里是我们的家",
          timestamp: "2026-05-03T00:00:03.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect
        .poll(() => capturedBrainTask?.payload)
        .toMatchObject({
          kind: "conversation_fact",
          owner_position_at_message: { x: 120, y: 64, z: -300 },
        });

      fakeBot?.setOwnerPosition("Steve", { x: 999, y: 70, z: 999 });
      await brainProcessor?.({ data: capturedBrainTask });
      expect(rubricInputs).toMatchObject([
        {
          source: "conversation_fact",
          owner_text: "这里是我们的家",
          owner_position: { x: 120, y: 64, z: -300 },
        },
      ]);
    } finally {
      socket.close();
      await waitForWsClose(socket);
      await runtime.close();
    }
  });

  it("应在真实在线入口组合 BotWorker（机器人工作线程） actionSink（动作汇点） 并写入 replay（补拉）", async () => {
    const customActions: string[] = [];
    const taskHistoryUpdates: unknown[] = [];
    let botProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-worker-replay-online",
      now: "2026-04-25T00:00:00.000Z",
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        infrastructure: {
          postgres: {
            createPool: () => ({
              end: async () => undefined,
            }),
            createDrizzle: () => ({
              insert: () => ({
                values: () => ({
                  onConflictDoNothing: async () => undefined,
                }),
              }),
              update: () => ({
                set: (values: unknown) => ({
                  where: async () => {
                    taskHistoryUpdates.push(values);
                  },
                }),
              }),
            }),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => createFakeIntentEpochRedisClient(),
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
          currentIntentEpoch: () => 2,
          actionSink: async (action) => {
            customActions.push(action.type);
          },
          createWorker: ({ processor: capturedProcessor }) => {
            botProcessor = capturedProcessor;

            return {
              close: async () => undefined,
            };
          },
        },
        conversationWorker: {
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    await botProcessor?.({
      data: createBotWorkerTask({
        bot_id: "bot-worker-replay-online",
        exec_job: createSandboxCodeJob({
          message_id: "msg-stale-task",
          intent_epoch: 1,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          code: "return true",
        }),
      }),
    });

    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-worker-replay-online&after_seq=0&limit=10",
    });
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-worker-replay-online",
    });

    expect(customActions).toEqual(["emit_task_lifecycle"]);
    expect(taskHistoryUpdates).toEqual([
      expect.objectContaining({
        status: TaskHistoryStatus.Discarded,
        finishedAt: expect.any(Date),
      }),
    ]);
    expect(replayResponse.json()).toMatchObject({
      events: [
        {
          seq: 1,
          bot_id: "bot-worker-replay-online",
          type: "task.discarded",
          payload: {
            job_id: "msg-stale-task",
            status: "discarded",
            message_id: "msg-stale-task",
            discard_reason: "intent_epoch_stale",
            current_epoch: 2,
          },
        },
      ],
    });
    expect(statusResponse.json()).toMatchObject({
      bot: {
        last_event_seq: 1,
        workers: {
          conversation: true,
          bot: true,
        },
      },
    });

    await runtime.close();
  });

  it("应在真实在线入口装配 server-bridge WebSocket 并写入 /api/replay", async () => {
    const queueAdds: Array<{ queue: string; jobId: unknown }> = [];
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const bootstrap = createAppBootstrapContract({
      botId: "bot-bridge-online",
      now: "2026-04-27T00:00:00.000Z",
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        serverBridge: {
          ...serverBridge,
          now: () => "2026-04-27T00:00:10.000Z",
          eventIdFactory: () => "server-bridge-event",
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
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (_jobName, _data, options) => {
                queueAdds.push({ queue: name, jobId: options?.jobId });

                return { id: "job-online" };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
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
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);

      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-04-27T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      const helloAck = JSON.parse(await readNextWsText(socket));

      socket.send(
        JSON.stringify({
          type: "heartbeat",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          sequence: 1,
          timestamp: "2026-04-27T00:00:02.000Z",
          state: "CONNECTED",
        }),
      );
      const heartbeatAck = JSON.parse(await readNextWsText(socket));

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-online-1",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "hello",
          timestamp: "2026-04-27T00:00:03.000Z",
        }),
      );
      const playerAck = JSON.parse(await readNextWsText(socket));
      const replayResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/replay?bot_id=bot-bridge-online&after_seq=0&limit=10",
      });
      const replayBody = replayResponse.json();
      const replayText = JSON.stringify(replayBody);

      expect(helloAck).toMatchObject({ type: "ack", ack_type: "hello" });
      expect(heartbeatAck).toMatchObject({ type: "ack", ack_type: "heartbeat" });
      expect(playerAck).toMatchObject({ type: "ack", ack_type: "player_message" });
      expect(replayResponse.statusCode).toBe(200);
      expect(replayBody).toMatchObject({
        bot_id: "bot-bridge-online",
        after_seq: 0,
        limit: 10,
        state: {
          last_event_seq: 4,
        },
        events: [
          {
            seq: 1,
            bot_id: "bot-bridge-online",
            type: "server_bridge.connected",
            payload: {
              runtime_effect: "observe_only",
              connection_state: "connected",
            },
          },
          {
            seq: 2,
            bot_id: "bot-bridge-online",
            type: "server_bridge.hello",
            payload: {
              runtime_effect: "observe_only",
              mod_id: "mcservant",
              instance_id: "local-fabric-01",
            },
          },
          {
            seq: 3,
            bot_id: "bot-bridge-online",
            type: "server_bridge.heartbeat",
            payload: {
              runtime_effect: "observe_only",
              sequence: 1,
              state: "CONNECTED",
            },
          },
          {
            seq: 4,
            bot_id: "bot-bridge-online",
            type: "server_bridge.player_message",
            payload: {
              runtime_effect: "observe_only",
              message_id: "msg-svs-online-1",
              player_uuid: "00000000-0000-0000-0000-000000000001",
              player_name: "Steve",
              content: "hello",
            },
          },
        ],
      });
      expect(replayText).not.toContain("local-dev-token");
      expect(queueAdds).toEqual([]);
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        await waitForWsClose(socket);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      await runtime.close();
    }
  });

  it("应在显式启用后把 /svs 玩家消息接入 ConversationWorker 并经 BotActor 写回聊天", async () => {
    const chats: string[] = [];
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const interrupts: unknown[] = [];
    const queueAdds: Array<{ queue: string; jobName: string; jobId: unknown; data: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const serverBridge = createAppServerBridgeConfigFromEnvironment({
      env: {
        SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
        SERVER_BRIDGE_CONVERSATION_ENABLED: "true",
      },
    });

    if (serverBridge === undefined) {
      throw new Error("test server bridge config must be enabled");
    }

    const bootstrap = createAppBootstrapContract({
      botId: "bot-bridge-conversation",
      now: "2026-04-27T00:00:00.000Z",
      env: {
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });
    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
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
            const assistantContent = userMessage.includes("Bot 状态：") ? '{"chat":{}}' : "你好呀";

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
          now: () => new Date("2026-04-27T00:00:10.000Z"),
        },
        serverBridge: {
          ...serverBridge,
          now: () => "2026-04-27T00:00:10.000Z",
          eventIdFactory: () => "server-bridge-conversation-event",
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
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (jobName, data, options) => {
                queueAdds.push({ queue: name, jobName, jobId: options?.jobId, data });
                if (name === "msg:bot-bridge-conversation") {
                  setTimeout(() => {
                    void processor?.({ data });
                  }, 0);
                }

                return { id: String(options?.jobId ?? "job-online") };
              },
              close: async () => undefined,
            }),
          },
          http: {
            createServer: () => {
              const server = Fastify();
              const originalListen = server.listen.bind(server);
              const originalClose = server.close.bind(server);

              server.listen = async () => originalListen({ host: "127.0.0.1", port: 0 });
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
    const socket = new WebSocket(
      `${runtime.listen_address.replace(/^http/, "ws")}/ws/server-bridge`,
      {
        headers: {
          Authorization: "Bearer local-dev-token",
        },
      },
    );

    try {
      await waitForWsOpen(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          mod_id: "mcservant",
          mod_version: "0.4.0",
          connected_at: "2026-04-27T00:00:01.000Z",
          instance_id: "local-fabric-01",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "hello",
      });

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-chat",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "你好",
          timestamp: "2026-04-27T00:00:03.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect.poll(() => chats).toContain("chat:你好呀喵~");

      socket.send(
        JSON.stringify({
          type: "player_message",
          protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
          instance_id: "local-fabric-01",
          message_id: "msg-svs-cancel",
          player_uuid: "00000000-0000-0000-0000-000000000001",
          player_name: "Steve",
          content: "取消",
          timestamp: "2026-04-27T00:00:04.000Z",
        }),
      );
      expect(JSON.parse(await readNextWsText(socket))).toMatchObject({
        type: "ack",
        ack_type: "player_message",
      });
      await expect.poll(() => chats).toContain("chat:好的，已经停下来了喵~");
      const replayResponse = await runtime.services.http.server.inject({
        method: "GET",
        url: "/api/replay?bot_id=bot-bridge-conversation&after_seq=0&limit=20",
      });
      const replayBody = replayResponse.json();

      expect(queueAdds.map((item) => [item.queue, item.jobName, item.jobId])).toEqual([
        ["msg:bot-bridge-conversation", "conversation", "msg-svs-chat"],
        ["brain", "brain", "conversation-fact-msg-svs-chat"],
      ]);
      expect(
        queueAdds
          .filter((item) => item.queue === "brain")
          .every((item) => typeof item.jobId === "string" && !item.jobId.includes(":")),
      ).toBe(true);
      expect(llmRequests).toHaveLength(2);
      expect(interrupts).toEqual([]);
      expect(replayBody.events.map((event: { type: string }) => event.type)).toEqual([
        "server_bridge.connected",
        "server_bridge.hello",
        "server_bridge.player_message",
        "task.accepted",
        "chat.reply",
        "server_bridge.player_message",
        "chat.reply",
      ]);
      expect(replayBody.events).toContainEqual(
        expect.objectContaining({
          type: "task.accepted",
          payload: expect.objectContaining({
            job_id: "msg-svs-chat",
            message_id: "msg-svs-chat",
            source: "server_bridge",
          }),
        }),
      );
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
        await waitForWsClose(socket);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      await runtime.close();
    }
  });

  it("应按环境变量解析默认入口的 server-bridge 启用 / 禁用 / 缺 token 边界", () => {
    expect(createAppServerBridgeConfigFromEnvironment({ env: {} })).toBeUndefined();
    expect(
      createAppServerBridgeConfigFromEnvironment({
        env: {
          SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
          SERVER_BRIDGE_PATH: "/ws/custom-bridge",
          SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS: "120000",
        },
      }),
    ).toEqual({
      enabled: true,
      accessToken: "local-dev-token",
      conversationEnabled: false,
      path: "/ws/custom-bridge",
      heartbeatTimeoutMs: 120_000,
    });
    expect(
      createAppServerBridgeConfigFromEnvironment({
        env: {
          SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
          SERVER_BRIDGE_CONVERSATION_ENABLED: "true",
        },
      }),
    ).toEqual({
      enabled: true,
      accessToken: "local-dev-token",
      conversationEnabled: true,
    });
    expect(
      createAppServerBridgeConfigFromEnvironment({
        env: {
          SERVER_BRIDGE_ENABLED: "false",
          SERVER_BRIDGE_ACCESS_TOKEN: "local-dev-token",
        },
      }),
    ).toBeUndefined();
    expect(() =>
      createAppServerBridgeConfigFromEnvironment({
        env: {
          SERVER_BRIDGE_ENABLED: "true",
        },
      }),
    ).toThrow("SERVER_BRIDGE_ACCESS_TOKEN must be configured");
  });

  it("应在真实在线入口把闲聊消息接到 OpenAI（开放人工智能） 兼容 LLM（大语言模型） 并写回聊天", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const memoryProviderCalls: unknown[] = [];
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
              ? '{"chat":{}}'
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
          memoryContextProvider: (input) => {
            memoryProviderCalls.push(input);

            return "历史：主人上次让 Bot 去过矿洞入口。";
          },
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
          content: "你还记得上次的矿洞吗",
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
      enable_thinking: false,
      reasoning_effort: "none",
      force_thinking_models: [],
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
    expect(memoryProviderCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-llm-online",
        message_id: "msg-online-chat",
        intent_epoch: 1,
        message_content: "你还记得上次的矿洞吗",
        route_kind: "chat_reply",
        query_reason: "composite_chat",
      }),
    ]);
    expect(chatRequestBody.messages?.[0]?.content).toContain(
      "记忆摘要：历史：主人上次让 Bot 去过矿洞入口。",
    );
    expect(chatRequestBody.messages?.[0]?.content).toContain(
      "[Bot] 位置:(0,0,0) 生命:20/20 饥饿:20/20 着火:否",
    );
    expect(chatRequestBody.messages?.[0]?.content).toContain("[世界] unknown");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[主人] 离线");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[背包] 空");
    expect(chatRequestBody.messages?.[0]?.content).toContain("[时间] 未知(unknown)");
    expect(chatRequestBody.messages?.[0]?.content).not.toContain("当前状态摘要：");
    expect(chatRequestBody.messages?.[0]?.content).not.toContain("世界交互：");
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
        last_event_seq: 1,
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
      state: {
        last_event_seq: 2,
      },
      events: [
        {
          seq: 1,
          bot_id: "bot-llm-online",
          type: "chat.reply",
          payload: {
            message_id: "msg-online-chat",
            content: "当然可以，我在这里喵~",
          },
        },
        {
          seq: 2,
          bot_id: "bot-llm-online",
          type: "task.accepted",
          payload: {
            job_id: "job-online",
            message_id: "msg-online-http",
            epoch: 1,
          },
        },
      ],
    });
    const replayAfterSeqResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-llm-online&after_seq=2&limit=10",
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
            stage: "triage",
            message_id: "msg-online-error",
            status: "error",
            model: "bl-auto",
            log_ref: "llm/2026-04-24/triage-msg-online-error.jsonl",
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

  it("应在真实在线入口把 triage（分诊） 解析失败落盘到 llm（大语言模型） JSONL（结构化日志）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const logsDir = await mkdtemp(join(tmpdir(), "ts-core-llm-diagnostics-"));
    const bootstrap = createAppBootstrapContract({
      botId: "bot-llm-parse-log-online",
      now: "2026-04-24T10:00:00.000Z",
      env: {
        LOGS_DIR: logsDir,
        LLM_BASE_URL: "http://127.0.0.1:8045/v1",
        LLM_API_KEY: "sk-local-dev",
        LLM_MODEL: "bl-auto",
      },
    });

    const runtime = await startAppOnlineRuntime({
      bootstrap,
      dependencies: {
        brainWorker: createNoopBrainWorkerDependencies(),
        llm: {
          api_key: "sk-local-dev",
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content:
                        '{"intent":"task","priority":"urgent","reason":"旧单层 triage 输出"}',
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
            ),
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
    });

    try {
      if (processor === undefined) {
        throw new Error("conversation processor must be captured");
      }

      await expect(
        processor({
          data: createConversationWorkerTask({
            bot_id: "bot-llm-parse-log-online",
            message: {
              bot_id: "bot-llm-parse-log-online",
              message_id: "msg-online-parse-error",
              content: "api_key=sk-local-dev 去 10 64 -5",
              intent_epoch: 1,
              snapshot_ts: 1_713_952_800_000,
            },
          }),
        }),
      ).rejects.toThrow("triage must use composite schema");

      const logPath = join(logsDir, "llm", "2026-04-24", "triage-msg-online-parse-error.jsonl");
      const logText = await readFile(logPath, "utf8");
      const logLines = logText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);

      expect(logLines).toHaveLength(4);
      expect(logLines[0]).toMatchObject({
        stage: "triage",
        model: "bl-auto",
        msg_id: "msg-online-parse-error",
      });
      expect(logLines[3]).toMatchObject({
        meta: {
          ok: false,
        },
        err: {
          message: "triage must use composite schema",
        },
      });
      expect(logText).toContain("<redacted>");
      expect(logText).not.toContain("sk-local-dev");
    } finally {
      await runtime.close();
      await rm(logsDir, { recursive: true, force: true });
    }
  });

  it("应在真实在线入口把自然语言坐标任务接到 LLM（大语言模型） 分诊与规划，并入 goTo（前往坐标） 执行队列", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    const taskHistoryInserts: unknown[] = [];
    const memoryProviderCalls: unknown[] = [];
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
              : '{"action":{"intent":"task","priority":"urgent","reason":"主人给了明确坐标移动指令"}}';

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
            createDrizzle: () => ({
              insert: () => ({
                values: (row: unknown) => ({
                  onConflictDoNothing: async () => {
                    taskHistoryInserts.push(row);
                  },
                }),
              }),
              update: () => ({
                set: () => ({
                  where: async () => undefined,
                }),
              }),
            }),
            warmupPool: async () => undefined,
          },
          redis: {
            createClient: () => createFakeIntentEpochRedisClient(),
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
          memoryContextProvider: (input) => {
            memoryProviderCalls.push(input);

            return "历史：主人上次要求到点后汇报坐标。";
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
    expect(memoryProviderCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-plan-online",
        message_id: "msg-online-plan",
        intent_epoch: 3,
        message_content: "请去坐标 x=10 y=64 z=-5",
        route_kind: "plan_exec",
        query_reason: "主人给了明确坐标移动指令",
      }),
    ]);
    const planRequestBody = llmRequests[1]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(planRequestBody.messages?.[1]?.content).toContain(
      "记忆摘要：历史：主人上次要求到点后汇报坐标。",
    );
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
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-plan-online",
            message_id: "msg-online-plan",
            owner_text: "请去坐标 x=10 y=64 z=-5",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-plan",
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
    expect(taskHistoryInserts).toEqual([
      expect.objectContaining({
        id: "msg-online-plan",
        botId: "bot-plan-online",
        status: TaskHistoryStatus.Accepted,
        skill: "goTo",
        params: { x: 10, y: 64, z: -5 },
        logRef: expect.stringMatching(/^tasks\/\d{4}-\d{2}-\d{2}\/msg-online-plan\.jsonl$/u),
      }),
    ]);
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

  it("应在真实在线入口允许 mine（挖掘）/collect（捡拾）/cutTree（砍树）/equip（装备） 技能", async () => {
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
            const currentInstruction = userMessage.split("主人的指令：").at(-1) ?? userMessage;
            let assistantContent =
              '{"action":{"intent":"task","priority":"normal","reason":"主人给了明确技能指令"}}';

            if (userMessage.includes("主人的指令：")) {
              if (currentInstruction.includes("挖两块石头")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我去挖石头","skill":"mine","params":{"blockName":"stone","count":2}}';
              } else if (currentInstruction.includes("把地上的圆石捡起来")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我去捡圆石","skill":"collect","params":{"itemName":"cobblestone","radius":32}}';
              } else if (currentInstruction.includes("把石镐拿在手上")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我先把石镐拿在手上","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}';
              } else if (currentInstruction.includes("砍 12 块木头")) {
                assistantContent =
                  '{"type":"skill_call","reply":"收到，我去砍 12 块木头","skill":"cutTree","params":{"count":12}}';
              } else {
                assistantContent =
                  '{"type":"cannot_plan","reason":"skill_not_enabled","code":"skill_not_enabled"}';
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
            createClient: () => createFakeIntentEpochRedisClient(),
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
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-skill-online",
        message: {
          bot_id: "bot-skill-online",
          message_id: "msg-online-cut-tree",
          content: "砍 12 块木头",
          intent_epoch: 8,
          snapshot_ts: 1_713_952_800_013,
        },
      }),
    });

    expect(llmRequests).toHaveLength(8);
    expect(queueAdds).toEqual([
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
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
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-mine",
            owner_text: "去挖两块石头",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-mine",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-collect",
            priority: "normal",
            skill: "collect",
            params: { itemName: "cobblestone", radius: 32 },
          }),
        }),
        options: {
          jobId: "msg-online-collect",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-collect",
            owner_text: "把地上的圆石捡起来",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-collect",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
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
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-equip",
            owner_text: "把石镐拿在手上",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-equip",
        },
      },
      {
        name: "bot:bot-skill-online:exec",
        jobName: "bot",
        data: expect.objectContaining({
          worker: "bot",
          bot_id: "bot-skill-online",
          exec_job: expect.objectContaining({
            message_id: "msg-online-cut-tree",
            priority: "normal",
            skill: "cutTree",
            params: { count: 12 },
          }),
        }),
        options: {
          jobId: "msg-online-cut-tree",
          priority: 5,
        },
      },
      {
        name: "brain",
        jobName: "brain",
        data: expect.objectContaining({
          worker: "brain",
          payload: expect.objectContaining({
            kind: "conversation_fact",
            bot_id: "bot-skill-online",
            message_id: "msg-online-cut-tree",
            owner_text: "砍 12 块木头",
            route_kind: "plan_exec",
          }),
        }),
        options: {
          jobId: "conversation-fact-msg-online-cut-tree",
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
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-skill-online",
      message_id: "msg-online-cut-tree",
      skill: "cutTree",
      priority: "normal",
    });

    await runtime.close();
  });

  it("应在真实在线入口把修改诉求表达为 cancel（取消） + task（任务） 并进入新规划", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: Array<{ name: string; jobName: string; data: unknown; options: unknown }> = [];
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const bootstrap = createAppBootstrapContract({
      botId: "bot-replace-online",
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
        brainWorker: createNoopBrainWorkerDependencies(),
        llm: {
          api_key: "sk-local-dev",
          fetch: async (url, init) => {
            llmRequests.push({
              url: String(url),
              body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            });

            const assistantContent =
              llmRequests.length === 1
                ? '{"cancel":{"reason":"主人要求替换当前移动目标","priority":"interrupt"},"action":{"intent":"task","priority":"urgent","reason":"主人要求去新坐标"}}'
                : '{"type":"skill_call","reply":"收到，我改去新的目标坐标","skill":"goTo","params":{"x":10,"y":64,"z":-5}}';

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
            createClient: () => createFakeIntentEpochRedisClient(),
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
        bot_id: "bot-replace-online",
        message: {
          bot_id: "bot-replace-online",
          message_id: "msg-online-replace",
          content: "把刚才的目标改成去 10 64 -5",
          intent_epoch: 4,
          snapshot_ts: 1_713_952_800_003,
        },
      }),
    });

    expect(llmRequests).toHaveLength(2);
    expect(queueAdds).toHaveLength(2);
    expect(queueAdds[0]).toMatchObject({
      name: "bot:bot-replace-online:exec",
      jobName: "bot",
      data: {
        bot_id: "bot-replace-online",
        exec_job: {
          message_id: "msg-online-replace",
          skill: "goTo",
          params: { x: 10, y: 64, z: -5 },
          priority: "urgent",
        },
      },
      options: {
        jobId: "msg-online-replace",
        priority: 1,
      },
    });
    expect(queueAdds[1]).toMatchObject({
      name: "brain",
      jobName: "brain",
      data: {
        worker: "brain",
        payload: expect.objectContaining({
          kind: "conversation_fact",
          bot_id: "bot-replace-online",
          message_id: "msg-online-replace",
          owner_text: "把刚才的目标改成去 10 64 -5",
          route_kind: "plan_exec",
        }),
      },
      options: {
        jobId: "conversation-fact-msg-online-replace",
      },
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      reason: "主人要求替换当前移动目标",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      skill: "goTo",
      priority: "urgent",
    });
    expect(runtime.conversation_worker.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-replace-online",
      message_id: "msg-online-replace",
      content: "好的，已经停下来了喵~",
    });
    expect(llmRequests[1]).toEqual({
      url: "http://127.0.0.1:8045/v1/chat/completions",
      body: expect.objectContaining({
        model: "bl-auto",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("主人的指令：把刚才的目标改成去 10 64 -5"),
          }),
        ]),
      }),
    });

    await runtime.close();
  });

  it("应在真实在线入口把 cancel（取消） 走 control fast-path（控制快路径） 且不入队", async () => {
    const llmRequests: Array<{ url: string; body: unknown }> = [];
    const queueAdds: unknown[] = [];
    const chats: string[] = [];
    const customBroadcasts: unknown[] = [];
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
        brainWorker: createNoopBrainWorkerDependencies(),
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
            createClient: () => createFakeIntentEpochRedisClient(),
            connectClient: async () => undefined,
            closeClient: async () => undefined,
          },
        },
        services: {
          workers: {
            createQueue: ({ name }) => ({
              name,
              add: async (jobName, data, options) => {
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
          broadcastReplySink: async (reply) => {
            customBroadcasts.push(reply);
          },
          createWorker: () => ({
            close: async () => undefined,
          }),
        },
      },
    });

    const response = await runtime.services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-cancel-online",
        message_id: "msg-online-cancel",
        content: "取消",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      bot_id: "bot-cancel-online",
      job_id: "msg-online-cancel",
      message_id: "msg-online-cancel",
    });
    expect(queueAdds).toEqual([]);
    expect(llmRequests).toEqual([]);
    expect(customBroadcasts).toEqual([
      {
        message_id: "msg-online-cancel",
        content: "好的，已经停下来了喵~",
      },
    ]);
    expect(chats).toEqual(["chat:好的，已经停下来了喵~"]);
    expect(runtime.conversation_worker.getEvents()).toEqual([]);
    const replayResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-cancel-online&after_seq=0&limit=10",
    });

    expect(replayResponse.json()).toMatchObject({
      events: [
        {
          seq: 1,
          bot_id: "bot-cancel-online",
          type: "chat.reply",
          payload: {
            message_id: "msg-online-cancel",
            content: "好的，已经停下来了喵~",
          },
        },
      ],
    });
    const statusResponse = await runtime.services.http.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-cancel-online",
    });

    expect(statusResponse.json()).toMatchObject({
      bot: {
        intent_epoch: 1,
      },
    });

    await runtime.close();
  });

  it("应把在线 blockUpdate（方块更新） 自动接入 ResourceService（资源服务） 缓存更新", async () => {
    let now = 1_712_000_300;
    const eventSource = new EventEmitter();
    const resourceService = createResourceService({
      now: () => now,
      worldKeyPort: {
        getCurrentWorldKey: () => "multiworld:resource",
      },
      refreshPort: {
        async refreshAroundBot(resourceKey, radius) {
          return {
            resource_key: resourceKey,
            radius,
            status: "found",
            world_key: "multiworld:resource",
            snapshot_version: "resource-online-block-update",
            scanned_at: now,
            origin: { x: 0, y: 64, z: 0 },
            blocks: [
              {
                block_name: "oak_log",
                position: { x: 0, y: 64, z: 0 },
                distance: 1,
                resource_keys: [resourceKey],
              },
              {
                block_name: "oak_log",
                position: { x: 1, y: 64, z: 0 },
                distance: 2,
                resource_keys: [resourceKey],
              },
              {
                block_name: "oak_log",
                position: { x: 2, y: 64, z: 0 },
                distance: 3,
                resource_keys: [resourceKey],
              },
            ],
            diagnostics: [],
          };
        },
      },
    });
    await resourceService.refresh("tree", 16);
    expect(resourceService.query("tree").clusters.map((cluster) => cluster.block_count)).toEqual([
      3,
    ]);

    const subscription = bindOnlineResourceServiceBlockUpdates({
      runtime: {
        observation: createObservationRuntimeCache(),
        transport: {
          getEventSource: () => eventSource,
          readObservationInput: () => null,
        },
      },
      resourceService,
      readOwnerName: () => undefined,
    });

    now += 1;
    eventSource.emit(
      "blockUpdate",
      { name: "oak_log", position: { x: 1, y: 64, z: 0 } },
      { name: "air", position: { x: 1, y: 64, z: 0 } },
    );

    expect(
      resourceService
        .query("tree")
        .clusters.map((cluster) => cluster.block_count)
        .sort(),
    ).toEqual([1, 1]);

    subscription?.close();
    now += 1;
    eventSource.emit(
      "blockUpdate",
      { name: "oak_log", position: { x: 0, y: 64, z: 0 } },
      { name: "air", position: { x: 0, y: 64, z: 0 } },
    );

    expect(
      resourceService
        .query("tree")
        .clusters.map((cluster) => cluster.block_count)
        .sort(),
    ).toEqual([1, 1]);
  });
});
