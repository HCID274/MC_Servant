import { describe, expect, it } from "vitest";
import { createCodeJobForSkill } from "./test-code-job.js";

import { createSandboxLogRef } from "../diagnostics/index.js";
import {
  type ThreatAssessment,
  ThreatLevel,
  ThreatRuleId,
  createObservationRuntimeCache,
} from "../observation/index.js";
import {
  BotStatus,
  ExecPriority,
  type InterruptSignal,
  type MineflayerRuntimeTransport,
  createBotActorRuntime,
  createCodeJob,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
} from "../runtime/index.js";
import { createSandboxExecutionRequest, executeCodeRequest } from "../sandbox/index.js";
import {
  SKILL_DIRECTORY,
  createCollectSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../skills/index.js";

const testSandboxExecution = Object.freeze({
  createLogRef: createSandboxLogRef,
  createRequest: createSandboxExecutionRequest,
  executeRequest: executeCodeRequest,
});

function createFakeTransport(input?: {
  chat?: (text: string) => Promise<void> | void;
  goTo?: (params: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }) => Promise<void> | void;
  mine?: (params: { readonly blockName: string; readonly count: number }) => Promise<void> | void;
  digBlockAt?: (position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }) => Promise<void> | void;
  collect?: (params: {
    readonly itemName: string;
    readonly radius?: number;
  }) => Promise<void> | void;
  equip?: (params: {
    readonly itemName: string;
    readonly destination?: "hand";
  }) => Promise<void> | void;
  craft?: (params: { readonly itemName: string; readonly count: number }) => Promise<void> | void;
  place?: (params: {
    readonly blockName: string;
    readonly near?: { readonly x: number; readonly y: number; readonly z: number };
  }) => Promise<void> | void;
  stopCurrentAction?: () => void;
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

      return createMineSkillExecutionResult(params, {
        collected_item_name: params.blockName,
        collected_count: params.count,
        mined_count: params.count,
      });
    },
    async digBlockAt(position) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.digBlockAt?.(position);
    },
    async collect(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.collect?.(params);

      return createCollectSkillExecutionResult(params, { collected: [] });
    },
    async equip(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.equip?.(params);

      return createEquipSkillExecutionResult(params);
    },
    async craft(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.craft?.(params);

      return {
        ok: true,
        data: {
          world_key: "minecraft:overworld",
          completed_count: params.count,
          item_name: params.itemName,
        },
      };
    },
    async place(params) {
      if (!connected) {
        throw new Error("not connected");
      }

      await input?.place?.(params);

      return {
        ok: true,
        data: {
          world_key: "minecraft:overworld",
          completed_count: 1,
          block_name: params.blockName,
        },
      };
    },
    stopCurrentAction() {
      input?.stopCurrentAction?.();
    },
    getCurrentWorldKey() {
      return "minecraft:overworld";
    },
    countInventoryItemsBySemanticRole() {
      return 0;
    },
    readObservationInput() {
      return {
        timestamp: 1_712_930_000_000,
        snapshot_version: "minecraft:overworld:test",
        bot: {
          position: { x: 12, y: 64, z: -7 },
          world_key: "minecraft:overworld",
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [{ slot: 0, item_name: "oak_log", count: 2 }],
          total_items: 2,
          occupied_slots: 1,
          free_slots: 35,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: { slot: "main_hand", item_name: "crafting_table", count: 1 },
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_entities: [],
        nearby_blocks: [],
        time: { phase: "day", time_of_day: 6000 },
      };
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

function createThreatAssessment(input: {
  level: ThreatLevel;
  ruleId: ThreatRuleId;
}): ThreatAssessment {
  return Object.freeze({
    rule_id: input.ruleId,
    level: input.level,
    reason: input.ruleId,
    interrupt_required: true,
    detected_at: 1_712_000_000,
    hostile_entities: Object.freeze([]),
    bot_state: Object.freeze({
      health: 20,
      is_on_fire: false,
      y_velocity: input.ruleId === ThreatRuleId.Falling ? -1.2 : 0,
      has_weapon_equipped: input.level === ThreatLevel.Fight,
    }),
  });
}

function createReflexInterruptSignal(threat: ThreatAssessment): InterruptSignal {
  return Object.freeze({
    source: Object.freeze({
      type: "reflex" as const,
      threat,
    }),
    reason: "threat_detected",
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
      sandboxExecution: testSandboxExecution,
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
      sandboxExecution: testSandboxExecution,
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
      sandboxExecution: testSandboxExecution,
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

describe.skip("BotActor（机器人执行代理） 单写技能入口", () => {
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
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJobForSkill({
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
      },
    ]);
    expect(outcome.snapshot.recent_events).toEqual([
      {
        message_id: "msg-goto",
        line: "goTo 成功,到达 (1,64,-3)",
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("应通过注入 formatter（格式化器） 生成 recent_events（最近事件） 单行", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const formattedInputs: unknown[] = [];
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        goTo: () => undefined,
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
      recentEventFormatter: {
        formatSkill: (input) => {
          formattedInputs.push(input);

          return `custom:${input.skill}:${input.status}`;
        },
        formatSandbox: () => "custom:sandbox",
      },
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJobForSkill({
        message_id: "msg-custom-formatter",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: -3 },
      }),
    );

    expect(formattedInputs).toMatchObject([
      {
        skill: "goTo",
        status: "completed",
      },
    ]);
    expect(outcome.snapshot.recent_events.at(-1)).toMatchObject({
      message_id: "msg-custom-formatter",
      line: "custom:goTo:completed",
    });
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
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    await expect(
      actor.executeCode(
        createCodeJobForSkill({
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
      sandboxExecution: testSandboxExecution,
    });
    const job = createCodeJobForSkill({
      message_id: "msg-goto-1",
      intent_epoch: 1,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: SKILL_DIRECTORY.goTo,
      params: { x: 1, y: 64, z: -3 },
    });

    await actor.start();
    const firstExecution = actor.executeCode(job);

    expect(actor.getSnapshot()).toMatchObject({
      status: BotStatus.EXECUTING,
      current_task: {
        kind: "code",
        message_id: "msg-goto-1",
      },
    });
    await expect(
      actor.executeCode(
        createCodeJobForSkill({
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
    expect(actor.getSnapshot().current_task).toBeNull();
  });

  it("应允许 EXECUTING（执行中） 状态通过单写者入口广播闲聊回复", async () => {
    let releaseMove: (() => void) | undefined;
    const written: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        chat: (text) => {
          written.push(text);
        },
        goTo: async () => {
          await new Promise<void>((resolve) => {
            releaseMove = resolve;
          });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const execution = actor.executeCode(
      createCodeJobForSkill({
        message_id: "msg-goto-running",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: -3 },
      }),
    );

    expect(actor.getSnapshot()).toMatchObject({
      status: BotStatus.EXECUTING,
      current_task: {
        kind: "code",
        message_id: "msg-goto-running",
      },
    });

    const replySnapshot = await actor.broadcastReply({
      message_id: "msg-ask-state",
      content: "我正在去目标点喵~",
    });

    expect(written).toEqual(["我正在去目标点喵~"]);
    expect(replySnapshot.status).toBe(BotStatus.EXECUTING);
    expect(replySnapshot.current_task).toEqual({
      kind: "code",
      message_id: "msg-goto-running",
    });

    releaseMove?.();
    await execution;
    expect(actor.getSnapshot().status).toBe(BotStatus.IDLE);
    expect(actor.getSnapshot().current_task).toBeNull();
  });

  it("应允许 mine（挖掘）/collect（捡拾）/equip（装备） 走 BotActor（机器人执行代理） 单写者入口", async () => {
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
      actor.executeCode(
        createCodeJobForSkill({
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
        status: "completed",
      },
    });
    await expect(
      actor.executeCode(
        createCodeJobForSkill({
          message_id: "msg-collect",
          intent_epoch: 1,
          snapshot_ts: 101,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.collect,
          params: { itemName: "cobblestone", radius: 32 },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        skill: "collect",
        item_name: "cobblestone",
        radius: 32,
      },
    });
    await expect(
      actor.executeCode(
        createCodeJobForSkill({
          message_id: "msg-equip",
          intent_epoch: 1,
          snapshot_ts: 102,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.equip,
          params: { itemName: "stone_pickaxe", destination: "hand" },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        skill: "equip",
        item_name: "stone_pickaxe",
        destination: "hand",
        status: "equipped",
      },
    });

    expect(executed).toEqual([
      "mine:stone:2",
      "collect:cobblestone:32",
      "equip:stone_pickaxe:hand",
    ]);
    expect(actor.getSnapshot().skill_executions).toEqual([
      {
        message_id: "msg-mine",
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

describe("BotActor（机器人执行代理） 脊髓反射入口", () => {
  it("应在 IDLE（空闲） 状态执行 flee（逃离） 反射并回到 IDLE（空闲）", async () => {
    const actions: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
      reflexActionExecutor: ({ action }) => {
        actions.push(action);
      },
    });

    await actor.start();
    const snapshot = await actor.interrupt(
      createReflexInterruptSignal(
        createThreatAssessment({
          level: ThreatLevel.Flee,
          ruleId: ThreatRuleId.HostileSwarm,
        }),
      ),
    );

    expect(actions).toEqual(["flee"]);
    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.recent_reflex).toEqual({
      action: "flee",
      selected_action: "flee",
      rule_id: ThreatRuleId.HostileSwarm,
      threat_level: ThreatLevel.Flee,
      status: "completed",
      error: null,
    });
    expect(snapshot.emitted_events).toContain("state.transition");
    expect(snapshot.emitted_events).toContain("reflex.triggered");
    expect(snapshot.emitted_events).toContain("reflex.done");
  });

  it.skip("应在 EXECUTING（执行中） 状态中断原任务并执行 fight（战斗） 反射", async () => {
    let releaseMove: (() => void) | undefined;
    const actions: string[] = [];
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
      reflexActionExecutor: ({ action }) => {
        actions.push(action);
      },
    });

    await actor.start();
    const execution = actor.executeCode(
      createCodeJobForSkill({
        message_id: "msg-running",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: -3 },
      }),
    );

    expect(actor.getSnapshot().status).toBe(BotStatus.EXECUTING);
    const snapshot = await actor.interrupt(
      createReflexInterruptSignal(
        createThreatAssessment({
          level: ThreatLevel.Fight,
          ruleId: ThreatRuleId.HostileCloseArmed,
        }),
      ),
    );

    expect(actions).toEqual(["fight"]);
    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.current_task).toBeNull();
    expect(snapshot.recent_reflex?.action).toBe("fight");
    expect(snapshot.emitted_events).toContain("task.interrupted");
    expect(snapshot.emitted_events).not.toContain("task.completed");

    releaseMove?.();
    await expect(execution).rejects.toThrow(/interrupted/);
    expect(actor.getSnapshot().emitted_events).not.toContain("task.completed");
  });

  it("triage cancel（分诊取消） 应立即停止当前 Mineflayer（Minecraft 协议客户端） 动作", async () => {
    let releaseMove: (() => void) | undefined;
    let stopCalls = 0;
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
        stopCurrentAction: () => {
          stopCalls += 1;
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const execution = actor.executeCode(
      createCodeJobForSkill({
        message_id: "msg-running-cancel",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        skill: SKILL_DIRECTORY.goTo,
        params: { x: 1, y: 64, z: -3 },
      }),
    );

    await actor.interrupt({
      source: {
        type: "triage",
        intent_epoch: 2,
      },
      reason: "owner_cancel",
    });

    expect(stopCalls).toBe(1);
    expect(actor.getSnapshot().status).toBe(BotStatus.IDLE);
    expect(actor.getSnapshot().current_task).toBeNull();

    releaseMove?.();
    await expect(execution).rejects.toThrow(/interrupted/);
  });

  it("应把 Emergency/Falling（紧急/坠落） 反射收口为 no_op（无操作）", async () => {
    const actions: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      reflexActionExecutor: ({ action }) => {
        actions.push(action);
      },
    });

    await actor.start();
    const snapshot = await actor.interrupt(
      createReflexInterruptSignal(
        createThreatAssessment({
          level: ThreatLevel.Emergency,
          ruleId: ThreatRuleId.Falling,
        }),
      ),
    );

    expect(actions).toEqual(["no_op"]);
    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.recent_reflex).toMatchObject({
      action: "no_op",
      selected_action: "no_op",
      rule_id: ThreatRuleId.Falling,
      threat_level: ThreatLevel.Emergency,
      status: "completed",
    });
  });

  it("应在未注入执行器时安全降级为 no_op（无操作），不得伪装成逃离", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
    });

    await actor.start();
    const snapshot = await actor.interrupt(
      createReflexInterruptSignal(
        createThreatAssessment({
          level: ThreatLevel.Flee,
          ruleId: ThreatRuleId.HostileCloseUnarmed,
        }),
      ),
    );

    expect(snapshot.status).toBe(BotStatus.IDLE);
    expect(snapshot.recent_reflex).toMatchObject({
      action: "no_op",
      selected_action: "flee",
      status: "completed",
      error: null,
    });
  });

  it("应在执行器失败或超时后回到 IDLE（空闲） 并留下反射摘要", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const failedActor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      reflexActionExecutor: () => {
        throw new Error("reflex actuator failed");
      },
    });
    const timedOutActor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      reflexActionExecutor: async () => {
        await new Promise<void>(() => {});
      },
      reflexActionTimeoutMs: 1,
    });
    const fightSignal = createReflexInterruptSignal(
      createThreatAssessment({
        level: ThreatLevel.Fight,
        ruleId: ThreatRuleId.HostileCloseArmed,
      }),
    );

    await failedActor.start();
    const failedSnapshot = await failedActor.interrupt(fightSignal);
    await timedOutActor.start();
    const timedOutSnapshot = await timedOutActor.interrupt(fightSignal);

    expect(failedSnapshot.status).toBe(BotStatus.IDLE);
    expect(failedSnapshot.recent_reflex).toMatchObject({
      action: "fight",
      status: "failed",
      error: "reflex actuator failed",
    });
    expect(failedSnapshot.emitted_events).toContain("reflex.done");
    expect(timedOutSnapshot.status).toBe(BotStatus.IDLE);
    expect(timedOutSnapshot.recent_reflex).toMatchObject({
      action: "fight",
      status: "timed_out",
      error: "BotActor reflex action timed out",
    });
    expect(timedOutSnapshot.emitted_events).toContain("reflex.done");
  });

  it("应返回只读反射快照，调用方不能污染后续查询", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport(),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      reflexActionExecutor: () => {},
    });

    await actor.start();
    const snapshot = await actor.interrupt(
      createReflexInterruptSignal(
        createThreatAssessment({
          level: ThreatLevel.Fight,
          ruleId: ThreatRuleId.HostileCloseArmed,
        }),
      ),
    );

    expect(Object.isFrozen(snapshot.recent_reflex)).toBe(true);
    expect(() => {
      (snapshot.recent_reflex as unknown as { action: string }).action = "flee";
    }).toThrow();
    expect(actor.getSnapshot().recent_reflex?.action).toBe("fight");
  });
});

