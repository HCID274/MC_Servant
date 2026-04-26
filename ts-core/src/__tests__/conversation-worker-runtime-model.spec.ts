import { describe, expect, it } from "vitest";

import { createMessageTriage } from "../conversation/index.js";
import { ConversationLlmChatError } from "../conversation/llm.js";
import { ConversationPriority } from "../domain/contracts.js";
import { createConversationWorkerTask } from "../workers/contracts.js";
import { createConversationWorkerRuntime } from "../workers/conversation-worker.js";

describe("ConversationWorker（对话工作线程） 真实运行时", () => {
  it("应消费 chat（闲聊） 消息并通过 BotActor（机器人执行代理） sink（汇点） 广播回复", async () => {
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
            intent: "chat",
            priority: "normal",
            reason: "unit_chat",
          }),
        replyGenerator: () => ({
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

  it("应通过 planner（规划器） 把自然语言采集任务转换为 mine（挖掘） 执行队列任务", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
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
        broadcastReplySink: async () => undefined,
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

    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 5,
      task: {
        exec_job: {
          message_id: "msg-mine",
          skill: "mine",
          params: { blockName: "stone", count: 2 },
        },
      },
    });
    expect(runtime.getEvents()).toContainEqual({
      type: "task.accepted",
      bot_id: "bot-cw",
      message_id: "msg-mine",
      skill: "mine",
      priority: "normal",
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
