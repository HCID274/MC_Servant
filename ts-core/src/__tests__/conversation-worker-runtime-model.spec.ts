import { describe, expect, it } from "vitest";

import {
  createConversationCompositeTriage,
  createConversationRecentContextStore,
} from "../conversation/index.js";
import {
  ConversationLlmChatError,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
} from "../conversation/llm.js";
import {
  BotStatus,
  ExecPriority,
  createBotActorStateProjection,
  createSandboxCodeJob,
} from "../core-ports/index.js";
import type { EnvironmentSnapshot, InventorySummary } from "../core-ports/observation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import { createTaskSummaryDraft } from "../data/index.js";
import { createPostgresBrainMemoryStore } from "../db/index.js";
import { ConversationPriority } from "../domain/contracts.js";
import { createGoToSkillExecutionResult } from "../skills/index.js";
import { createBotWorkerRuntime } from "../workers/bot-worker.js";
import { createBrainWorkerRuntime } from "../workers/brain-worker.js";
import {
  createBotWorkerActions,
  createBotWorkerTask,
  createConversationWorkerTask,
} from "../workers/contracts.js";
import {
  createConversationBotWorkerActionSink,
  createConversationWorkerRuntime,
} from "../workers/conversation-worker.js";
import { createConversationWorkerMemoryContext } from "../workers/conversation-worker/helpers.js";
import {
  persistAcceptedTaskHistory,
  persistTaskHistoryLifecycleAction,
} from "../workers/task-history-sink.js";

function createCompositeChatTriage() {
  return createConversationCompositeTriage({
    chat: {},
  });
}

function createCompositeTaskTriage(input: {
  readonly priority: ConversationPriority;
  readonly reason: string;
}) {
  return createConversationCompositeTriage({
    action: {
      intent: "task",
      priority: input.priority,
      reason: input.reason,
    },
  });
}

function createCompositeCancelTriage(reason: string) {
  return createConversationCompositeTriage({
    cancel: {
      priority: "interrupt",
      reason,
    },
  });
}

function createFakeBrainMemoryDb(input: {
  readonly memoryRows: Record<string, unknown>[];
  readonly candidateRows: Record<string, unknown>[];
  readonly auditRows: Record<string, unknown>[];
}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => input.memoryRows,
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        const record = row as Record<string, unknown>;

        if (typeof record.confidence === "number") {
          input.candidateRows.push(record);

          return Promise.resolve(undefined);
        }
        if (typeof record.op === "string") {
          input.auditRows.push(record);

          return Promise.resolve(undefined);
        }

        return {
          async onConflictDoUpdate() {
            const existingIndex = input.memoryRows.findIndex(
              (memoryRow) => memoryRow.botId === record.botId && memoryRow.kind === record.kind,
            );
            const normalizedRow = {
              ...record,
              updatedAt:
                record.updatedAt instanceof Date
                  ? record.updatedAt
                  : new Date(String(record.updatedAt)),
            };

            if (existingIndex < 0) {
              input.memoryRows.push(normalizedRow);
            } else {
              input.memoryRows[existingIndex] = normalizedRow;
            }
          },
        };
      },
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => values,
      }),
    }),
  };
}

