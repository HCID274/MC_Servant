import { describe, expect, it } from "vitest";

import {
  API_ROUTE_DEFINITIONS,
  BotStatus,
  CORE_MODULE_NAMES,
  MessageSource,
  type MessageSubmissionRequest,
  RUNTIME_EVENT_TYPES,
  createHealthResponse,
  createMessageAcceptedResponse,
  createRealtimeEventEnvelope,
  createReplayRequest,
  createReplayResponse,
  createSessionAuthorization,
  createSessionLoginResponse,
  createSessionRecord,
  createStatusQuery,
  createStatusResponse,
  createWebMessageEnvelope,
  extractBearerToken,
  normalizeReplayLimit,
  selectReplayEvents,
  validateSessionAuthorization,
} from "../index.js";

createRealtimeEventEnvelope({
  seq: 1,
  botId: "bot-1",
  // @ts-expect-error interfaces（接口层） 事件类型必须复用 runtime（运行时） 事件命名。
  type: "web.message",
  createdAt: "2026-04-13T00:00:00.000Z",
});

const invalidMessageRequest: MessageSubmissionRequest = {
  bot_id: "bot-1",
  message_id: "msg-1",
  content: "你好",
  // @ts-expect-error 消息提交请求不允许旁路控制字段。
  control: "interrupt",
};
void invalidMessageRequest;

const invalidReplayRequestInput: Parameters<typeof createReplayRequest>[0] = {
  botId: "bot-1",
  // @ts-expect-error replay（补拉） 请求的 afterSeq 必须是数字。
  afterSeq: "1",
  limit: 10,
};
void invalidReplayRequestInput;

