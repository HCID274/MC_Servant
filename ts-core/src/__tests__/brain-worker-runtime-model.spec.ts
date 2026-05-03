import { describe, expect, it } from "vitest";

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
