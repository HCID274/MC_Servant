import { describe, expect, it } from "vitest";

import { createWorkerBullmqRuntime } from "../workers/index.js";

describe("workers BullMQ（任务队列） 运行时", () => {
  it("应基于共享 Redis（缓存） 连接创建三组真实队列并按约定顺序关闭", async () => {
    const createdQueueNames: string[] = [];
    const closedQueueNames: string[] = [];
    const redisClient = {};
    const runtime = createWorkerBullmqRuntime(
      {
        botId: "bot-bullmq",
        redis: {
          client: redisClient,
        },
      },
      {
        createQueue: ({ name, connection }) => {
          createdQueueNames.push(name);
          expect(connection).toBe(redisClient);

          return {
            name,
            close: async () => {
              closedQueueNames.push(name);
            },
          };
        },
      },
    );

    expect(runtime.catalog.conversation.queue).toBe("msg:bot-bullmq");
    expect(runtime.catalog.bot.queue).toBe("bot:bot-bullmq:exec");
    expect(runtime.catalog.brain.queue).toBe("brain");
    expect(createdQueueNames).toEqual(["msg:bot-bullmq", "bot:bot-bullmq:exec", "brain"]);

    await runtime.close();

    expect(closedQueueNames).toEqual(["brain", "bot:bot-bullmq:exec", "msg:bot-bullmq"]);
  });

  it("应在某条队列关闭失败时继续清理剩余队列，并抛出首个错误", async () => {
    const closedQueueNames: string[] = [];
    const runtime = createWorkerBullmqRuntime(
      {
        botId: "bot-bullmq-error",
        redis: {
          client: {},
        },
      },
      {
        createQueue: ({ name }) => ({
          name,
          close: async () => {
            closedQueueNames.push(name);

            if (name === "brain") {
              throw new Error("brain close failed");
            }
          },
        }),
      },
    );

    await expect(runtime.close()).rejects.toThrow("brain close failed");
    expect(closedQueueNames).toEqual([
      "brain",
      "bot:bot-bullmq-error:exec",
      "msg:bot-bullmq-error",
    ]);
  });
});