describe("ConversationWorker（对话工作线程） 真实运行时", () => {
  it("应由 conversation（对话） 侧 sink（汇点） 消费 sandbox finalize（沙盒终态） 并写入最近上下文", async () => {
    const store = createConversationRecentContextStore({ now: () => 10 });
    const sink = createConversationBotWorkerActionSink({ recentContextStore: store });
    const task = createBotWorkerTask({
      bot_id: "bot-cw",
      exec_job: createSandboxCodeJob({
        message_id: "msg-sandbox-failed",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: "await api.bot.goTo(1, 64, 1)",
      }),
    });

    for (const action of createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 1,
      error: {
        name: "Error",
        message: "path blocked\nwith stack details",
      },
      sandbox_result: {
        error: {
          name: "Error",
          message: "path blocked\nwith stack details",
        },
      },
    })) {
      await sink(action);
    }

    expect(store.getRounds()).toEqual([
      {
        aggregate_key: "message:msg-sandbox-failed",
        message_id: "msg-sandbox-failed",
        lines: ["报错：path blocked with stack details"],
      },
    ]);
  });

  it("应消费 chat（闲聊） 消息并通过 BotActor（机器人执行代理） sink（汇点） 广播回复", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const injectedStateContexts: Array<string | undefined> = [];
    let projectionCalls = 0;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () => {
          projectionCalls += 1;

          return createBotActorStateProjection({
            status: BotStatus.EXECUTING,
            ready: false,
            world_ready: true,
            current_task: {
              kind: "skill_call",
              message_id: "msg-mine",
              skill: "mine",
            },
          });
        },
        replyGenerator: (input) => {
          injectedStateContexts.push(input.state_context);

          return {
            mode: "llm",
            reply: "我听到啦",
            diagnostics: {
              stage: "chat",
              model: "bl-auto",
              message_id: "msg-chat",
              log_ref: "llm/2026-04-24/chat-msg-chat.jsonl",
              created_at: "2026-04-24T10:00:00.000Z",
              ok: true,
              lines: [],
            },
          };
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (record) => {
          replyLogs.push(record);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat",
          content: "你好",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-chat",
        content: "我听到啦喵~",
      },
    ]);
    expect(projectionCalls).toBe(1);
    expect(injectedStateContexts).toEqual([
      "当前状态：executing；ready：否；世界交互：已就绪；正在执行技能：mine（消息 msg-mine）",
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        bot_id: "bot-cw",
        message_id: "msg-chat",
        owner_message: "你好",
        route_kind: "chat_reply",
        reply_mode: "llm",
        reply: "我听到啦喵~",
        contexts: {
          state_context:
            "当前状态：executing；ready：否；世界交互：已就绪；正在执行技能：mine（消息 msg-mine）",
        },
        llm_diagnostics: expect.objectContaining({
          stage: "chat",
          message_id: "msg-chat",
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "llm.chat.diagnostic",
      bot_id: "bot-cw",
      stage: "chat",
      message_id: "msg-chat",
      model: "bl-auto",
      log_ref: "llm/2026-04-24/chat-msg-chat.jsonl",
      created_at: "2026-04-24T10:00:00.000Z",
      ok: true,
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-chat",
      content: "我听到啦喵~",
    });
  });

  it("应在下一轮 chat（闲聊） prompt（提示词）构建期注入合并后的最近上下文", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const store = createConversationRecentContextStore({ now: () => 0 });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        recentContextStore: store,
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () =>
          createBotActorStateProjection({
            status: BotStatus.IDLE,
            ready: true,
            world_ready: true,
            recent_events: [
              {
                message_id: "msg-1",
                line: "collect 成功,捡到 shield x1",
                timestamp: 30,
              },
            ],
          }),
        replyGenerator: (input) => {
          recentContexts.push(input.recent_context);

          return `第 ${recentContexts.length} 次回复`;
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-1", content: "去捡盾牌" },
      { id: "msg-2", content: "你刚刚捡到了什么" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(recentContexts[0]).toBeUndefined();
    expect(recentContexts[1]).toContain("主人：去捡盾牌");
    expect(recentContexts[1]).toContain("Bot：第 1 次回复喵~");
    expect(recentContexts[1]).toContain("执行结果：collect 成功,捡到 shield x1");
    expect(recentContexts[1]).not.toContain("你刚刚捡到了什么");
  });

  it("prompt（提示词） 最近上下文窗口应限制为最近 5 轮原文", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const recentContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: (input) => {
          recentContexts.push(input.recent_context);

          return "收到";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (let index = 1; index <= 7; index += 1) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: `msg-window-${index}`,
            content: `第 ${index} 轮`,
            intent_epoch: index,
            snapshot_ts: 100 + index,
          },
        }),
      });
    }

    const lastPromptContext = recentContexts.at(-1);
    expect(lastPromptContext).not.toContain("第 1 轮");
    expect(lastPromptContext).toContain("第 2 轮");
    expect(lastPromptContext).toContain("第 6 轮");
    expect(lastPromptContext).not.toContain("第 7 轮");
  });

  it("应让 Chat（闲聊） 约定地点进入 Brain（大脑）并让后续 Plan（规划）使用约定时坐标", async () => {
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryRows: Record<string, unknown>[] = [];
    const candidateRows: Record<string, unknown>[] = [];
    const auditRows: Record<string, unknown>[] = [];
    const brainMemoryStore = createPostgresBrainMemoryStore({
      db: createFakeBrainMemoryDb({ memoryRows, candidateRows, auditRows }),
    });
    const rubricInputs: unknown[] = [];
    const enqueuedExecTasks: unknown[] = [];
    const snapshots = [
      createEnvironmentSnapshotFixture([], { x: -24.8, y: 105, z: -15.6 }),
      createEnvironmentSnapshotFixture([], { x: 88, y: 70, z: 99 }),
    ];
    const brainRuntime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-05-03T02:00:00.000Z"),
        async generateEmbedding() {
          throw new Error("chat fact should not write task_events");
        },
        async persistTaskEvent() {
          throw new Error("chat fact should not persist task_events");
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
            if (input.owner_text !== "这里以后就是秘密基地") {
              return [];
            }

            return [
              {
                kind: "MEMORY",
                content: `秘密基地坐标：x=${input.owner_position?.x}, y=${input.owner_position?.y}, z=${input.owner_position?.z}`,
                confidence: 0.95,
                reason: "主人命名当前位置",
              },
            ];
          },
          async resolveMemoryCapacity() {
            throw new Error("capacity should not run");
          },
        },
        loadBotMemory: brainMemoryStore.loadBotMemory,
        insertMemoryCandidate: brainMemoryStore.insertMemoryCandidate,
        decideMemoryCandidate: brainMemoryStore.decideMemoryCandidate,
        writeBotMemory: brainMemoryStore.writeBotMemory,
        appendMemoryAudit: brainMemoryStore.appendMemoryAudit,
        createWorker: ({ processor }) => {
          brainProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const conversationRuntime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor }) => {
          conversationProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
        triage: ({ task }) =>
          task.message.content === "去秘密基地"
            ? createCompositeTaskTriage({
                priority: ConversationPriority.Normal,
                reason: "owner_target_secret_base",
              })
            : createCompositeChatTriage(),
        environmentSnapshotProvider: () =>
          snapshots.shift() ?? createEnvironmentSnapshotFixture([]),
        brainContextProvider: () => ({
          memory: {
            USER: "",
            MEMORY: typeof memoryRows[0]?.content === "string" ? String(memoryRows[0].content) : "",
            SKILL: "",
          },
        }),
        replyGenerator: () => "我记住了",
        planner: (input) => {
          expect(input.brain_context).toContain("秘密基地坐标：x=-24.8, y=105, z=-15.6");
          expect(input.brain_context).not.toContain("x=88");

          return {
            type: "skill_call",
            reply: "我去秘密基地",
            skill: "goTo",
            params: { x: -24.8, y: 105, z: -15.6 },
          };
        },
        enqueueBrainFactSink: async ({ task }) => {
          await brainProcessor?.({ data: task });
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await brainRuntime.start();
    await conversationRuntime.start();
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-secret-base-chat",
          content: "这里以后就是秘密基地",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-go-secret-base",
          content: "去秘密基地",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toEqual(
      expect.objectContaining({
        id: "memory-candidate:conversation-fact:bot-cw:msg-secret-base-chat:0",
        botId: "bot-cw",
        kind: "MEMORY",
        content: "秘密基地坐标：x=-24.8, y=105, z=-15.6",
        confidence: 0.95,
        status: "pending",
      }),
    );
    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]).toEqual(
      expect.objectContaining({
        botId: "bot-cw",
        kind: "MEMORY",
        content: "秘密基地坐标：x=-24.8, y=105, z=-15.6",
      }),
    );
    expect(rubricInputs).toEqual([
      expect.objectContaining({
        source: "conversation_fact",
        owner_text: "这里以后就是秘密基地",
        route_kind: "chat_reply",
        owner_position: { x: -24.8, y: 105, z: -15.6 },
      }),
      expect.objectContaining({
        source: "conversation_fact",
        owner_text: "去秘密基地",
        route_kind: "plan_exec",
        owner_position: { x: 88, y: 70, z: 99 },
      }),
    ]);
    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        owner_text: "去秘密基地",
        owner_position_at_message: { x: 88, y: 70, z: 99 },
        exec_job: expect.objectContaining({
          params: { x: -24.8, y: 105, z: -15.6 },
        }),
      }),
    ]);

    await conversationRuntime.close();
    await brainRuntime.close();
  });

  it("Brain fact（大脑事实）入队失败不得截断 Chat（闲聊）回复日志", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const brainDiagnostics: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => "我记住了",
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (entry) => {
          replyLogs.push(entry);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async (record) => {
          brainDiagnostics.push(record);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-fact-fail",
          content: "这里定义为日月川了",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-chat-fact-fail",
        content: "我记住了喵~",
      },
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        message_id: "msg-chat-fact-fail",
        reply: "我记住了喵~",
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-fail",
      route_kind: "chat_reply",
      error_summary: "brain queue unavailable",
    });
    expect(brainDiagnostics).toEqual([
      expect.objectContaining({
        log_ref: expect.stringMatching(
          /^brain\/\d{4}-\d{2}-\d{2}\/fact-enqueue-failed-msg-chat-fact-fail\.jsonl$/u,
        ),
        lines: [
          expect.objectContaining({
            event: "brain.fact.enqueue_failed",
            bot_id: "bot-cw",
            message_id: "msg-chat-fact-fail",
            route_kind: "chat_reply",
            error: {
              name: "Error",
              message: "brain queue unavailable",
            },
          }),
        ],
      }),
    ]);

    await runtime.close();
  });

  it("Brain fact（大脑事实）入队失败不得阻塞 Plan（规划）执行任务入队", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "owner_target_named_place",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          type: "skill_call",
          reply: "我去日月川",
          skill: "goTo",
          params: { x: 10, y: 64, z: 20 },
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-fact-fail",
          content: "去登上日月川",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        exec_job: expect.objectContaining({
          message_id: "msg-plan-fact-fail",
          skill: "goTo",
          params: { x: 10, y: 64, z: 20 },
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-fail",
      skill: "goTo",
      priority: "normal",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-fail",
      route_kind: "plan_exec",
      error_summary: "brain queue unavailable",
    });

    await runtime.close();
  });

  it("Brain fact（大脑事实）与诊断汇点双失败也不得截断 Chat（闲聊）主路径", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const replyLogs: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => "我记住了",
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        conversationReplyLogSink: async (entry) => {
          replyLogs.push(entry);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async () => {
          throw new Error("brain diagnostic unavailable");
        },
      },
    });

    await runtime.start();
    expect(processor).toBeDefined();
    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-chat-fact-diagnostic-fail",
            content: "这里定义为日月川了",
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(replies).toEqual([
      {
        message_id: "msg-chat-fact-diagnostic-fail",
        content: "我记住了喵~",
      },
    ]);
    expect(replyLogs).toEqual([
      expect.objectContaining({
        message_id: "msg-chat-fact-diagnostic-fail",
        reply: "我记住了喵~",
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-diagnostic-fail",
      route_kind: "chat_reply",
      error_summary: "brain queue unavailable",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.diagnostic_failed",
      bot_id: "bot-cw",
      message_id: "msg-chat-fact-diagnostic-fail",
      route_kind: "chat_reply",
      enqueue_error_summary: "brain queue unavailable",
      diagnostic_error_summary: "brain diagnostic unavailable",
    });

    await runtime.close();
  });

  it("Brain fact（大脑事实）与诊断汇点双失败也不得阻塞 Plan（规划）执行入队", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "owner_target_named_place",
          }),
        environmentSnapshotProvider: () => createEnvironmentSnapshotFixture([]),
        planner: () => ({
          type: "skill_call",
          reply: "我去日月川",
          skill: "goTo",
          params: { x: 10, y: 64, z: 20 },
        }),
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        enqueueBrainFactSink: async () => {
          throw new Error("brain queue unavailable");
        },
        brainDiagnosticSink: async () => {
          throw new Error("brain diagnostic unavailable");
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    expect(processor).toBeDefined();
    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-plan-fact-diagnostic-fail",
            content: "去登上日月川",
            intent_epoch: 2,
            snapshot_ts: 101,
          },
        }),
      }),
    ).resolves.toBeUndefined();

    expect(enqueuedExecTasks).toEqual([
      expect.objectContaining({
        exec_job: expect.objectContaining({
          message_id: "msg-plan-fact-diagnostic-fail",
          skill: "goTo",
          params: { x: 10, y: 64, z: 20 },
        }),
      }),
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      skill: "goTo",
      priority: "normal",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.enqueue_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      route_kind: "plan_exec",
      error_summary: "brain queue unavailable",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "brain.fact.diagnostic_failed",
      bot_id: "bot-cw",
      message_id: "msg-plan-fact-diagnostic-fail",
      route_kind: "plan_exec",
      enqueue_error_summary: "brain queue unavailable",
      diagnostic_error_summary: "brain diagnostic unavailable",
    });

    await runtime.close();
  });

  it("应串起 ConversationWorker / BotWorker / BrainWorker（三工作线程）并写入 task_history 与 task_events", async () => {
    let conversationProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let botProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let brainProcessor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryRows: Record<string, unknown>[] = [];
    const candidateRows: Record<string, unknown>[] = [];
    const auditRows: Record<string, unknown>[] = [];
    const taskHistoryRows: Record<string, unknown>[] = [];
    const taskHistoryUpdates: Record<string, unknown>[] = [];
    const taskEventRows: Record<string, unknown>[] = [];
    const snapshots = [
      createEnvironmentSnapshotFixture([], { x: 10, y: 64, z: 20 }),
      createEnvironmentSnapshotFixture([], { x: 80, y: 64, z: 80 }),
    ];
    const taskHistoryStore = {
      async insertAccepted(record: Record<string, unknown>) {
        taskHistoryRows.push({ ...record });
      },
      async markStarted(patch: Record<string, unknown>) {
        taskHistoryUpdates.push({ ...patch });
        const row = taskHistoryRows.find((candidate) => candidate.id === patch.id);
        if (row !== undefined) {
          row.status = TaskHistoryStatus.Started;
        }
      },
      async markTerminal(patch: Record<string, unknown>) {
        taskHistoryUpdates.push({ ...patch });
        const row = taskHistoryRows.find((candidate) => candidate.id === patch.id);
        if (row !== undefined) {
          row.status = patch.status;
        }
      },
      async markDiscarded(input: { readonly id: string; readonly discarded_at: string }) {
        taskHistoryUpdates.push({ ...input, status: TaskHistoryStatus.Discarded });
        const row = taskHistoryRows.find((candidate) => candidate.id === input.id);
        if (row !== undefined) {
          row.status = TaskHistoryStatus.Discarded;
        }
      },
    };
    const brainMemoryStore = createPostgresBrainMemoryStore({
      db: createFakeBrainMemoryDb({ memoryRows, candidateRows, auditRows }),
    });
    const brainRuntime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-05-04T01:00:00.000Z"),
        async generateEmbedding() {
          return [0.1, 0.2, 0.3];
        },
        async persistTaskEvent(draft) {
          expect(taskHistoryRows.some((row) => row.id === draft.task_id)).toBe(true);
          taskEventRows.push({ ...draft });
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
            if (input.owner_text !== "这里定义为日月川了") {
              return [];
            }

            return [
              {
                kind: "MEMORY",
                content: `日月川坐标：x=${input.owner_position?.x}, y=${input.owner_position?.y}, z=${input.owner_position?.z}`,
                confidence: 0.95,
                reason: "主人命名当前位置",
              },
            ];
          },
          async resolveMemoryCapacity() {
            throw new Error("capacity should not run");
          },
        },
        loadBotMemory: brainMemoryStore.loadBotMemory,
        insertMemoryCandidate: brainMemoryStore.insertMemoryCandidate,
        decideMemoryCandidate: brainMemoryStore.decideMemoryCandidate,
        writeBotMemory: brainMemoryStore.writeBotMemory,
        appendMemoryAudit: brainMemoryStore.appendMemoryAudit,
        createWorker: ({ processor }) => {
          brainProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const botRuntime = createBotWorkerRuntime({
      queue: {
        name: "bot:bot-cw:exec",
        connection: {},
      },
      dependencies: {
        actor: {
          async executeSkill(job) {
            return {
              result: createGoToSkillExecutionResult(job.params),
              snapshot: {} as never,
            };
          },
          async executeSandboxCode() {
            throw new Error("sandbox should not run");
          },
        },
        now: (() => {
          const values = [1000, 1042];

          return () => values.shift() ?? 1042;
        })(),
        actionSink: async (action) => {
          await persistTaskHistoryLifecycleAction({
            action,
            taskHistoryStore,
            now: () => new Date("2026-05-04T01:00:01.000Z"),
          });
          if (action.type === "enqueue_brain") {
            await brainProcessor?.({ data: action.task });
          }
        },
        createWorker: ({ processor }) => {
          botProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const conversationRuntime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor }) => {
          conversationProcessor = processor;

          return {
            close: async () => undefined,
          };
        },
        triage: ({ task }) =>
          task.message.content === "去登上日月川"
            ? createCompositeTaskTriage({
                priority: ConversationPriority.Normal,
                reason: "owner_target_named_place",
              })
            : createCompositeChatTriage(),
        environmentSnapshotProvider: () =>
          snapshots.shift() ?? createEnvironmentSnapshotFixture([]),
        brainContextProvider: () => ({
          memory: {
            USER: "",
            MEMORY: typeof memoryRows[0]?.content === "string" ? String(memoryRows[0].content) : "",
            SKILL: "",
          },
        }),
        replyGenerator: () => "我记住了",
        planner: (input) => {
          expect(input.brain_context).toContain("日月川坐标：x=10, y=64, z=20");

          return {
            type: "skill_call",
            reply: "我去日月川",
            skill: "goTo",
            params: { x: 10, y: 64, z: 20 },
          };
        },
        enqueueBrainFactSink: async ({ task }) => {
          await brainProcessor?.({ data: task });
        },
        enqueueExecTaskSink: async ({ task }) => {
          await persistAcceptedTaskHistory({
            bot_id: task.bot_id,
            task,
            taskHistoryStore,
            now: () => new Date("2026-05-04T01:00:00.000Z"),
          });
          await botProcessor?.({ data: task });
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await brainRuntime.start();
    await botRuntime.start();
    await conversationRuntime.start();
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-sun-moon-river",
          content: "这里定义为日月川了",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });
    await conversationProcessor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-go-sun-moon-river",
          content: "去登上日月川",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(memoryRows).toEqual([
      expect.objectContaining({
        kind: "MEMORY",
        content: "日月川坐标：x=10, y=64, z=20",
      }),
    ]);
    expect(taskHistoryRows).toEqual([
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Completed,
      }),
    ]);
    expect(taskHistoryUpdates).toEqual([
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Started,
      }),
      expect.objectContaining({
        id: "msg-go-sun-moon-river",
        status: TaskHistoryStatus.Completed,
      }),
    ]);
    expect(taskEventRows).toEqual([
      expect.objectContaining({
        task_id: "msg-go-sun-moon-river",
        owner_text: "去登上日月川",
        embedding: [0.1, 0.2, 0.3],
      }),
    ]);

    await conversationRuntime.close();
    await botRuntime.close();
    await brainRuntime.close();
  });

  it("Plan（规划） cannot_plan（无法规划） 时应统一失败，不再改写成对话事实", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const brainFacts: unknown[] = [];
    const enqueuedExecTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "LLM 误把地点记忆当任务",
          }),
        environmentSnapshotProvider: () =>
          createEnvironmentSnapshotFixture([], { x: 7.7, y: 118, z: -35.6 }),
        planner: () => {
          throw new ConversationLlmPlanError("conversation_fact");
        },
        enqueueBrainFactSink: async ({ task }) => {
          brainFacts.push(task);
        },
        enqueueExecTaskSink: async ({ task }) => {
          enqueuedExecTasks.push(task);
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-canyon-top",
          content: "记住这里为峡谷之巅",
          intent_epoch: 12,
          snapshot_ts: 300,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-canyon-top",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(enqueuedExecTasks).toEqual([]);
    expect(brainFacts).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-canyon-top",
      content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
    });
    expect(runtime.getEvents().some((event) => event.type === "task.accepted")).toBe(false);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-canyon-top",
      status: TaskHistoryStatus.Discarded,
      reason: "planner_failed",
    });
  });

  it("应让 Chat / Plan / Plan（三路） 按路径出口顺序递推 inventory diff（背包差异） baseline（基线）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const inventoryChanges: Array<string | undefined> = [];
    const snapshotContexts: string[] = [];
    const triages = [
      createCompositeChatTriage(),
      createCompositeTaskTriage({
        priority: ConversationPriority.Normal,
        reason: "unit_plan_inventory",
      }),
      createCompositeTaskTriage({
        priority: ConversationPriority.Urgent,
        reason: "unit_replace_inventory",
      }),
    ];
    const snapshots = [
      createEnvironmentSnapshotFixture([["oak_log", 1]]),
      createEnvironmentSnapshotFixture([
        ["oak_log", 6],
        ["cobblestone", 4],
      ]),
      createEnvironmentSnapshotFixture([
        ["oak_log", 4],
        ["cobblestone", 4],
        ["iron_ingot", 2],
      ]),
    ];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => triages.shift() ?? createCompositeChatTriage(),
        environmentSnapshotProvider: () => {
          const snapshot = snapshots.shift();

          if (snapshot === undefined) {
            throw new Error("unexpected snapshot read");
          }

          return snapshot;
        },
        replyGenerator: (input) => {
          inventoryChanges.push(input.inventory_change_context);
          if (input.snapshot_context !== undefined) {
            snapshotContexts.push(input.snapshot_context);
          }

          return "看到背包了";
        },
        planner: (input) => {
          inventoryChanges.push(input.inventory_change_context);
          if (input.snapshot_context !== undefined) {
            snapshotContexts.push(input.snapshot_context);
          }

          return {
            type: "skill_call",
            reply: "收到，我去执行",
            skill: "goTo",
            params: { x: 1, y: 64, z: -3 },
          };
        },
        interruptRuntimeSink: async () => undefined,
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-inventory-chat", content: "现在背包如何" },
      { id: "msg-inventory-plan", content: "去坐标 1 64 -3" },
      { id: "msg-inventory-replace", content: "改成快点过去" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(inventoryChanges).toEqual([
      undefined,
      "oak_log+5, cobblestone+4",
      "oak_log-2, iron_ingot+2",
    ]);
    expect(snapshotContexts[0]).not.toContain("[背包变化]");
    expect(snapshotContexts[1]).toContain("[背包变化] oak_log+5, cobblestone+4");
    expect(snapshotContexts[2]).toContain("[背包变化] oak_log-2, iron_ingot+2");
  });

  it("Cancel（取消） 路径不应读写 inventory diff cache（背包差异缓存）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let snapshotReads = 0;
    const inventoryChanges: Array<string | undefined> = [];
    const triages = [
      createCompositeCancelTriage("unit_cancel_inventory"),
      createCompositeChatTriage(),
    ];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => triages.shift() ?? createCompositeChatTriage(),
        environmentSnapshotProvider: () => {
          snapshotReads += 1;

          return createEnvironmentSnapshotFixture([["oak_log", 5]]);
        },
        replyGenerator: (input) => {
          inventoryChanges.push(input.inventory_change_context);

          return "取消后闲聊";
        },
        interruptRuntimeSink: async () => undefined,
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    for (const message of [
      { id: "msg-inventory-cancel", content: "停下" },
      { id: "msg-inventory-chat-after-cancel", content: "背包变化了吗" },
    ]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: message.id,
            content: message.content,
            intent_epoch: 1,
            snapshot_ts: 100,
          },
        }),
      });
    }

    expect(snapshotReads).toBe(1);
    expect(inventoryChanges).toEqual([undefined]);
  });

  it("应在状态投影读取失败时降级为无状态闲聊", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const stateContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        actorStateProjectionProvider: () => {
          throw new Error("projection source unavailable");
        },
        replyGenerator: (input) => {
          stateContexts.push(input.state_context);

          return "无状态回复";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-projection-failed",
          content: "你在干嘛",
          intent_epoch: 1,
          snapshot_ts: 100,
        },
      }),
    });

    expect(stateContexts).toEqual([undefined]);
  });

  it("应只在 chat（闲聊） 路由需要 memory（记忆） 时读取并注入 memory_context（记忆上下文）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryCalls: unknown[] = [];
    const memoryContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        memoryContextProvider: (input) => {
          memoryCalls.push(input);

          return createConversationWorkerMemoryContext({
            results: [
              {
                summary: createTaskSummaryDraft({
                  task_id: "msg-memory-older",
                  bot_id: "bot-cw",
                  message_id: "msg-memory-older",
                  intent: "旧矿洞探索",
                  status: TaskHistoryStatus.Completed,
                  summary: "主人上次让 Bot 标记了矿洞入口。",
                  created_at: "2026-04-25T00:00:00.000Z",
                }),
                score: 0.4,
              },
              {
                summary: createTaskSummaryDraft({
                  task_id: "msg-memory-newer",
                  bot_id: "bot-cw",
                  message_id: "msg-memory-newer",
                  intent: "矿洞返回",
                  status: TaskHistoryStatus.Interrupted,
                  summary: "Bot 因取消指令中断返回。",
                  created_at: "2026-04-26T00:00:00.000Z",
                }),
                score: 0.9,
              },
            ],
            limit: 1,
            char_budget: 120,
          });
        },
        replyGenerator: (input) => {
          memoryContexts.push(input.memory_context);

          return "记得";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-memory",
          content: "你还记得上次的矿洞吗",
          intent_epoch: 9,
          snapshot_ts: 108,
        },
      }),
    });
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-chat-no-memory",
          content: "今天你好呀",
          intent_epoch: 10,
          snapshot_ts: 109,
        },
      }),
    });

    expect(memoryCalls).toEqual([
      expect.objectContaining({
        bot_id: "bot-cw",
        message_id: "msg-chat-memory",
        intent_epoch: 9,
        message_content: "你还记得上次的矿洞吗",
        route_kind: "chat_reply",
        query_reason: "composite_chat",
        limit: 5,
        char_budget: 800,
      }),
    ]);
    expect(memoryContexts).toEqual(["[interrupted] 矿洞返回: Bot 因取消指令中断返回。", undefined]);
  });

  it("应只记录 cancel（取消） 路径，不写入 Mineflayer（Minecraft 协议客户端） 聊天", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const interrupts: Array<{ bot_id: string; signal: unknown }> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeCancelTriage("owner_cancel"),
        replyGenerator: () => {
          throw new Error("cancel route must not call reply generator");
        },
        actorStateProjectionProvider: () => {
          throw new Error("cancel route must not call actor state projection provider");
        },
        interruptRuntimeSink: async (interrupt) => {
          interrupts.push(interrupt);
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-cancel",
          content: "取消",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-cancel",
        content: "好的，已经停下来了喵~",
      },
    ]);
    expect(interrupts).toEqual([
      {
        bot_id: "bot-cw",
        signal: {
          source: {
            type: "triage",
            intent_epoch: 2,
          },
          reason: "owner_cancel",
        },
      },
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-cancel",
      content: "好的，已经停下来了喵~",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-cw",
      message_id: "msg-cancel",
      reason: "owner_cancel",
    });
  });

  it("应在无 planner（规划器） 时丢弃 task（任务） 路径且不入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "needs_planner",
          }),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-task",
          content: "去砍树",
          intent_epoch: 3,
          snapshot_ts: 102,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-task",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-task",
      content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-task",
      status: "discarded",
      reason: "planner_unavailable",
    });
  });

  it("应通过 planner（规划器） 把自然语言移动任务转换为 goTo（前往坐标） 执行队列任务", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Urgent,
            reason: "llm_task_goto",
          }),
        planner: async () => ({
          type: "skill_call",
          reply: "收到，我这就去目标坐标",
          skill: "goTo",
          params: { x: 10, y: 64, z: -5 },
        }),
        actorStateProjectionProvider: () => {
          throw new Error("plan route must not call actor state projection provider");
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-goto",
          content: "请去坐标 x=10 y=64 z=-5",
          intent_epoch: 4,
          snapshot_ts: 103,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-goto",
        content: "收到，我这就去目标坐标喵~",
      },
    ]);
    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 1,
      task: {
        worker: "bot",
        bot_id: "bot-cw",
        queue: "bot:bot-cw:exec",
        exec_job: {
          message_id: "msg-goto",
          intent_epoch: 4,
          snapshot_ts: 103,
          priority: "urgent",
          skill: "goTo",
          params: { x: 10, y: 64, z: -5 },
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-goto",
      skill: "goTo",
      priority: "urgent",
    });
  });

  it("应在 plan（规划） 路径读取 memory（记忆） 与资源摘要，并在 provider（提供器） 失败时降级", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const memoryContexts: Array<string | undefined> = [];
    const resourceContexts: Array<string | undefined> = [];
    let callCount = 0;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_plan_memory",
          }),
        memoryContextProvider: () => {
          callCount += 1;

          if (callCount === 2) {
            throw new Error("memory backend unavailable");
          }

          return "历史：主人之前要求先装备镐子。";
        },
        resourceContextProvider: (input) => {
          if (input.message_id === "msg-plan-memory-fallback") {
            throw new Error("resource index unavailable");
          }

          return "resources: tree: found 1 cluster(s): tree-a count=3 nearest=6.0 radius=16";
        },
        planner: async (input) => {
          memoryContexts.push(input.memory_context);
          resourceContexts.push(input.resource_context);

          return {
            type: "skill_call",
            reply: "收到，我去目标坐标",
            skill: "goTo",
            params: { x: 1, y: 64, z: -3 },
          };
        },
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    for (const messageId of ["msg-plan-memory", "msg-plan-memory-fallback"]) {
      await processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: messageId,
            content: "去挖一块石头",
            intent_epoch: 11,
            snapshot_ts: 110,
          },
        }),
      });
    }

    expect(memoryContexts).toEqual(["历史：主人之前要求先装备镐子。", undefined]);
    expect(resourceContexts).toEqual([
      "resources: tree: found 1 cluster(s): tree-a count=3 nearest=6.0 radius=16",
      undefined,
    ]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-plan-memory-fallback",
      skill: "goTo",
      priority: "normal",
    });
  });

  it("应按 cancel（取消）→chat（闲聊）→action（动作） 顺序派发 composite triage（复合分诊）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const calls: string[] = [];
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createConversationCompositeTriage({
            cancel: {
              reason: "owner_composite_cancel",
              priority: "interrupt",
            },
            chat: {},
            action: {
              intent: "task",
              priority: ConversationPriority.Urgent,
              reason: "owner_composite_goto",
            },
          }),
        interruptRuntimeSink: async () => {
          calls.push("interrupt");
        },
        broadcastReplySink: async (reply) => {
          calls.push(`reply:${reply.content}`);
          replies.push(reply);
        },
        replyGenerator: () => {
          calls.push("chat");

          return "Stage 2 收到";
        },
        planner: async () => {
          calls.push("planner");

          return {
            type: "skill_call",
            reply: "收到，我这就去目标坐标",
            skill: "goTo",
            params: { x: 1, y: 64, z: -3 },
          };
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          calls.push("enqueue");
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-composite",
          content: "停下当前任务，回我一句知道了，然后去坐标 1 64 -3",
          intent_epoch: 7,
          snapshot_ts: 106,
        },
      }),
    });

    expect(calls).toEqual(["interrupt", "chat", "reply:Stage 2 收到喵~", "planner", "enqueue"]);
    expect(replies).toEqual([
      {
        message_id: "msg-composite",
        content: "Stage 2 收到喵~",
      },
    ]);
    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 1,
      task: {
        exec_job: {
          message_id: "msg-composite",
          priority: "urgent",
          skill: "goTo",
          params: { x: 1, y: 64, z: -3 },
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "cancel.logged",
      bot_id: "bot-cw",
      message_id: "msg-composite",
      reason: "owner_composite_cancel",
    });
    expect(runtime.getEvents().filter((event) => event.type === "chat.reply")).toEqual([
      {
        type: "chat.reply",
        bot_id: "bot-cw",
        message_id: "msg-composite",
        content: "Stage 2 收到喵~",
      },
    ]);
  });

  it("应让无显式文本的 composite chat（复合闲聊） 复用状态上下文闲聊路径", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const stateContexts: Array<string | undefined> = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createConversationCompositeTriage({
            chat: {},
          }),
        actorStateProjectionProvider: () =>
          createBotActorStateProjection({
            status: BotStatus.EXECUTING,
            ready: false,
            world_ready: true,
            current_task: {
              kind: "skill_call",
              message_id: "msg-goto",
              skill: "goTo",
            },
          }),
        replyGenerator: (input) => {
          stateContexts.push(input.state_context);

          return "我正在去目标点";
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-composite-reply",
          content: "你在干嘛",
          intent_epoch: 8,
          snapshot_ts: 107,
        },
      }),
    });

    expect(stateContexts).toEqual([
      "当前状态：executing；ready：否；世界交互：已就绪；正在执行技能：goTo（消息 msg-goto）",
    ]);
  });

  it("应在 planner（规划器） 失败时回模板失败回执且不入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_invalid_plan",
          }),
        planner: async () => {
          throw new Error("planner returned invalid goTo payload");
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-failed",
          content: "帮我走到矿洞门口",
          intent_epoch: 5,
          snapshot_ts: 104,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-plan-failed",
        content: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      },
    ]);
    expect(enqueuedTasks).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-plan-failed",
      status: "discarded",
      reason: "planner_failed",
    });
  });

  it("应拒绝 planner（规划器） 产出的未启用 mine（挖掘） 技能且不入执行队列", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_mine",
          }),
        planner: async () => ({
          type: "skill_call",
          reply: "收到，我去挖石头",
          skill: "mine",
          params: { blockName: "stone", count: 2 },
        }),
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-mine",
          content: "去挖两块石头",
          intent_epoch: 6,
          snapshot_ts: 105,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-mine",
        content: "这个技能还没有通过单技能验收，当前只允许执行 goTo 前往坐标和 collect 捡拾喵~",
      },
    ]);
    expect(enqueuedTasks).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-mine",
      status: "discarded",
      reason: "skill_not_enabled",
    });
  });

  it("应把 planner（规划器） 抛出的未启用技能错误记录为 skill_not_enabled（技能未启用）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replies: Array<{ message_id: string; content: string }> = [];
    const enqueuedTasks: unknown[] = [];
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "llm_task_disabled_skill",
          }),
        planner: async () => {
          throw new ConversationLlmSkillNotEnabledError(
            "skill has not passed independent validation",
            { skill: "mine" },
          );
        },
        broadcastReplySink: async (reply) => {
          replies.push(reply);
        },
        enqueueExecTaskSink: async ({ task, priority }) => {
          enqueuedTasks.push({ task, priority });
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-disabled-skill-error",
          content: "去挖两块石头",
          intent_epoch: 7,
          snapshot_ts: 106,
        },
      }),
    });

    expect(replies).toEqual([
      {
        message_id: "msg-disabled-skill-error",
        content: "这个技能还没有通过单技能验收，当前只允许执行 goTo 前往坐标和 collect 捡拾喵~",
      },
    ]);
    expect(enqueuedTasks).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-disabled-skill-error",
      status: "discarded",
      reason: "skill_not_enabled",
    });
  });

  it("应把 planner（规划器） 失败时的完整 LLM diagnostics（大语言模型诊断） 写入本地对话日志", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const replyLogs: unknown[] = [];
    const diagnostics = Object.freeze({
      stage: "plan" as const,
      model: "bl-auto",
      message_id: "msg-plan-failed",
      log_ref: "llm/2026-05-03/plan-msg-plan-failed.jsonl",
      created_at: "2026-05-03T02:44:15.000Z",
      ok: false,
      error_summary: "planner cannot determine a valid executable skill",
      lines: Object.freeze([
        Object.freeze({
          t: 1_777_776_255,
          role: "user" as const,
          content: "环境快照：[附近掉落物] Item(item,1格)\n主人的指令：把这个东西捡起来",
        }),
      ]),
    });
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () =>
          createCompositeTaskTriage({
            priority: ConversationPriority.Normal,
            reason: "unit_plan_error_log",
          }),
        planner: async () => {
          throw new ConversationLlmPlanError("planner cannot determine", { diagnostics });
        },
        conversationReplyLogSink: async (record) => {
          replyLogs.push(record);
        },
        broadcastReplySink: async () => undefined,
        enqueueExecTaskSink: async () => undefined,
      },
    });

    await runtime.start();
    await processor?.({
      data: createConversationWorkerTask({
        bot_id: "bot-cw",
        message: {
          bot_id: "bot-cw",
          message_id: "msg-plan-failed",
          content: "把这个东西捡起来",
          intent_epoch: 8,
          snapshot_ts: 107,
        },
      }),
    });

    expect(replyLogs).toHaveLength(1);
    expect(replyLogs[0]).toMatchObject({
      message_id: "msg-plan-failed",
      reply_mode: "template",
      reply: "抱歉，这次我还没能规划出可执行的技能任务喵~",
      llm_diagnostics: diagnostics,
    });
  });

  it("应在闲聊 LLM（大语言模型） 失败时记录诊断后继续抛错", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const runtime = createConversationWorkerRuntime({
      queue: {
        name: "msg:bot-cw",
        connection: {},
      },
      dependencies: {
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
        triage: () => createCompositeChatTriage(),
        replyGenerator: () => {
          throw new ConversationLlmChatError(
            "upstream overload",
            Object.freeze({
              stage: "chat",
              model: "bl-auto",
              message_id: "msg-chat-failed",
              log_ref: "llm/2026-04-24/chat-msg-chat-failed.jsonl",
              created_at: "2026-04-24T10:00:00.000Z",
              ok: false,
              error_summary: "upstream overload",
              lines: Object.freeze([]),
            }),
          );
        },
        broadcastReplySink: async () => undefined,
      },
    });

    await runtime.start();

    await expect(
      processor?.({
        data: createConversationWorkerTask({
          bot_id: "bot-cw",
          message: {
            bot_id: "bot-cw",
            message_id: "msg-chat-failed",
            content: "你好",
            intent_epoch: 5,
            snapshot_ts: 104,
          },
        }),
      }),
    ).rejects.toThrow("upstream overload");

    expect(runtime.getEvents()).toContainEqual({
      type: "llm.chat.diagnostic",
      bot_id: "bot-cw",
      stage: "chat",
      message_id: "msg-chat-failed",
      model: "bl-auto",
      log_ref: "llm/2026-04-24/chat-msg-chat-failed.jsonl",
      created_at: "2026-04-24T10:00:00.000Z",
      ok: false,
      error_summary: "upstream overload",
    });
  });
});

