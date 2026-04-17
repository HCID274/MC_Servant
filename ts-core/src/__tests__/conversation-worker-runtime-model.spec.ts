import { describe, expect, it } from "vitest";

import { createMessageTriage } from "../conversation/index.js";
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
        replyGenerator: () => "我听到啦",
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
      type: "chat.reply",
      bot_id: "bot-cw",
      message_id: "msg-chat",
      content: "我听到啦喵~",
    });
  });

  it("应只记录 cancel（取消） 路径，不写入 Mineflayer（Minecraft 协议客户端） 聊天", async () => {
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
            intent: "cancel",
            priority: "interrupt",
            reason: "owner_cancel",
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
          message_id: "msg-cancel",
          content: "取消",
          intent_epoch: 2,
          snapshot_ts: 101,
        },
      }),
    });

    expect(replies).toEqual([]);
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

    expect(replies).toEqual([]);
    expect(runtime.getEvents()).toContainEqual({
      type: "task.discarded",
      bot_id: "bot-cw",
      message_id: "msg-task",
      status: "discarded",
      reason: "planner_unavailable",
    });
  });

  it("应把窄格式 goTo（前往坐标） 命令解析为执行队列任务", async () => {
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
          message_id: "msg-goto",
          content: "去 (10,64,-5)",
          intent_epoch: 4,
          snapshot_ts: 103,
        },
      }),
    });

    expect(enqueuedTasks).toHaveLength(1);
    expect(enqueuedTasks[0]).toMatchObject({
      priority: 5,
      task: {
        worker: "bot",
        bot_id: "bot-cw",
        queue: "bot:bot-cw:exec",
        exec_job: {
          message_id: "msg-goto",
          intent_epoch: 4,
          snapshot_ts: 103,
          priority: "normal",
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
      priority: "normal",
    });
  });
});
