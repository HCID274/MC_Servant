import { describe, expect, it } from "vitest";

import { createObservationRuntimeCache } from "../observation/index.js";
import {
  BotStatus,
  type MineflayerRuntimeTransport,
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
} from "../runtime/index.js";

function createFakeTransport(input?: {
  chat?: (text: string) => Promise<void> | void;
}): MineflayerRuntimeTransport<"bot-actor"> {
  let connected = false;
  const descriptor = createMineflayerTransportDescriptor({
    botId: "bot-actor",
  });

  return Object.freeze({
    descriptor,
    async connect() {
      connected = true;

      return this.getSnapshot();
    },
    async disconnect() {
      connected = false;

      return this.getSnapshot();
    },
    async chat(text: string) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.chat?.(text);
    },
    getSnapshot() {
      return Object.freeze({
        bot_id: "bot-actor" as const,
        state: connected ? "connected" : "idle",
        connected,
        descriptor,
        username: "bot-actor",
        last_error: null,
      });
    },
    getEventSource() {
      return null;
    },
  });
}

describe("BotActor（机器人执行代理） 单写聊天入口", () => {
  it("应在 ready（就绪） 后通过 transport（传输） 写入聊天并记录事件", async () => {
    const written: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        chat: (text) => {
          written.push(text);
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    const snapshot = await actor.broadcastReply({
      message_id: "msg-ready",
      content: "主人你好喵~",
    });

    expect(written).toEqual(["主人你好喵~"]);
    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.ready_gate.ready).toBe(true);
    expect(snapshot.external_auth.status).toBe("not_required");
    expect(snapshot.emitted_events).toContain("chat.reply");
  });

  it("应在 not-ready（未就绪） 时拒绝聊天写入", async () => {
    const written: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        chat: (text) => {
          written.push(text);
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await expect(
      actor.broadcastReply({
        message_id: "msg-not-ready",
        content: "还没准备好喵~",
      }),
    ).rejects.toThrow(/not ready/);
    expect(written).toEqual([]);
  });

  it("应拒绝并发聊天写入，保持 BotActor（机器人执行代理） 单写者串行边界", async () => {
    let releaseWrite: (() => void) | undefined;
    const written: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        chat: async (text) => {
          written.push(text);
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    const firstWrite = actor.broadcastReply({
      message_id: "msg-1",
      content: "第一句喵~",
    });

    await expect(
      actor.broadcastReply({
        message_id: "msg-2",
        content: "第二句喵~",
      }),
    ).rejects.toThrow(/already in flight/);

    releaseWrite?.();
    await firstWrite;
    expect(written).toEqual(["第一句喵~"]);
  });

  it("应通过受控 external_auth_login（外部认证登录） 路径发送登录命令并清除明文计划", async () => {
    const written: string[] = [];
    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const externalAuth = createExternalAuthState({
      status: "pending",
      secret,
    });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        chat: (text) => {
          written.push(text);
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth, secret),
    });

    const snapshot = await actor.start();

    expect(written).toEqual(["/login hunter2"]);
    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.ready_gate.ready).toBe(true);
    expect(snapshot.external_auth.status).toBe("authenticated");
    expect(snapshot.external_auth_plan.status).toBe("authenticated");
    expect(snapshot.external_auth_plan).not.toHaveProperty("next_action.command");
  });

  it("应在 external_auth_login（外部认证登录） 写入失败时透出 transport（传输） 错误", async () => {
    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const externalAuth = createExternalAuthState({
      status: "pending",
      secret,
    });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        chat: () => {
          throw new Error("Mineflayer bot handle does not expose chat");
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth, secret),
    });

    await expect(actor.start()).rejects.toThrow("Mineflayer bot handle does not expose chat");
    expect(actor.getSnapshot().external_auth.status).toBe("pending");
  });
});