describe("BotActor（机器人执行代理） 沙箱代码入口", () => {
  it("应通过 BotActor（机器人执行代理） 单写者执行 code（沙箱代码） 聊天动作", async () => {
    const written: string[] = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        chat: (text) => {
          written.push(text);
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-chat",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_001_000,
        priority: ExecPriority.Normal,
        code: "await reply('sandbox hello')",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(written).toEqual(["sandbox hello"]);
    expect(outcome.result.step_results).toMatchObject([
      {
        action: "say",
        status: "ok",
      },
    ]);
    expect(outcome.snapshot.code_executions).toEqual([
      {
        message_id: "msg-sandbox-chat",
        status: "completed",
        total_steps: 1,
      },
    ]);
    expect(outcome.snapshot.recent_events.at(-1)).toMatchObject({
      message_id: "msg-sandbox-chat",
      line: "sandbox 成功,步骤 1",
    });
    expect(outcome.snapshot.chat_writes).toContainEqual({
      kind: "sandbox_chat",
      message_id: "msg-sandbox-chat",
      method: "say",
    });
  });

  it("应让 code（沙箱代码） 的 bot.goTo（前往坐标） 复用真实技能执行边界", async () => {
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
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-goto",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_000,
        priority: ExecPriority.Normal,
        code: "await goTo(1, 64, 1)",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(targets).toEqual([{ x: 1, y: 64, z: 1 }]);
    expect(outcome.result.step_results).toMatchObject([
      {
        action: "goTo",
        status: "ok",
        params: { x: 1, y: 64, z: 1 },
      },
    ]);
  });

  it("应让 code（沙箱代码） 的 bot.place（放置） 复用工具链执行边界", async () => {
    const placements: Array<{ readonly blockName: string }> = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        place: (params) => {
          placements.push({ blockName: params.blockName });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-place",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_500,
        priority: ExecPriority.Normal,
        code: "await place('crafting_table')",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(placements).toEqual([{ blockName: "crafting_table" }]);
    expect(outcome.result.step_results).toMatchObject([
      {
        action: "place",
        status: "ok",
        params: { blockName: "crafting_table" },
      },
    ]);
  });

  it("应让 code（沙箱代码） 通过 place('crafting_table') 复用工具链执行边界", async () => {
    const placements: Array<{ readonly blockName: string }> = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        place: (params) => {
          placements.push({ blockName: params.blockName });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-place-table",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_550,
        priority: ExecPriority.Normal,
        code: "await place('crafting_table')",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(placements).toEqual([{ blockName: "crafting_table" }]);
    expect(outcome.result.step_results).toMatchObject([
      {
        action: "place",
        status: "ok",
        params: { blockName: "crafting_table" },
      },
    ]);
  });

  it("应让 code（沙箱代码） 的 bot.craft（合成） 复用工具链执行边界", async () => {
    const crafts: Array<{ readonly itemName: string; readonly count: number }> = [];
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        craft: (params) => {
          crafts.push({ itemName: params.itemName, count: params.count });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-craft",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_600,
        priority: ExecPriority.Normal,
        code: "await craft('wooden_pickaxe', 1)",
      }),
    );

    expect(outcome.result.status).toBe("completed");
    expect(crafts).toEqual([{ itemName: "wooden_pickaxe", count: 1 }]);
    expect(outcome.result.step_results).toMatchObject([
      {
        action: "craft",
        status: "ok",
        params: { itemName: "wooden_pickaxe", count: 1 },
      },
    ]);
  });

  it("应让 code（沙箱代码） 的 bot.place（放置） 暴露工具链失败码", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        place: () => {
          throw Object.assign(new Error("Inventory does not contain enough recipe ingredients"), {
            error_code: "missing_materials",
          });
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-place-fail",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_500,
        priority: ExecPriority.Normal,
        code: "await place('crafting_table')",
      }),
    );

    expect(outcome.result.status).toBe("failed");
    if (outcome.result.status !== "failed") {
      throw new Error("expected sandbox place failure");
    }
    expect(outcome.result.error).toMatchObject({
      name: "FacadeCallError",
      error_code: "missing_materials",
      details: {
        failure_stage: "place",
        current_position: { x: 12, y: 64, z: -7 },
        inventory_summary: {
          items: [{ slot: 0, item_name: "oak_log", count: 2 }],
        },
        equipment_summary: {
          main_hand: { slot: "main_hand", item_name: "crafting_table", count: 1 },
        },
        target_progress: {
          action: "place",
          target: "crafting_table",
        },
      },
    });
  });

  it("应让 code（沙箱代码） 的 bot.mine（挖掘） 技能失败保留可重规划上下文", async () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const actor = createBotActorRuntime({
      botId: "bot-actor",
      transport: createFakeTransport({
        worldReady: true,
        mine: () => {
          throw new Error("not_equipped:stone:main_hand_empty");
        },
      }),
      observation: createObservationRuntimeCache(),
      externalAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(externalAuth),
      sandboxExecution: testSandboxExecution,
    });

    await actor.start();
    const outcome = await actor.executeCode(
      createCodeJob({
        message_id: "msg-sandbox-mine-fail",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_700,
        priority: ExecPriority.Normal,
        code: "await mine('stone', 5)",
      }),
    );

    expect(outcome.result.status).toBe("failed");
    if (outcome.result.status !== "failed") {
      throw new Error("expected sandbox mine failure");
    }
    expect(outcome.result.error).toMatchObject({
      name: "FacadeCallError",
      error_code: "not_equipped",
      details: {
        failure_stage: "mine",
        current_position: { x: 12, y: 64, z: -7 },
        inventory_summary: {
          items: [{ slot: 0, item_name: "oak_log", count: 2 }],
        },
        equipment_summary: {
          main_hand: { slot: "main_hand", item_name: "crafting_table", count: 1 },
        },
        target_progress: {
          action: "mine",
          target: "stone",
          requested_count: 5,
        },
      },
    });
  });

  it("应在 world_ready（世界交互就绪） 未打开时拒绝 code（沙箱代码） 且不写聊天", async () => {
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
    await expect(
      actor.executeCode(
        createCodeJob({
          message_id: "msg-sandbox-not-ready",
          intent_epoch: 1,
          snapshot_ts: 1_712_930_003_000,
          priority: ExecPriority.Normal,
          code: "await reply('should not write')",
        }),
      ),
    ).rejects.toThrow(/world interaction is not ready/);
    expect(written).toEqual([]);
  });
});
