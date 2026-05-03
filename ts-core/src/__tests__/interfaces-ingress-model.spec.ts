import { describe, expect, it } from "vitest";

import {
  GAME_CHAT_CHANNEL,
  GAME_CHAT_COMMAND_PREFIX,
  GAME_CHAT_SOURCE,
  SERVER_BRIDGE_CHANNEL,
  SERVER_BRIDGE_SOURCE,
  WEB_MESSAGE_CHANNEL,
  WEB_MESSAGE_SOURCE,
  createGameChatIngressDecision,
  createServerBridgeEventEnvelope,
  createSessionRecord,
  createWebMessageEnvelope,
  matchInterfaceControlFastPath,
} from "../index.js";
import {
  createGameChatIngressDecision as createGameChatIngressDecisionFromInterfaces,
  createServerBridgeEventEnvelope as createServerBridgeEventEnvelopeFromInterfaces,
} from "../interfaces/index.js";

describe("interfaces ingress（入口） 契约", () => {
  it("应从 interfaces（接口层） 根入口与 src（源码） 根入口同时导出游戏聊天与桥接构造器", () => {
    expect(createGameChatIngressDecisionFromInterfaces).toBe(createGameChatIngressDecision);
    expect(createServerBridgeEventEnvelopeFromInterfaces).toBe(createServerBridgeEventEnvelope);
  });

  it("应让网页 / 游戏聊天 / 服务端桥接在关键字段命名上保持统一", () => {
    const session = createSessionRecord({
      id: "session-ingress",
      owner_id: "owner-ingress",
      bot_id: "bot-ingress",
      token: "token-ingress",
      expires_at: "2026-04-21T00:00:00.000Z",
      created_at: "2026-04-14T00:00:00.000Z",
    });
    const web = createWebMessageEnvelope({
      request: {
        bot_id: "bot-ingress",
        message_id: "msg-web",
        content: "网页消息",
      },
      session,
      createdAt: "2026-04-14T00:01:00.000Z",
    });
    const gameDecision = createGameChatIngressDecision({
      bot_id: "bot-ingress",
      owner_id: "owner-ingress",
      sender_id: "mc-owner-alice",
      owner_resolution: "matched_owner",
      message_id: "msg-game",
      content: `${GAME_CHAT_COMMAND_PREFIX} 挖树`,
      timestamp: "2026-04-14T00:02:00.000Z",
    });

    if (gameDecision.status !== "accepted") {
      throw new Error("expected accepted game chat ingress decision");
    }

    const bridge = createServerBridgeEventEnvelope({
      bot_id: "bot-ingress",
      event_id: "evt-bridge",
      event_type: "player.joined",
      timestamp: "2026-04-14T00:03:00.000Z",
      payload: {
        player: "alice",
      },
    });

    expect(web).toMatchObject({
      bot_id: "bot-ingress",
      owner_id: "owner-ingress",
      source: WEB_MESSAGE_SOURCE,
      channel: WEB_MESSAGE_CHANNEL,
      timestamp: "2026-04-14T00:01:00.000Z",
    });
    expect(gameDecision.envelope).toMatchObject({
      bot_id: "bot-ingress",
      owner_id: "owner-ingress",
      session_id: null,
      source: GAME_CHAT_SOURCE,
      channel: GAME_CHAT_CHANNEL,
      timestamp: "2026-04-14T00:02:00.000Z",
    });
    expect(bridge).toMatchObject({
      bot_id: "bot-ingress",
      owner_id: null,
      source: SERVER_BRIDGE_SOURCE,
      channel: SERVER_BRIDGE_CHANNEL,
      timestamp: "2026-04-14T00:03:00.000Z",
      runtime_effect: "observe_only",
    });
    expect(web.message_id).toBe("msg-web");
    expect(gameDecision.envelope.message_id).toBe("msg-game");
    expect(bridge.event_id).toBe("evt-bridge");
  });

  it("应区分可进入主线的主人命令与应忽略 / 拒绝的游戏聊天输入", () => {
    const nonOwner = createGameChatIngressDecision({
      bot_id: "bot-chat",
      owner_id: null,
      sender_id: "guest-chat",
      owner_resolution: "non_owner",
      message_id: "msg-non-owner",
      content: `${GAME_CHAT_COMMAND_PREFIX} stop`,
      timestamp: "2026-04-14T00:10:00.000Z",
    });
    const missingPrefix = createGameChatIngressDecision({
      bot_id: "bot-chat",
      owner_id: "owner-chat",
      sender_id: "mc-owner-alice",
      owner_resolution: "matched_owner",
      message_id: "msg-missing-prefix",
      content: "你好",
      timestamp: "2026-04-14T00:11:00.000Z",
    });
    const missingOwnerBinding = createGameChatIngressDecision({
      bot_id: "bot-chat",
      owner_id: null,
      sender_id: "mc-owner-alice",
      owner_resolution: "missing_owner_binding",
      message_id: "msg-missing-owner",
      content: `${GAME_CHAT_COMMAND_PREFIX} go home`,
      timestamp: "2026-04-14T00:12:00.000Z",
    });
    const emptyCommand = createGameChatIngressDecision({
      bot_id: "bot-chat",
      owner_id: "owner-chat",
      sender_id: "mc-owner-alice",
      owner_resolution: "matched_owner",
      message_id: "msg-empty-command",
      content: `${GAME_CHAT_COMMAND_PREFIX}   `,
      timestamp: "2026-04-14T00:13:00.000Z",
    });
    const accepted = createGameChatIngressDecision({
      bot_id: "bot-chat",
      owner_id: "owner-chat",
      sender_id: "mc-owner-alice",
      owner_resolution: "matched_owner",
      message_id: "msg-accepted",
      content: `${GAME_CHAT_COMMAND_PREFIX}   mine oak_log`,
      timestamp: "2026-04-14T00:14:00.000Z",
    });

    expect(nonOwner).toMatchObject({
      status: "ignored",
      reason: "non_owner",
    });
    expect(missingPrefix).toMatchObject({
      status: "ignored",
      reason: "missing_prefix",
    });
    expect(missingOwnerBinding).toMatchObject({
      status: "rejected",
      reason: "missing_owner_binding",
    });
    expect(emptyCommand).toMatchObject({
      status: "rejected",
      reason: "empty_command",
    });
    expect(accepted).toMatchObject({
      status: "accepted",
    });

    if (accepted.status !== "accepted") {
      throw new Error("expected accepted game chat ingress decision");
    }

    expect(accepted.envelope).toMatchObject({
      bot_id: "bot-chat",
      owner_id: "owner-chat",
      session_id: null,
      message_id: "msg-accepted",
      content: "mine oak_log",
      channel: GAME_CHAT_CHANNEL,
      timestamp: "2026-04-14T00:14:00.000Z",
    });
  });

  it("应只精确匹配 control fast-path（控制快路径） 控制词", () => {
    expect(matchInterfaceControlFastPath("取消")).toEqual({
      command: "cancel",
      reason: "control_cancel",
    });
    expect(matchInterfaceControlFastPath(" 别动 ")).toEqual({
      command: "interrupt",
      reason: "control_interrupt",
    });
    expect(matchInterfaceControlFastPath("取消一下")).toBeNull();
    expect(matchInterfaceControlFastPath("先停下")).toBeNull();
  });

  it("应允许发送者标识与内部 owner_id（主人标识） 不同但已完成绑定解析的主人命令进入主线", () => {
    const accepted = createGameChatIngressDecision({
      bot_id: "bot-owner-resolution",
      owner_id: "owner-internal-001",
      sender_id: "mcPlayerAlice",
      owner_resolution: "matched_owner",
      message_id: "msg-owner-resolution",
      content: `${GAME_CHAT_COMMAND_PREFIX} collect wheat`,
      timestamp: "2026-04-14T00:15:00.000Z",
    });

    expect(accepted).toMatchObject({
      status: "accepted",
    });

    if (accepted.status !== "accepted") {
      throw new Error("expected accepted owner-resolved game chat ingress decision");
    }

    expect(accepted.envelope).toMatchObject({
      bot_id: "bot-owner-resolution",
      owner_id: "owner-internal-001",
      session_id: null,
      message_id: "msg-owner-resolution",
      content: "collect wheat",
      channel: GAME_CHAT_CHANNEL,
      timestamp: "2026-04-14T00:15:00.000Z",
    });
  });

  it("应让服务端桥接事件载荷保持深只读边界", () => {
    const bridge = createServerBridgeEventEnvelope({
      bot_id: "bot-bridge",
      owner_id: "owner-bridge",
      event_id: "evt-readonly",
      event_type: "chunk.loaded",
      timestamp: "2026-04-14T00:20:00.000Z",
      payload: {
        position: { x: 1, y: 64, z: 2 },
        players: ["alice", "bob"],
      },
    });

    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.payload)).toBe(true);
    expect(
      Object.isFrozen((bridge.payload as { position: Record<string, unknown> }).position),
    ).toBe(true);
    expect(Object.isFrozen((bridge.payload as { players: readonly string[] }).players)).toBe(true);
    expect(() => {
      (bridge.payload as { position: { x: number } }).position.x = 99;
    }).toThrow();
    expect(() => {
      (bridge.payload as { players: string[] }).players.push("charlie");
    }).toThrow();
  });
});
