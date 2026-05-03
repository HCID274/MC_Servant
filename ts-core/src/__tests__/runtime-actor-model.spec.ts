import { describe, expect, it } from "vitest";

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
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createSandboxCodeJob,
  createSkillCallJob,
} from "../runtime/index.js";
import { createSandboxExecutionRequest, executeSandboxCodeRequest } from "../sandbox/index.js";
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
  executeRequest: executeSandboxCodeRequest,
});

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
      sandboxExecution: testSandboxExecution,
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
    const outcome = await actor.executeSkill(
      createSkillCallJob({
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
      sandboxExecution: testSandboxExecution,
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

    expect(actor.getSnapshot()).toMatchObject({
      status: BotStatus.EXECUTING,
      current_task: {
        kind: "skill_call",
        message_id: "msg-goto-1",
        skill: "goTo",
      },
    });
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
    const execution = actor.executeSkill(
      createSkillCallJob({
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
        kind: "skill_call",
        message_id: "msg-goto-running",
        skill: "goTo",
      },
    });

    const replySnapshot = await actor.broadcastReply({
      message_id: "msg-ask-state",
      content: "我正在去目标点喵~",
    });

    expect(written).toEqual(["我正在去目标点喵~"]);
    expect(replySnapshot.status).toBe(BotStatus.EXECUTING);
    expect(replySnapshot.current_task).toEqual({
      kind: "skill_call",
      message_id: "msg-goto-running",
      skill: "goTo",
    });

    releaseMove?.();
    await execution;
    expect(actor.getSnapshot().status).toBe(BotStatus.IDLE);
    expect(actor.getSnapshot().current_task).toBeNull();
  });

  it("应允许 collect（捡拾） 并拒绝未启用 mine（挖掘） / equip（装备） 技能", async () => {
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
    ).rejects.toThrow(/not enabled in T-046/);
    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-collect",
          intent_epoch: 1,
          snapshot_ts: 101,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.collect,
          params: { itemName: "cobblestone", radius: 8 },
        }),
      ),
    ).resolves.toMatchObject({
      result: {
        skill: "collect",
        item_name: "cobblestone",
        radius: 8,
      },
    });
    await expect(
      actor.executeSkill(
        createSkillCallJob({
          message_id: "msg-equip",
          intent_epoch: 1,
          snapshot_ts: 102,
          priority: ExecPriority.Normal,
          skill: SKILL_DIRECTORY.equip,
          params: { itemName: "stone_pickaxe", destination: "hand" },
        }),
      ),
    ).rejects.toThrow(/not enabled in T-046/);

    expect(executed).toEqual(["collect:cobblestone:8"]);
    expect(actor.getSnapshot().skill_executions).toEqual([
      {
        message_id: "msg-collect",
        skill: "collect",
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

  it("应在 EXECUTING（执行中） 状态中断原任务并执行 fight（战斗） 反射", async () => {
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
    const execution = actor.executeSkill(
      createSkillCallJob({
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
  it("应通过 BotActor（机器人执行代理） 单写者执行 sandbox_code（沙箱代码） 聊天动作", async () => {
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
    const outcome = await actor.executeSandboxCode(
      createSandboxCodeJob({
        message_id: "msg-sandbox-chat",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_001_000,
        priority: ExecPriority.Normal,
        code: "await api.chat.say('sandbox hello')",
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
    expect(outcome.snapshot.sandbox_executions).toEqual([
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

  it("应让 sandbox_code（沙箱代码） 的 bot.goTo（前往坐标） 复用真实技能执行边界", async () => {
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
    const outcome = await actor.executeSandboxCode(
      createSandboxCodeJob({
        message_id: "msg-sandbox-goto",
        intent_epoch: 1,
        snapshot_ts: 1_712_930_002_000,
        priority: ExecPriority.Normal,
        code: "await api.bot.goTo(1, 64, 1)",
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

  it("应在 world_ready（世界交互就绪） 未打开时拒绝 sandbox_code（沙箱代码） 且不写聊天", async () => {
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
      actor.executeSandboxCode(
        createSandboxCodeJob({
          message_id: "msg-sandbox-not-ready",
          intent_epoch: 1,
          snapshot_ts: 1_712_930_003_000,
          priority: ExecPriority.Normal,
          code: "await api.chat.say('should not write')",
        }),
      ),
    ).rejects.toThrow(/world interaction is not ready/);
    expect(written).toEqual([]);
  });
});
