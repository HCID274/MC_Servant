import { describe, expect, it } from "vitest";

import {
  TaskHistoryStatus,
  createBrainWorkerRuntime,
  createBrainWorkerTask,
  createDeterministicBrainTaskSummary,
  createTaskSummarySource,
} from "../index.js";

describe("BrainWorker（摘要工作线程） 真实运行时", () => {
  it("应消费 brain（摘要队列）任务并依序读取 source（来源）、生成摘要、生成 embedding（向量嵌入）和持久化", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const calls: string[] = [];
    const persistedDrafts: unknown[] = [];
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-04-26T01:00:00.000Z"),
        async loadTaskSummarySource(task) {
          calls.push(`source:${task.payload.message_id}`);

          return createTaskSummarySource({
            bot_id: task.payload.bot_id,
            task_id: task.payload.message_id,
            message_id: task.payload.message_id,
            intent_epoch: task.payload.intent_epoch,
            status: task.payload.status,
            intent: "前往坐标",
            log_ref: "tasks/2026-04-26/msg-brain-ok.jsonl",
            created_at: "2026-04-26T00:59:00.000Z",
            terminal_detail: "completed in 1 step",
            jsonl_excerpt: ["task.completed"],
          });
        },
        async generateTaskSummary(source) {
          calls.push(`summary:${source.task_id}`);

          return {
            intent: source.intent,
            summary: "Bot 完成了前往坐标任务，并记录了终态日志。",
          };
        },
        async generateEmbedding(draft) {
          calls.push(`embedding:${draft.id}`);

          return [0.1, 0.2, 0.3];
        },
        async persistTaskSummary(draft) {
          calls.push(`persist:${draft.id}`);
          persistedDrafts.push(draft);
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });
    const task = createBrainWorkerTask({
      bot_id: "bot-brain",
      message_id: "msg-brain-ok",
      intent_epoch: 7,
      status: TaskHistoryStatus.Completed,
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(calls).toEqual([
      "source:msg-brain-ok",
      "summary:msg-brain-ok",
      "embedding:task-summary:bot-brain:msg-brain-ok",
      "persist:task-summary:bot-brain:msg-brain-ok",
    ]);
    expect(persistedDrafts).toEqual([
      {
        id: "task-summary:bot-brain:msg-brain-ok",
        task_id: "msg-brain-ok",
        bot_id: "bot-brain",
        intent: "前往坐标",
        status: TaskHistoryStatus.Completed,
        summary: "Bot 完成了前往坐标任务，并记录了终态日志。",
        log_ref: "tasks/2026-04-26/msg-brain-ok.jsonl",
        embedding: [0.1, 0.2, 0.3],
        created_at: "2026-04-26T01:00:00.000Z",
      },
    ]);
    expect(runtime.getEvents()).toEqual([
      {
        type: "brain.summary.persisted",
        bot_id: "bot-brain",
        message_id: "msg-brain-ok",
        task_id: "msg-brain-ok",
        summary_id: "task-summary:bot-brain:msg-brain-ok",
        status: TaskHistoryStatus.Completed,
      },
    ]);
  });

  it("应在未提供 embedding（向量嵌入）生成器时仍写入无 embedding（向量嵌入）的摘要", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const persistedDrafts: unknown[] = [];
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-04-26T01:10:00.000Z"),
        async loadTaskSummarySource(task) {
          return createTaskSummarySource({
            bot_id: task.payload.bot_id,
            task_id: task.payload.message_id,
            message_id: task.payload.message_id,
            intent_epoch: task.payload.intent_epoch,
            status: task.payload.status,
            intent: "取消任务",
            created_at: "2026-04-26T01:09:00.000Z",
            terminal_detail: "owner cancel",
          });
        },
        generateTaskSummary: createDeterministicBrainTaskSummary,
        async persistTaskSummary(draft) {
          persistedDrafts.push(draft);
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });

    await runtime.start();
    await processor?.({
      data: createBrainWorkerTask({
        bot_id: "bot-brain",
        message_id: "msg-brain-no-embedding",
        intent_epoch: 8,
        status: TaskHistoryStatus.Interrupted,
      }),
    });

    expect(persistedDrafts).toEqual([
      {
        id: "task-summary:bot-brain:msg-brain-no-embedding",
        task_id: "msg-brain-no-embedding",
        bot_id: "bot-brain",
        intent: "取消任务",
        status: TaskHistoryStatus.Interrupted,
        summary: "任务 msg-brain-no-embedding 以 interrupted 结束；意图：取消任务；owner cancel",
        created_at: "2026-04-26T01:10:00.000Z",
      },
    ]);
  });

  it("应在 source（来源）读取失败时记录 brain.summary.failed（摘要失败） 且不调用 persist（持久化）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let persistCalls = 0;
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        async loadTaskSummarySource() {
          throw new Error("source missing");
        },
        generateTaskSummary: createDeterministicBrainTaskSummary,
        async persistTaskSummary() {
          persistCalls += 1;
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });

    await runtime.start();
    await expect(
      processor?.({
        data: createBrainWorkerTask({
          bot_id: "bot-brain",
          message_id: "msg-brain-failed",
          intent_epoch: 9,
          status: TaskHistoryStatus.Failed,
        }),
      }),
    ).rejects.toThrow("source missing");

    expect(persistCalls).toBe(0);
    expect(runtime.getEvents()).toEqual([
      {
        type: "brain.summary.failed",
        bot_id: "bot-brain",
        message_id: "msg-brain-failed",
        error: {
          name: "Error",
          message: "source missing",
        },
      },
    ]);
  });

  it("应拒绝 discarded（已丢弃） 伪装进入 BrainWorker（摘要工作线程）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        async loadTaskSummarySource() {
          throw new Error("source should not load");
        },
        generateTaskSummary: createDeterministicBrainTaskSummary,
        async persistTaskSummary() {
          throw new Error("persist should not run");
        },
        createWorker: ({ processor: capturedProcessor }) => {
          processor = capturedProcessor;

          return {
            close: async () => undefined,
          };
        },
      },
    });

    await runtime.start();
    await expect(
      processor?.({
        data: {
          worker: "brain",
          queue: "brain",
          payload: {
            bot_id: "bot-brain",
            message_id: "msg-brain-discarded",
            intent_epoch: 10,
            status: TaskHistoryStatus.Discarded,
          },
        },
      }),
    ).rejects.toThrow(/completed, failed, or interrupted/);
    expect(runtime.getEvents()[0]?.type).toBe("brain.summary.failed");
  });
});
