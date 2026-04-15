import { describe, expect, it } from "vitest";

import { createInterfaceServerRuntime } from "../interfaces/index.js";

describe("interfaces Fastify（接口网关） 服务器骨架", () => {
  it("应注册最小四条路由并返回对齐契约的占位响应", async () => {
    const runtime = createInterfaceServerRuntime({
      bot_id: "bot-http",
      health: {
        service: "ts-core",
        status: "ok",
        timestamp: "2026-04-15T00:00:00.000Z",
      },
      default_status: {
        bot_id: "bot-http",
        status: "initializing",
        intent_epoch: 0,
        last_event_seq: 0,
        updated_at: "2026-04-15T00:00:00.000Z",
      },
      listen: {
        host: "127.0.0.1",
        port: 3100,
      },
    });

    const healthResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/health",
    });
    const statusResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-http",
    });
    const messageResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-http",
        message_id: "msg-http-1",
        content: "hello",
      },
    });
    const replayResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-http&after_seq=0&limit=3",
    });

    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({
      service: "ts-core",
      status: "ok",
      timestamp: "2026-04-15T00:00:00.000Z",
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toEqual({
      bot: {
        bot_id: "bot-http",
        status: "initializing",
        intent_epoch: 0,
        last_event_seq: 0,
        updated_at: "2026-04-15T00:00:00.000Z",
      },
    });

    expect(messageResponse.statusCode).toBe(202);
    expect(messageResponse.json()).toEqual({
      accepted: true,
      bot_id: "bot-http",
      job_id: "msg-http-1",
      message_id: "msg-http-1",
      queued_at: "2026-04-15T00:00:00.000Z",
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toEqual({
      bot_id: "bot-http",
      after_seq: 0,
      limit: 3,
      state: {
        bot_id: "bot-http",
        status: "initializing",
        intent_epoch: 0,
        last_event_seq: 0,
        updated_at: "2026-04-15T00:00:00.000Z",
      },
      events: [],
    });

    await runtime.close();
  });

  it("应拒绝 bot_id（机器人标识） 不匹配的 status、message、replay 请求", async () => {
    const runtime = createInterfaceServerRuntime({
      bot_id: "bot-http",
      health: {
        service: "ts-core",
        status: "ok",
        timestamp: "2026-04-15T00:00:00.000Z",
      },
      default_status: {
        bot_id: "bot-http",
        status: "initializing",
        intent_epoch: 0,
        last_event_seq: 0,
        updated_at: "2026-04-15T00:00:00.000Z",
      },
      listen: {
        host: "127.0.0.1",
        port: 3100,
      },
    });

    const statusResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/status?bot_id=bot-other",
    });
    const messageResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-other",
        message_id: "msg-http-1",
        content: "hello",
      },
    });
    const replayResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/replay?bot_id=bot-other&after_seq=0&limit=3",
    });

    expect(statusResponse.statusCode).toBe(400);
    expect(statusResponse.json()).toMatchObject({
      statusCode: 400,
      message: "bot_id does not match current runtime bot",
    });

    expect(messageResponse.statusCode).toBe(400);
    expect(messageResponse.json()).toMatchObject({
      statusCode: 400,
      message: "bot_id does not match current runtime bot",
    });

    expect(replayResponse.statusCode).toBe(400);
    expect(replayResponse.json()).toMatchObject({
      statusCode: 400,
      message: "bot_id does not match current runtime bot",
    });

    await runtime.close();
  });

  it("应把空字符串输入稳定收口为 400（请求错误）", async () => {
    const runtime = createInterfaceServerRuntime({
      bot_id: "bot-http",
      health: {
        service: "ts-core",
        status: "ok",
        timestamp: "2026-04-15T00:00:00.000Z",
      },
      default_status: {
        bot_id: "bot-http",
        status: "initializing",
        intent_epoch: 0,
        last_event_seq: 0,
        updated_at: "2026-04-15T00:00:00.000Z",
      },
      listen: {
        host: "127.0.0.1",
        port: 3100,
      },
    });

    const statusResponse = await runtime.server.inject({
      method: "GET",
      url: "/api/status?bot_id=%20%20",
    });
    const messageResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-http",
        message_id: "   ",
        content: "   ",
      },
    });
    const contentResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/message",
      payload: {
        bot_id: "bot-http",
        message_id: "msg-http-2",
        content: "   ",
      },
    });

    expect(statusResponse.statusCode).toBe(400);
    expect(statusResponse.json()).toMatchObject({
      statusCode: 400,
      message: "bot_id must be a non-empty string",
    });

    expect(messageResponse.statusCode).toBe(400);
    expect(messageResponse.json()).toMatchObject({
      statusCode: 400,
      message: "message_id must be a non-empty string",
    });

    expect(contentResponse.statusCode).toBe(400);
    expect(contentResponse.json()).toMatchObject({
      statusCode: 400,
      message: "content must be a non-empty string",
    });

    await runtime.close();
  });
});
