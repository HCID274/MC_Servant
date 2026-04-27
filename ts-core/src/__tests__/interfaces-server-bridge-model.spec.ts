import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  SERVER_BRIDGE_PROTOCOL_VERSION,
  SERVER_BRIDGE_WS_PATH,
  type ServerBridgeEventEnvelope,
  type ServerBridgeFrameParseFailure,
  createServerBridgeAckFrame,
  createServerBridgeEnvelopeFromFrame,
  createServerBridgeErrorFrame,
  parseServerBridgeInboundFrame,
  registerServerBridgeWsRoute,
} from "../interfaces/index.js";

describe("server-bridge 协议契约", () => {
  it("应解析正确的 hello / heartbeat / player_message 帧并构造可冻结 envelope", () => {
    const helloRaw = JSON.stringify({
      type: "hello",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      mod_id: "mcservant",
      mod_version: "0.4.0",
      connected_at: "2026-04-27T00:00:00.000Z",
      instance_id: "local-fabric-01",
    });
    const heartbeatRaw = JSON.stringify({
      type: "heartbeat",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      instance_id: "local-fabric-01",
      sequence: 3,
      timestamp: "2026-04-27T00:00:02.000Z",
      state: "CONNECTED",
    });
    const playerRaw = JSON.stringify({
      type: "player_message",
      protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      instance_id: "local-fabric-01",
      message_id: "msg-1",
      player_uuid: "00000000-0000-0000-0000-000000000001",
      player_name: "Steve",
      content: "/svs hello",
      timestamp: "2026-04-27T00:00:03.000Z",
    });

    const helloResult = parseServerBridgeInboundFrame(helloRaw);
    const heartbeatResult = parseServerBridgeInboundFrame(heartbeatRaw);
    const playerResult = parseServerBridgeInboundFrame(playerRaw);

    expect(helloResult.ok).toBe(true);
    expect(heartbeatResult.ok).toBe(true);
    expect(playerResult.ok).toBe(true);
    if (!helloResult.ok || !heartbeatResult.ok || !playerResult.ok) {
      throw new Error("expected parse to succeed");
    }

    const envelope = createServerBridgeEnvelopeFromFrame({
      frame: playerResult.frame,
      botId: "bot-bridge",
      eventId: "event-bridge-1",
      receivedAt: "2026-04-27T00:00:04.000Z",
    });

    expect(envelope).toMatchObject({
      bot_id: "bot-bridge",
      event_id: "event-bridge-1",
      event_type: "server_bridge.player_message",
      runtime_effect: "observe_only",
      payload: {
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
        instance_id: "local-fabric-01",
        message_id: "msg-1",
        player_uuid: "00000000-0000-0000-0000-000000000001",
        player_name: "Steve",
        content: "/svs hello",
      },
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it("应把非法 JSON / 未知 type / 协议版本不匹配 / 缺失字段 / 字段类型错误统一收口为失败结果", () => {
    const failures: ServerBridgeFrameParseFailure[] = [
      ifFailure(parseServerBridgeInboundFrame("not-json")),
      ifFailure(parseServerBridgeInboundFrame(JSON.stringify({ type: "weird" }))),
      ifFailure(
        parseServerBridgeInboundFrame(
          JSON.stringify({ type: "hello", protocol_version: "server-bridge.v9" }),
        ),
      ),
      ifFailure(
        parseServerBridgeInboundFrame(
          JSON.stringify({
            type: "hello",
            protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
            mod_id: "mcservant",
          }),
        ),
      ),
      ifFailure(
        parseServerBridgeInboundFrame(
          JSON.stringify({
            type: "heartbeat",
            protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
            instance_id: "local",
            sequence: -1,
            timestamp: "2026-04-27T00:00:02.000Z",
            state: "CONNECTED",
          }),
        ),
      ),
    ];

    expect(failures.map((failure) => failure.code)).toEqual([
      "invalid_json",
      "unknown_type",
      "protocol_version_mismatch",
      "missing_field",
      "invalid_field",
    ]);
  });

  it("应让 ack 与 error 帧不携带 token 信息", () => {
    const ack = createServerBridgeAckFrame({
      ackType: "hello",
      timestamp: "2026-04-27T00:00:05.000Z",
    });
    const errorFrame = createServerBridgeErrorFrame({
      code: "invalid_json",
      message: "bad frame",
      timestamp: "2026-04-27T00:00:06.000Z",
    });
    const serialized = `${JSON.stringify(ack)}|${JSON.stringify(errorFrame)}`;

    expect(ack).toEqual({
      type: "ack",
      ack_type: "hello",
      timestamp: "2026-04-27T00:00:05.000Z",
    });
    expect(errorFrame).toEqual({
      type: "error",
      code: "invalid_json",
      message: "bad frame",
      timestamp: "2026-04-27T00:00:06.000Z",
    });
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("Bearer");
  });
});

describe("server-bridge WebSocket 路由", () => {
  let server: ReturnType<typeof Fastify>;
  let address: string;

  beforeEach(async () => {
    server = Fastify();
  });

  afterEach(async () => {
    await server.close();
  });

  async function startServer(options: {
    accessToken: string;
    onEvent?: (event: { envelope: ServerBridgeEventEnvelope }) => void;
    onParseFailure?: (input: { failure: ServerBridgeFrameParseFailure }) => void;
  }): Promise<void> {
    await registerServerBridgeWsRoute(server, {
      botId: "bot-bridge",
      accessToken: options.accessToken,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onParseFailure === undefined ? {} : { onParseFailure: options.onParseFailure }),
    });
    address = await server.listen({ host: "127.0.0.1", port: 0 });
  }

  function buildWsUrl(path: string = SERVER_BRIDGE_WS_PATH): string {
    return `${address.replace(/^http/, "ws")}${path}`;
  }

  function connect(token: string | null): WebSocket {
    return new WebSocket(buildWsUrl(), {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  }

  function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      socket.once("message", (data) => {
        resolve(data.toString("utf8"));
      });
      socket.once("error", reject);
    });
  }

  function waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
  }

  function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
  }

  it("应在正确 token 下完成 hello / heartbeat / player_message 闭环并返回 ack", async () => {
    const events: ServerBridgeEventEnvelope[] = [];
    await startServer({
      accessToken: "local-dev-token",
      onEvent: ({ envelope }) => {
        events.push(envelope);
      },
    });

    const socket = connect("local-dev-token");
    await waitForOpen(socket);

    socket.send(
      JSON.stringify({
        type: "hello",
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
        mod_id: "mcservant",
        mod_version: "0.4.0",
        connected_at: "2026-04-27T00:00:00.000Z",
        instance_id: "local-fabric-01",
      }),
    );
    const helloAck = JSON.parse(await nextMessage(socket));

    socket.send(
      JSON.stringify({
        type: "heartbeat",
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
        instance_id: "local-fabric-01",
        sequence: 1,
        timestamp: "2026-04-27T00:00:02.000Z",
        state: "CONNECTED",
      }),
    );
    const heartbeatAck = JSON.parse(await nextMessage(socket));

    socket.send(
      JSON.stringify({
        type: "player_message",
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
        instance_id: "local-fabric-01",
        message_id: "msg-svs-1",
        player_uuid: "00000000-0000-0000-0000-000000000001",
        player_name: "Steve",
        content: "/svs 你好",
        timestamp: "2026-04-27T00:00:03.000Z",
      }),
    );
    const playerAck = JSON.parse(await nextMessage(socket));

    socket.close();
    await waitForClose(socket);

    expect(helloAck).toMatchObject({ type: "ack", ack_type: "hello" });
    expect(heartbeatAck).toMatchObject({ type: "ack", ack_type: "heartbeat" });
    expect(playerAck).toMatchObject({ type: "ack", ack_type: "player_message" });
    expect(events.map((event) => event.event_type)).toEqual([
      "server_bridge.hello",
      "server_bridge.heartbeat",
      "server_bridge.player_message",
    ]);
    expect(events.every((event) => event.runtime_effect === "observe_only")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("local-dev-token");
  });

  it("应拒绝缺失 token、错误 token，并不写入 replay", async () => {
    const events: ServerBridgeEventEnvelope[] = [];
    await startServer({
      accessToken: "local-dev-token",
      onEvent: ({ envelope }) => {
        events.push(envelope);
      },
    });

    const missingTokenSocket = connect(null);
    const missingTokenError = await new Promise<Error>((resolve) => {
      missingTokenSocket.once("error", (err) => resolve(err));
    });

    const wrongTokenSocket = connect("wrong-token");
    const wrongTokenError = await new Promise<Error>((resolve) => {
      wrongTokenSocket.once("error", (err) => resolve(err));
    });

    expect(missingTokenError.message).toMatch(/401/);
    expect(wrongTokenError.message).toMatch(/401/);
    expect(events).toEqual([]);
  });

  it("应在非法 JSON / 未知 type / 缺失字段时返回 error 帧而非崩溃，且不污染 replay", async () => {
    const events: ServerBridgeEventEnvelope[] = [];
    const failures: ServerBridgeFrameParseFailure[] = [];
    await startServer({
      accessToken: "local-dev-token",
      onEvent: ({ envelope }) => {
        events.push(envelope);
      },
      onParseFailure: ({ failure }) => {
        failures.push(failure);
      },
    });

    const socket = connect("local-dev-token");
    await waitForOpen(socket);

    socket.send("not-json");
    const invalidJsonError = JSON.parse(await nextMessage(socket));

    socket.send(
      JSON.stringify({
        type: "totally-unknown",
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
      }),
    );
    const unknownTypeError = JSON.parse(await nextMessage(socket));

    socket.send(
      JSON.stringify({
        type: "player_message",
        protocol_version: SERVER_BRIDGE_PROTOCOL_VERSION,
        instance_id: "local-fabric-01",
        // message_id 缺失
        player_uuid: "00000000-0000-0000-0000-000000000001",
        player_name: "Steve",
        content: "/svs hi",
        timestamp: "2026-04-27T00:00:03.000Z",
      }),
    );
    const missingFieldError = JSON.parse(await nextMessage(socket));

    socket.close();
    await waitForClose(socket);

    expect(invalidJsonError).toMatchObject({ type: "error", code: "invalid_json" });
    expect(unknownTypeError).toMatchObject({ type: "error", code: "unknown_type" });
    expect(missingFieldError).toMatchObject({ type: "error", code: "missing_field" });
    expect(events).toEqual([]);
    expect(failures.map((failure) => failure.code)).toEqual([
      "invalid_json",
      "unknown_type",
      "missing_field",
    ]);
  });
});

function ifFailure(
  result: ReturnType<typeof parseServerBridgeInboundFrame>,
): ServerBridgeFrameParseFailure {
  if (result.ok) {
    throw new Error("expected parse failure");
  }
  return result;
}
