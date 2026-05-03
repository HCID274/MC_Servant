import { describe, expect, it } from "vitest";

import {
  type AppRuntimeResources,
  createAppBootstrapContract,
  createAppRuntimeServices,
} from "../app/index.js";

describe("interfaces（接口边界） 消息入队链路", () => {
  it("应让 POST /api/message（消息提交接口） 默认写入 BullMQ（任务队列） 消息队列并返回真实 job.id", async () => {
    const addedJobs: Array<{
      queue: string;
      name: string;
      data: unknown;
      jobId?: string;
    }> = [];
    const messageTimes = ["2026-04-15T00:00:05.000Z", "2026-04-15T00:00:06.000Z"];
    const bootstrap = createAppBootstrapContract({
      botId: "bot-msg",
      now: "2026-04-15T00:00:00.000Z",
    });
    const infrastructure = {
      bot_id: "bot-msg",
      redis: {
        client: {},
      },
    } as unknown as AppRuntimeResources<"bot-msg">;
    const services = await createAppRuntimeServices(bootstrap, infrastructure, {
      workers: {
        createQueue: ({ name }) => ({
          name,
          add: async (jobName, data, options) => {
            addedJobs.push({
              queue: name,
              name: jobName,
              data,
              jobId: options?.jobId,
            });

            return { id: `bull-${options?.jobId ?? "unknown"}` };
          },
          close: async () => undefined,
        }),
      },
      now: () => messageTimes.shift() ?? "2026-04-15T00:00:07.000Z",
      intentEpochStore: createMemoryIntentEpochStore(),
    });

    const firstResponse = await services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-msg",
        message_id: "msg-http-queue",
        content: "你好",
      },
    });
    const secondResponse = await services.http.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-msg",
        message_id: "msg-http-queue-2",
        content: "第二条",
      },
    });

    expect(firstResponse.statusCode).toBe(202);
    expect(firstResponse.json()).toEqual({
      accepted: true,
      bot_id: "bot-msg",
      job_id: "bull-msg-http-queue",
      message_id: "msg-http-queue",
      queued_at: "2026-04-15T00:00:05.000Z",
    });
    expect(secondResponse.statusCode).toBe(202);
    expect(secondResponse.json()).toEqual({
      accepted: true,
      bot_id: "bot-msg",
      job_id: "bull-msg-http-queue-2",
      message_id: "msg-http-queue-2",
      queued_at: "2026-04-15T00:00:06.000Z",
    });
    expect(addedJobs).toHaveLength(2);
    expect(addedJobs[0]?.queue).toBe("msg:bot-msg");
    expect(addedJobs[0]?.name).toBe("conversation");
    expect(addedJobs[0]?.jobId).toBe("msg-http-queue");
    expect(addedJobs[0]?.data).toMatchObject({
      worker: "conversation",
      bot_id: "bot-msg",
      queue: "msg:bot-msg",
      message: {
        bot_id: "bot-msg",
        message_id: "msg-http-queue",
        content: "你好",
        intent_epoch: 1,
      },
    });
    expect(addedJobs[0]?.data).toMatchObject({
      message: {
        snapshot_ts: Date.parse("2026-04-15T00:00:05.000Z"),
      },
    });
    expect(addedJobs[1]?.jobId).toBe("msg-http-queue-2");
    expect(addedJobs[1]?.data).toMatchObject({
      message: {
        message_id: "msg-http-queue-2",
        intent_epoch: 2,
        snapshot_ts: Date.parse("2026-04-15T00:00:06.000Z"),
      },
    });

    await services.close();
  });
});

function createMemoryIntentEpochStore(): {
  readonly next: () => Promise<number>;
  readonly read: () => Promise<number>;
} {
  let epoch = 0;

  return {
    async next() {
      epoch += 1;

      return epoch;
    },
    async read() {
      return epoch;
    },
  };
}