function createEnvironmentSnapshotFixture(
  inventoryItems: readonly (readonly [string, number])[],
  ownerPosition: EnvironmentSnapshot["owner"]["position"] = { x: 1, y: 64, z: 1 },
): EnvironmentSnapshot {
  return Object.freeze({
    timestamp: 1,
    snapshot_version: "inventory-diff-test",
    bot: {
      position: { x: 0, y: 64, z: 0 },
      world_key: "overworld",
      health: 20,
      food: 20,
      experience: 0,
      is_on_fire: false,
      is_in_water: false,
      y_velocity: 0,
    },
    inventory: createInventorySummaryFixture(inventoryItems),
    equipment: {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      main_hand: null,
      off_hand: null,
      has_weapon_equipped: false,
    },
    nearby_entities: [],
    nearby_blocks: [],
    owner: {
      position: ownerPosition,
      name: "owner",
      online: true,
    },
    time: {
      phase: "day",
      time_of_day: 1000,
    },
    server_extended: {
      global_entity_count: 0,
      chunk_loaded_count: 0,
      tps: 20,
    },
  });
}

function createInventorySummaryFixture(
  items: readonly (readonly [string, number])[],
): InventorySummary {
  const entries = items.map(([itemName, count], index) =>
    Object.freeze({
      slot: index,
      item_name: itemName,
      count,
    }),
  );

  return Object.freeze({
    items: entries,
    total_items: entries.reduce((sum, item) => sum + item.count, 0),
    occupied_slots: entries.length,
    free_slots: 36 - entries.length,
  });
}
