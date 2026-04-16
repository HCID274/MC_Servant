import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  BotStatus,
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerRuntimeTransport,
  createMineflayerTransportDescriptor,
  createObservationRuntimeCache,
} from "../index.js";
import type { MineflayerBotHandle } from "../runtime/transport.js";

class FakeMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username = "bot-mc";
  readonly chatWrites: string[] = [];
  closed = false;

  chat(text: string): void {
    this.chatWrites.push(text);
  }

  quit(): void {
    this.closed = true;
    this.emit("end");
  }
}

describe("runtime Mineflayer（Minecraft 协议客户端） 最小闭环", () => {
  it("应通过可注入工厂完成连接、spawn（生成） 与断开生命周期", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mc",
        host: "mc.local",
        port: 25566,
      }),
      {
        createBot: (options) => {
          expect(options).toMatchObject({
            username: "bot-mc",
            host: "mc.local",
            port: 25566,
          });

          const bot = new FakeMineflayerBot();
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();

    expect(transport.getSnapshot().state).toBe("connecting");
    await Promise.resolve();
    createdBots[0]?.emit("spawn");

    const connected = await connectPromise;

    expect(connected.state).toBe("connected");
    expect(connected.connected).toBe(true);
    expect(connected.username).toBe("bot-mc");
    const eventSource = transport.getEventSource();
    expect(eventSource).not.toBeNull();
    expect(eventSource).not.toBe(createdBots[0]);
    expect("quit" in (eventSource ?? {})).toBe(false);

    const disconnected = await transport.disconnect("test shutdown");

    expect(disconnected.state).toBe("disconnected");
    expect(createdBots[0]?.closed).toBe(true);
    expect(transport.getEventSource()).toBeNull();
  });

  it("应允许 EasyAuth（离线服认证模组） 场景在 login（协议登录） 后进入最小聊天连接态", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-login-ready",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();

    await Promise.resolve();
    createdBots[0]?.emit("login");

    const connected = await connectPromise;

    expect(connected.state).toBe("connected");
    expect(connected.connected).toBe(true);
    expect(transport.getEventSource()).not.toBeNull();

    await transport.disconnect("test shutdown");
  });

  it("应在 spawn（生成） 前失败时回收 Bot（机器人） 与运行时监听器", async () => {
    const failedBot = new FakeMineflayerBot();
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-failed",
      }),
      {
        createBot: () => failedBot,
      },
    );

    const connectPromise = transport.connect();

    await Promise.resolve();
    failedBot.emit("error", new Error("server refused"));

    await expect(connectPromise).rejects.toThrow("server refused");
    expect(transport.getSnapshot()).toMatchObject({
      state: "failed",
      connected: false,
      last_error: "server refused",
    });
    expect(failedBot.closed).toBe(true);
    expect(transport.getEventSource()).toBeNull();
    expect(failedBot.listenerCount("login")).toBe(0);
    expect(failedBot.listenerCount("spawn")).toBe(0);
    expect(failedBot.listenerCount("end")).toBe(0);
    expect(failedBot.listenerCount("kicked")).toBe(0);
    expect(failedBot.listenerCount("error")).toBe(0);
  });

  it("应只在 Mineflayer（Minecraft 协议客户端） 已连接且外部认证允许时进入 IDLE（空闲）", async () => {
    const readyBot = new FakeMineflayerBot();
    const readyTransport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-ready",
      }),
      {
        createBot: () => readyBot,
      },
    );
    const readyActor = createBotActorRuntime({
      botId: "bot-ready",
      transport: readyTransport,
      observation: createObservationRuntimeCache(),
      externalAuth: createExternalAuthState({ status: "not_required" }),
      externalAuthPlan: createExternalAuthExecutionPlan(
        createExternalAuthState({ status: "not_required" }),
      ),
    });
    const readyPromise = readyActor.start();

    await Promise.resolve();
    readyBot.emit("spawn");

    const readySnapshot = await readyPromise;

    expect(readySnapshot.status).toBe(BotStatus.IDLE);
    expect(readySnapshot.ready_gate.ready).toBe(true);
    expect(readySnapshot.emitted_events).toContain("bot.ready");

    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const pendingAuth = createExternalAuthState({
      status: "pending",
      secret,
    });
    const pendingBot = new FakeMineflayerBot();
    const pendingActor = createBotActorRuntime({
      botId: "bot-pending",
      transport: createMineflayerRuntimeTransport(
        createMineflayerTransportDescriptor({
          botId: "bot-pending",
        }),
        {
          createBot: () => pendingBot,
        },
      ),
      observation: createObservationRuntimeCache(),
      externalAuth: pendingAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(pendingAuth, secret),
    });
    const pendingPromise = pendingActor.start();

    await Promise.resolve();
    pendingBot.emit("spawn");

    const pendingSnapshot = await pendingPromise;

    expect(pendingBot.chatWrites).toEqual(["/login hunter2"]);
    expect(pendingSnapshot.status).toBe(BotStatus.IDLE);
    expect(pendingSnapshot.ready_gate.ready).toBe(true);
    expect(pendingSnapshot.external_auth.status).toBe("authenticated");
    expect(pendingSnapshot.external_auth_plan.status).toBe("authenticated");
    expect(pendingSnapshot.external_auth_plan.next_action).toBeNull();
    expect(pendingSnapshot.emitted_events).toContain("bot.ready");
  });
});
