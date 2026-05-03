import { describe, expect, it, vi } from "vitest";

import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createBrainTaskCard,
  createBrainWorkerRuntime,
  createBrainWorkerTask,
  createOpenAiCompatibleEmbeddingGenerator,
} from "../index.js";

describe("BrainWorker（大脑工作线程） 真实运行时", () => {
  it("应消费 brain（大脑队列）任务卡，调用 embedding API（向量接口） 后一次写入 task_events（任务事件）", async () => {
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
        async generateEmbedding(text) {
          calls.push(`embedding:${text}`);

          return [0.1, 0.2, 0.3];
        },
        async persistTaskEvent(draft) {
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
      owner_text: "去捡盾牌",
      task_card: createTaskCard({
        status: TaskHistoryStatus.Completed,
      }),
      log_ref: "tasks/2026-04-26/msg-brain-ok.jsonl",
    });

    await runtime.start();
    await processor?.({ data: task });

    expect(calls).toEqual(["embedding:去捡盾牌", "persist:task-event:bot-brain:msg-brain-ok"]);
    expect(persistedDrafts).toEqual([
      {
        id: "task-event:bot-brain:msg-brain-ok",
        task_id: "msg-brain-ok",
        bot_id: "bot-brain",
        message_id: "msg-brain-ok",
        owner_text: "去捡盾牌",
        task_card: createTaskCard({
          status: TaskHistoryStatus.Completed,
        }),
        embedding: [0.1, 0.2, 0.3],
        log_ref: "tasks/2026-04-26/msg-brain-ok.jsonl",
        created_at: "2026-04-26T01:00:00.000Z",
      },
    ]);
    expect(runtime.getEvents()).toEqual([
      {
        type: "brain.task_event.persisted",
        bot_id: "bot-brain",
        message_id: "msg-brain-ok",
        task_id: "msg-brain-ok",
        event_id: "task-event:bot-brain:msg-brain-ok",
        status: TaskHistoryStatus.Completed,
      },
    ]);
  });

  it("应在 embedding API（向量接口） 失败时记录 brain.task_event.failed（任务事件失败） 且不调用 persist（持久化）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    let persistCalls = 0;
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        async generateEmbedding() {
          throw new Error("embedding unavailable");
        },
        async persistTaskEvent() {
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
          owner_text: "去危险区域",
          task_card: createTaskCard({
            message_id: "msg-brain-failed",
            intent_epoch: 9,
            owner_text: "去危险区域",
            status: TaskHistoryStatus.Failed,
          }),
        }),
      }),
    ).rejects.toThrow("embedding unavailable");

    expect(persistCalls).toBe(0);
    expect(runtime.getEvents()).toEqual([
      {
        type: "brain.task_event.failed",
        bot_id: "bot-brain",
        message_id: "msg-brain-failed",
        error: {
          name: "Error",
          message: "embedding unavailable",
        },
      },
    ]);
  });

  it("应拒绝 discarded（已丢弃） 伪装进入 BrainWorker（大脑工作线程）", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        async generateEmbedding() {
          throw new Error("embedding should not run");
        },
        async persistTaskEvent() {
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
            owner_text: "过期任务",
            task_card: createTaskCard({
              status: TaskHistoryStatus.Interrupted,
            }),
          },
        },
      }),
    ).rejects.toThrow(/completed, failed, or interrupted/);
    expect(runtime.getEvents()[0]?.type).toBe("brain.task_event.failed");
  });

  it("应在失败任务写入后触发根因 takeaway（要点）并追加滚动摘要", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const takeawayUpdates: unknown[] = [];
    const summaryWrites: unknown[] = [];
    const llmCalls: string[] = [];
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
        now: () => new Date("2026-04-26T01:00:00.000Z"),
        async generateEmbedding() {
          return [0.1, 0.2, 0.3];
        },
        async persistTaskEvent() {
          return undefined;
        },
        llm: {
          model: "bl-auto",
          async generateFailureTakeaway(input) {
            llmCalls.push(input.log_excerpt);

            return "下次先确认路径可达再执行 collect";
          },
          async generateSessionTakeaway() {
            throw new Error("session takeaway should not run");
          },
          async compressRollingSummary() {
            throw new Error("compression should not run");
          },
        },
        async readTaskLogExcerpt(logRef) {
          return `log:${logRef}`;
        },
        async updateTaskEventTakeaway(input) {
          takeawayUpdates.push(input);
        },
        async loadRollingSummary() {
          return undefined;
        },
        async writeRollingSummary(input) {
          summaryWrites.push(input);
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
        message_id: "msg-brain-failed",
        intent_epoch: 9,
        status: TaskHistoryStatus.Failed,
        owner_text: "去危险区域",
        task_card: createTaskCard({
          message_id: "msg-brain-failed",
          intent_epoch: 9,
          owner_text: "去危险区域",
          status: TaskHistoryStatus.Failed,
        }),
        log_ref: "tasks/2026-04-26/msg-brain-failed.jsonl",
      }),
    });

    expect(llmCalls).toEqual(["log:tasks/2026-04-26/msg-brain-failed.jsonl"]);
    expect(takeawayUpdates).toEqual([
      {
        event_id: "task-event:bot-brain:msg-brain-failed",
        takeaway: "下次先确认路径可达再执行 collect",
        updated_at: "2026-04-26T01:00:00.000Z",
      },
    ]);
    expect(summaryWrites).toEqual([
      {
        bot_id: "bot-brain",
        content:
          "主人要求“去危险区域”，Bot 执行技能 collect失败，原因 path not found。 后续应保留该结果供下轮对话引用。",
        updated_at: "2026-04-26T01:00:00.000Z",
      },
    ]);
    expect(runtime.getEvents().map((event) => event.type)).toEqual([
      "brain.task_event.persisted",
      "brain.takeaway.updated",
      "brain.rolling_summary.updated",
    ]);
  });

  it("应在滚动摘要超过 2000 字时调用 LLM（大语言模型）重压到 1000 字内", async () => {
    let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
    const summaryWrites: Array<{ readonly content: string; readonly llm_model?: string }> = [];
    const longContent = "旧摘要".repeat(700);
    const runtime = createBrainWorkerRuntime({
      queue: {
        name: "brain",
        connection: {},
      },
      dependencies: {
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
            expect(content).toContain(longContent);

            return "压缩后摘要".repeat(120);
          },
        },
        async loadRollingSummary() {
          return {
            bot_id: "bot-brain",
            content: longContent,
            char_count: Array.from(longContent).length,
            updated_at: "2026-04-26T00:00:00.000Z",
          };
        },
        async writeRollingSummary(input) {
          summaryWrites.push(input);
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
        message_id: "msg-brain-compress",
        intent_epoch: 7,
        status: TaskHistoryStatus.Completed,
        owner_text: "继续捡盾牌",
        task_card: createTaskCard({
          message_id: "msg-brain-compress",
          owner_text: "继续捡盾牌",
          status: TaskHistoryStatus.Completed,
        }),
      }),
    });

    expect(summaryWrites).toHaveLength(1);
    expect(Array.from(summaryWrites[0]?.content ?? "").length).toBeLessThanOrEqual(1000);
    expect(summaryWrites[0]?.llm_model).toBe("bl-auto");
    expect(runtime.getEvents().at(-1)).toMatchObject({
      type: "brain.rolling_summary.updated",
      compressed: true,
    });
  });

  it("应在会话静默后写入会话级 takeaway（要点），有新主人消息时跳过", async () => {
    vi.useFakeTimers();
    try {
      let processor: ((job: { readonly data: unknown }) => Promise<void>) | undefined;
      const takeawayUpdates: unknown[] = [];
      let lastOwnerMessageAt: Date | undefined;
      const runtime = createBrainWorkerRuntime({
        queue: {
          name: "brain",
          connection: {},
        },
        dependencies: {
          now: () => new Date("2026-04-26T01:00:00.000Z"),
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
              return "会话后续应继续确认盾牌收集结果";
            },
            async compressRollingSummary(content) {
              return content;
            },
          },
          async updateTaskEventTakeaway(input) {
            takeawayUpdates.push(input);
          },
          async loadRollingSummary() {
            return {
              bot_id: "bot-brain",
              content: "主人要求捡盾牌，Bot 已完成 collect。",
              char_count: 24,
              updated_at: "2026-04-26T01:00:00.000Z",
            };
          },
          async writeRollingSummary() {
            return undefined;
          },
          sessionSilence: {
            delay_ms: 20,
            isBrainQueueIdle: () => true,
            hasActiveTask: () => false,
            getLastOwnerMessageAt: () => lastOwnerMessageAt,
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
          message_id: "msg-session-skip",
          intent_epoch: 7,
          status: TaskHistoryStatus.Completed,
          owner_text: "去捡盾牌",
          task_card: createTaskCard({
            message_id: "msg-session-skip",
            status: TaskHistoryStatus.Completed,
          }),
        }),
      });
      lastOwnerMessageAt = new Date("2026-04-26T01:00:01.000Z");
      await vi.advanceTimersByTimeAsync(25);
      expect(takeawayUpdates).toEqual([]);

      await processor?.({
        data: createBrainWorkerTask({
          bot_id: "bot-brain",
          message_id: "msg-session-write",
          intent_epoch: 8,
          status: TaskHistoryStatus.Completed,
          owner_text: "再确认一下",
          task_card: createTaskCard({
            message_id: "msg-session-write",
            intent_epoch: 8,
            owner_text: "再确认一下",
            status: TaskHistoryStatus.Completed,
          }),
        }),
      });
      lastOwnerMessageAt = undefined;
      await vi.advanceTimersByTimeAsync(25);

      expect(takeawayUpdates).toContainEqual({
        event_id: "task-event:bot-brain:msg-session-write",
        takeaway: "会话后续应继续确认盾牌收集结果",
        updated_at: "2026-04-26T01:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("应按 OpenAI compatible（OpenAI 兼容） embeddings（向量嵌入） 协议请求并校验维度", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const generator = createOpenAiCompatibleEmbeddingGenerator(
      {
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "bl-auto",
        dimensions: 3,
        timeout_ms: 1000,
      },
      {
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
          });

          return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
            status: 200,
          });
        },
      },
    );

    await expect(generator("去捡盾牌")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8045/v1/embeddings",
        body: {
          model: "bl-auto",
          input: "去捡盾牌",
          dimensions: 3,
        },
      },
    ]);
  });

  it("应允许显式配置完整 embeddings endpoint（向量端点）", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const generator = createOpenAiCompatibleEmbeddingGenerator(
      {
        endpoint_url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
        api_key: "sk-local-dev",
        model: "text-embedding-v4",
        dimensions: 3,
        timeout_ms: 1000,
      },
      {
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
          });

          return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
            status: 200,
          });
        },
      },
    );

    await expect(generator("把这个东西捡起来")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(requests).toEqual([
      {
        url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
        body: {
          model: "text-embedding-v4",
          input: "把这个东西捡起来",
          dimensions: 3,
        },
      },
    ]);
  });
});