describe("interfaces 模块契约", () => {
  it("应导出 interfaces（接口层） 模块与最小路由集合", () => {
    expect(CORE_MODULE_NAMES).toContain("interfaces");
    expect(API_ROUTE_DEFINITIONS.map((route) => route.path)).toEqual([
      "/api/health",
      "/api/status",
      "/api/message",
      "/api/replay",
    ]);
  });

  it("应支持会话登录、token（令牌） 鉴权与消息标准化", () => {
    const session = createSessionRecord({
      id: "session-1",
      owner_id: "owner-1",
      bot_id: "bot-1",
      token: "token-1",
      expires_at: "2026-04-20T00:00:00.000Z",
      created_at: "2026-04-13T00:00:00.000Z",
    });
    const login = createSessionLoginResponse(session);
    const authorization = createSessionAuthorization("token-1");
    const validation = validateSessionAuthorization({
      authorization,
      session,
      botId: "bot-1",
      now: "2026-04-13T12:00:00.000Z",
    });
    const message = createWebMessageEnvelope({
      request: {
        bot_id: "bot-1",
        message_id: "msg-1",
        content: "帮我去挖矿",
      },
      session,
      createdAt: "2026-04-13T12:00:01.000Z",
    });
    const accepted = createMessageAcceptedResponse({
      botId: "bot-1",
      jobId: "job-1",
      messageId: "msg-1",
      queuedAt: "2026-04-13T12:00:02.000Z",
    });

    expect(login.session_id).toBe("session-1");
    expect(validation.status).toBe("valid");
    expect(message.source).toBe(MessageSource.Web);
    expect(message.channel).toBe("web");
    expect(accepted.accepted).toBe(true);
    expect(extractBearerToken("Bearer token-1")).toBe("token-1");
    expect(Object.isFrozen(message)).toBe(true);
  });

  it("应拒绝会话与消息请求的 bot_id（机器人标识） 不一致输入", () => {
    const session = createSessionRecord({
      id: "session-mismatch",
      owner_id: "owner-1",
      bot_id: "bot-a",
      token: "token-a",
      expires_at: "2026-04-20T00:00:00.000Z",
      created_at: "2026-04-13T00:00:00.000Z",
    });

    expect(() =>
      createWebMessageEnvelope({
        request: {
          bot_id: "bot-b",
          message_id: "msg-mismatch",
          content: "这条消息不该通过",
        },
        session,
        createdAt: "2026-04-13T12:00:01.000Z",
      }),
    ).toThrow(/bot_id mismatch/i);
  });

  it("应复用 runtime（运行时） 事件命名构造状态查询、健康检查与 replay（补拉） 输出", () => {
    const sourceEvent = {
      seq: 10,
      bot_id: "bot-1",
      type: "task.started" as "task.started" | "task.completed",
      created_at: "2026-04-13T12:00:03.000Z",
      payload: { job_id: "job-1", nested: { step: 1 } },
    };
    const event = createRealtimeEventEnvelope({
      seq: sourceEvent.seq,
      botId: sourceEvent.bot_id,
      type: sourceEvent.type,
      createdAt: sourceEvent.created_at,
      payload: sourceEvent.payload,
    });
    const statusResponse = createStatusResponse({
      bot: {
        bot_id: "bot-1",
        status: BotStatus.EXECUTING,
        intent_epoch: 8,
        last_event_seq: 10,
        updated_at: "2026-04-13T12:00:03.000Z",
        active_task_id: "job-1",
      },
    });
    const replayRequest = createReplayRequest({
      botId: "bot-1",
      afterSeq: 4,
      limit: 999,
    });
    const replayResponse = createReplayResponse({
      request: replayRequest,
      state: statusResponse.bot,
      events: [sourceEvent],
    });
    const health = createHealthResponse("2026-04-13T12:00:04.000Z");
    const statusQuery = createStatusQuery("bot-1");

    sourceEvent.type = "task.completed";
    sourceEvent.payload.job_id = "job-2";
    sourceEvent.payload.nested.step = 2;

    expect(RUNTIME_EVENT_TYPES).toContain(event.type);
    expect(replayResponse.events[0]?.type).toBe("task.started");
    expect(replayResponse.events[0]?.payload).toEqual({ job_id: "job-1", nested: { step: 1 } });
    expect(replayResponse.limit).toBe(50);
    expect(normalizeReplayLimit(undefined)).toBe(50);
    expect(statusQuery.bot_id).toBe("bot-1");
    expect(statusResponse.bot.status).toBe(BotStatus.EXECUTING);
    expect(health.service).toBe("ts-core");
    expect(Object.isFrozen(replayResponse.events)).toBe(true);
    expect(Object.isFrozen(replayResponse.events[0])).toBe(true);
    expect(Object.isFrozen(replayResponse.events[0]?.payload ?? {})).toBe(true);
    expect(
      Object.isFrozen(
        (replayResponse.events[0]?.payload as { nested?: object } | undefined)?.nested,
      ),
    ).toBe(true);
  });

  it("应按 bot_id + after_seq + limit 语义筛选并排序 replay（补拉） 事件", () => {
    const request = createReplayRequest({
      botId: "bot-1",
      afterSeq: 8,
      limit: 2,
    });

    const selected = selectReplayEvents({
      request,
      events: [
        createRealtimeEventEnvelope({
          seq: 12,
          botId: "bot-1",
          type: "task.completed",
          createdAt: "2026-04-13T12:00:12.000Z",
          payload: { job_id: "job-3" },
        }),
        createRealtimeEventEnvelope({
          seq: 7,
          botId: "bot-1",
          type: "task.started",
          createdAt: "2026-04-13T12:00:07.000Z",
          payload: { job_id: "job-old" },
        }),
        createRealtimeEventEnvelope({
          seq: 9,
          botId: "bot-2",
          type: "task.started",
          createdAt: "2026-04-13T12:00:09.000Z",
          payload: { job_id: "job-other" },
        }),
        createRealtimeEventEnvelope({
          seq: 11,
          botId: "bot-1",
          type: "task.failed",
          createdAt: "2026-04-13T12:00:11.000Z",
          payload: { job_id: "job-2", error: { message: "boom" } },
        }),
        createRealtimeEventEnvelope({
          seq: 10,
          botId: "bot-1",
          type: "step.progress",
          createdAt: "2026-04-13T12:00:10.000Z",
          payload: { job_id: "job-2", step_index: 0 },
        }),
      ],
    });

    expect(selected.map((event) => event.seq)).toEqual([10, 11]);
    expect(selected.every((event) => event.bot_id === "bot-1")).toBe(true);
  });

  it("应拒绝非法 replay（补拉） 边界输入", () => {
    expect(() =>
      createReplayRequest({
        botId: "bot-1",
        afterSeq: -1,
      }),
    ).toThrow(/afterSeq/);

    expect(() => normalizeReplayLimit(0)).toThrow(/positive integer/);

    expect(() =>
      createReplayResponse({
        request: createReplayRequest({
          botId: "bot-1",
          afterSeq: 0,
        }),
        state: {
          bot_id: "bot-2",
          status: BotStatus.IDLE,
          intent_epoch: 1,
          last_event_seq: 0,
          updated_at: "2026-04-13T12:00:00.000Z",
        },
        events: [],
      }),
    ).toThrow(/state bot_id/);
  });
});
