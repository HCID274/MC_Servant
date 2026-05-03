import { describe, expect, it } from "vitest";

import {
  createConversationCompositeTriage,
  createConversationRecentContextStore,
  createMessageTriage,
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
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import { createTaskSummaryDraft } from "../data/index.js";
import { ConversationPriority } from "../domain/contracts.js";
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
        triage: () =>
          createMessageTriage({
            intent: "chat",
            priority: "normal",
            reason: "unit_chat",
          }),
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
        triage: () =>
          createMessageTriage({
            intent: "chat",
            priority: "normal",
            reason: "unit_chat",
          }),
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
        triage: () =>
          createMessageTriage({
            intent: "chat",
            priority: "normal",
            reason: "unit_chat_projection_failed",
          }),
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
        triage: () =>
          createMessageTriage({
            intent: "chat",
            priority: "normal",
            reason: "unit_chat_memory",
          }),
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
        query_reason: "unit_chat_memory",
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
        triage: () =>
          createMessageTriage({
            intent: "cancel",
            priority: "interrupt",
            reason: "owner_cancel",
          }),
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
          reason: "cancel",
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
          createMessageTriage({
            intent: "task",
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
          createMessageTriage({
            intent: "task",
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
          createMessageTriage({
            intent: "task",
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

  it("应按 cancel（取消）→reply（回复）→action（动作） 顺序派发 composite triage（复合分诊）", async () => {
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
            reply: {
              content: "知道了",
            },
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

  it("应让无显式文本的 composite reply（复合回复） 复用状态上下文闲聊路径", async () => {
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
            reply: {},
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
          createMessageTriage({
            intent: "task",
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
          createMessageTriage({
            intent: "task",
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
          createMessageTriage({
            intent: "task",
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
          createMessageTriage({
            intent: "task",
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
        triage: () =>
          createMessageTriage({
            intent: "chat",
            priority: "normal",
            reason: "unit_chat_error",
          }),
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
