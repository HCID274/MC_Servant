import { describe, expect, it } from "vitest";

import { createObservationRuntimeCache } from "../observation/index.js";
import {
  BotStatus,
  ExecPriority,
  type MineflayerRuntimeTransport,
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createSkillCallJob,
} from "../runtime/index.js";
import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../skills/index.js";

function createFakeTransport(input?: {
  chat?: (text: string) => Promise<void> | void;
  goTo?: (params: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }) => Promise<void> | void;
  mine?: (params: { readonly blockName: string; readonly count: number }) => Promise<void> | void;
  collect?: (params: {
    readonly itemName: string;
    readonly radius?: number;
  }) => Promise<void> | void;
  equip?: (params: {
    readonly itemName: string;
    readonly destination?: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";
  }) => Promise<void> | void;
  worldReady?: boolean;
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
    async goTo(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.goTo?.(params);

      return createGoToSkillExecutionResult(params);
    },
    async mine(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.mine?.(params);

      return createMineSkillExecutionResult(params);
    },
    async collect(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.collect?.(params);

      return createCollectSkillExecutionResult(params);
    },
    async equip(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.equip?.(params);

      return createEquipSkillExecutionResult(params);
    },
    getSnapshot() {
      return Object.freeze({
        bot_id: "bot-actor" as const,
        state: connected ? "connected" : "idle",
        connected,
        world_ready: connected && (input?.worldReady ?? false),
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

describe("BotActor（机器人执行代理） 单写技能入口", () => {
  it("应在 ready（就绪） 后执行 goTo（前往坐标） 并恢复 IDLE（空闲）", async () => {
    const targets: Array<{ x: number; y: number; z: number }> = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        goTo: (params) => {
          targets.push({ ...params });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    const outcome = await actor.executeSkill(
      createSkillCallJob({
        message_id: "msg-goto",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: -3 },
      }),
    );

    expect(targets).toEqual([{ x: 1, y: 64, z: -3 }]);
    expect(outcome.result).toMatchObject({
      skill: "goTo",
      reached: true,
      total_steps: 1,
    });
    expect(outcome.snapshot.status).toBe(BotStatus.IDLE);
    expect(outcome.snapshot.emitted_events).toContain("task.started");
    expect(outcome.snapshot.emitted_events).toContain("task.completed");
    expect(outcome.snapshot.skill_executions).toEqual([
      {
        message_id: "msg-goto",
        skill: "goTo",
      },
    ]);
  });

  it("应在 world_ready（世界交互就绪） 未打开时拒绝 goTo（前往坐标） 且不触碰移动适配器", async () => {
    const targets: Array<{ x: number; y: number; z: number }> = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        goTo: (params) => {
          targets.push({ ...params });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-not-ready-goto",
          intent_epoch: 1,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.goTo,
          params: { x: 1, y: 64, z: -3 },
        }),
      ),
    ).rejects.toThrow(/world interaction is not ready/);
    expect(targets).toEqual([]);
  });

  it("应拒绝执行中并发 goTo（前往坐标） 调用", async () => {
    let releaseMove: (() => void) | undefined;
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        goTo: async () => {
          await new Promise<void>((resolve) => {
            releaseMove = resolve;
          });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });
    const job = createSkillCallJob({
      message_id: "msg-goto-1",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 1, y: 64, z: -3 },
    });

    await actor.start();
    const firstExecution = actor.executeSkill(job);

    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-goto-2",
          intent_epoch: 1,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.goTo,
          params: { x: 2, y: 64, z: -3 },
        }),
      ),
    ).rejects.toThrow(/not ready/);

    releaseMove?.();
    await firstExecution;
    expect(actor.getSnapshot().status).toBe(BotStatus.IDLE);
  });

  it("应在 ready（就绪） 后执行 mine（挖掘） / collect（捡拾） / equip（装备）", async () => {
    const executed: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        mine: (params) => {
          executed.push(`mine:${params.blockName}:${params.count}`);
        },
        collect: (params) => {
          executed.push(`collect:${params.itemName}:${params.radius ?? 8}`);
        },
        equip: (params) => {
          executed.push(`equip:${params.itemName}:${params.destination ?? "hand"}`);
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-mine",
          intent_epoch: 1,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.mine,
          params: { blockName: "stone", count: 2 },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        skill: "mine",
        mined_count: 2,
      },
    });
    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-collect",
          intent_epoch: 1,
          snapshot_ts: 101,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.collect,
          params: { itemName: "cobblestone", radius: 6 },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        skill: "collect",
        item_name: "cobblestone",
      },
    });
    const equipOutcome = await actor.executeSkill(
      createSkillCallJob({
        message_id: "msg-equip",
        intent_epoch: 1,
        snapshot_ts: 102,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.equip,
        params: { itemName: "stone_pickaxe", destination: "hand" },
      }),
    );

    expect(equipOutcome.result).toMatchObject({
      skill: "equip",
      item_name: "stone_pickaxe",
      destination: "hand",
    });
    expect(executed).toEqual(["mine:stone:2", "collect:cobblestone:6", "equip:stone_pickaxe:hand"]);
    expect(actor.getSnapshot().skill_executions).toEqual([
      {
        message_id: "msg-mine",
        skill: "mine",
      },
      {
        message_id: "msg-collect",
        skill: "collect",
      },
      {
        message_id: "msg-equip",
        skill: "equip",
      },
    ]);
  });
});