function createTaskCard(input: {
  readonly message_id?: string;
  readonly intent_epoch?: number;
  readonly owner_text?: string;
  readonly status:
    | TaskHistoryStatus.Completed
    | TaskHistoryStatus.Failed
    | TaskHistoryStatus.Interrupted;
}) {
  const messageId = input.message_id ?? "msg-brain-ok";
  const ownerText = input.owner_text ?? "去捡盾牌";

  return createBrainTaskCard({
    task_id: messageId,
    message_id: messageId,
    intent_epoch: input.intent_epoch ?? 7,
    snapshot_ts: 100,
    priority: ExecPriority.Normal,
    owner_text: ownerText,
    execution: {
      type: ExecutionTaskKind.SkillCall,
      skill: "collect",
      params: {
        itemName: "shield",
        radius: 32,
      },
    },
    result:
      input.status === TaskHistoryStatus.Completed
        ? {
            status: TaskHistoryStatus.Completed,
            total_steps: 1,
            duration_ms: 1200,
            log_ref: "tasks/2026-04-26/msg-brain-ok.jsonl",
          }
        : input.status === TaskHistoryStatus.Failed
          ? {
              status: TaskHistoryStatus.Failed,
              total_steps: 1,
              duration_ms: 1200,
              error: {
                name: "Error",
                message: "path not found",
              },
              last_step: "collect",
            }
          : {
              status: TaskHistoryStatus.Interrupted,
              total_steps: 1,
              duration_ms: 1200,
              reason: "owner_cancel",
              interrupt_source: {
                type: "control",
                command: "cancel",
              },
            },
  });
}
