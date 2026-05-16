import { EventEmitter } from "node:events";
import type { Vec3 } from "vec3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mineflayer-pathfinder", () => ({
  pathfinder: Symbol("mock-pathfinder-plugin"),
  Movements: class MockMovements {
    canDig = false;
    digCost = 1;
    placeCost = 1;
    allow1by1towers = true;
  },
  goals: {
    GoalBlock: class MockGoalBlock {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly z: number,
      ) {}
    },
    GoalNear: class MockGoalNear {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly z: number,
        readonly range: number,
      ) {}
    },
    GoalNearXZ: class MockGoalNearXZ {
      constructor(
        readonly x: number,
        readonly z: number,
        readonly range: number,
      ) {}
    },
  },
}));

import {
  BotStatus,
  NOOP_SKILL_EXECUTION_CONTROL,
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerRuntimeTransport,
  createMineflayerTransportDescriptor,
  createObservationRuntimeCache,
} from "../../../index.js";
import { executeMineflayerCraft } from "../../../runtime/transport/craft.js";
import { executeMineflayerEquip } from "../../../runtime/transport/equip.js";
import {
  blockMatchesResourceKey,
  createMineflayerToolchainEnsureFacts,
  createRuntimeResourceSemanticRoles,
  createRuntimeResourceTags,
  readRegistryBlockDropIds,
  readRegistryBlockFactByName,
  readRegistryItemName,
  registryCanResolveResourceKey,
} from "../../../runtime/transport/facts/index.js";
// mining 内部白盒测试：这些 import 只用于锁定 planner/executor/facts 的内部行为,不是在线公共 API。
import { executeMineRouteAction } from "../../../runtime/transport/mining/executor.js";
import { createMineBlockFactReader } from "../../../runtime/transport/mining/facts.js";
import { planMineRoute } from "../../../runtime/transport/mining/planner.js";
import { executeMineflayerPlaceCraftingTable } from "../../../runtime/transport/placement.js";
import {
  createProgressWatchdog,
  waitForPromiseOrCondition,
} from "../../../runtime/transport/progress-watchdog.js";
// terrain 内部白盒测试：这些 import 只用于锁定 router/action/memory 的内部行为,不是在线公共 API。
import {
  executeTerrainRouteAction,
  isTerrainBotAtFoot,
} from "../../../runtime/transport/terrain/action-executor.js";
import { stepToFoot } from "../../../runtime/transport/terrain/foot-step.js";
import { planTerrainRoute } from "../../../runtime/transport/terrain/router.js";
import {
  clearSelfPlacedTerrainMemoryForTests,
  recordSelfPlacedTerrainBlock,
} from "../../../runtime/transport/terrain/self-placed-memory.js";
import type {
  CraftingTablePlacementCache,
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerControlState,
  MineflayerEntityHandle,
  MineflayerItemHandle,
  MineflayerRecipeHandle,
} from "../../../runtime/transport/test-only.js";
import { readMineflayerBlockAt } from "../../../runtime/transport/world/index.js";

import {
  DriftAfterDigDropMineflayerBot,
  DriftAfterDropMineflayerBot,
  DriftAfterPlaceUpMineflayerBot,
  FakeMineflayerBot,
  FirstCenterPulseOvershootMineflayerBot,
  HorizontalOnlyMineflayerBot,
  NonMovingMineflayerBot,
  asGoalPosition,
  fakePathfinderModule,
  formatPositionKey,
  isOppositeRouteDirection,
  populateFlatMiningFixture,
  populateFlatWalkway,
  populateMiningBox,
  readFakeBlockDrops,
  readFakeDroppedItem,
  setFakeBlock,
  setFakeBlockWithDiggable,
} from "./mineflayer.fixture.js";

describe("runtime/transport terrain action 与 local movement 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("terrain-action digDropSelfPlaced 应挖掉自放置脚手架并直下落地", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 64, z: 0 });
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toEqual(["dirt"]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_dig_verified:dirt:0,64,0");
  });

  it("terrain-action drop1 下落后若横向漂移，应按 Y 到达先停止再纠偏", async () => {
    const bot = new DriftAfterDropMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "drop1",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(isTerrainBotAtFoot(bot, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(diagnostics).toContain(
      "terrain_drop_recover_foot:drop1:target=0,64,0;current=2.20,64.00,1.85",
    );
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_move_reached:drop1_drop_recover:target=0,64,0;"),
      ),
    ).toBe(true);
  });

  it("terrain-action digDropSelfPlaced 下落后若漂到边缘，应纠偏并继续后续自放置脚手架", async () => {
    const bot = new DriftAfterDigDropMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    setFakeBlock(bot, { x: 0, y: 62, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 64, z: 0 });
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 63, z: 0 });
    const diagnostics: string[] = [];

    for (const action of [
      {
        kind: "digDropSelfPlaced" as const,
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north" as const,
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      {
        kind: "digDropSelfPlaced" as const,
        toFoot: { x: 0, y: 63, z: 0 },
        dir: "north" as const,
        digs: [{ x: 0, y: 63, z: 0 }],
      },
    ]) {
      await executeTerrainRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action,
        diagnostics,
        control: NOOP_SKILL_EXECUTION_CONTROL,
      });
    }

    expect(bot.digCalls.map((block) => block.position?.y)).toEqual([64, 63]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 63, z: 0 })).toBe(true);
    expect(diagnostics).toContain(
      "terrain_drop_recover_foot:digDropSelfPlaced:target=0,64,0;current=0.50,64.00,-0.20",
    );
    expect(diagnostics).toContain("terrain_dig_verified:dirt:0,63,0");
  });

  it("terrain-action placeUp1 应在单动作内跨轮重试直到成功", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 4);
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(5);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_place_up_round_start:round=3/3");
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_place_up_attempt:round=3;delay=320;status=success"),
      ),
    ).toBe(true);
  });

  it("terrain-action placeUp1 居中脉冲离开 foot 后应回退再垫高", async () => {
    const bot = new FirstCenterPulseOvershootMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.85 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(
      diagnostics.some((entry) => entry.startsWith("terrain_center_recover_foot:placeUp1")),
    ).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("terrain_place_up_centered"))).toBe(true);
  });

  it("terrain-action placeUp1 垫高后若横向漂出 foot，应按 Y 到达先停止再纠偏", async () => {
    const bot = new DriftAfterPlaceUpMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_place_up_y_reached:placeUp1:target=0,65,0"),
      ),
    ).toBe(true);
    expect(diagnostics).toContain(
      "terrain_place_up_recover_foot:placeUp1:target=0,65,0;current=0.50,65.00,-0.04",
    );
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_move_reached:placeUp1_place_up_recover:target=0,65,0"),
      ),
    ).toBe(true);
  });

  it("terrain-action placeUp1 应在目标格有非替换薄方块时先清理再垫高", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "torch",
      type: 171,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [Object.freeze({})],
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toContain("torch");
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(diagnostics).toContain("terrain_place_target_clear_start:torch:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_done:torch:0,64,0");
  });

  it("terrain-action placeUp1 应允许无碰撞可替换植物由服务端直接覆盖", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "short_grass",
      type: 172,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [],
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls).toEqual([]);
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(diagnostics).toContain("terrain_place_target_replaceable:short_grass:0,64,0");
  });

  it("terrain-action placeUp1 应在可通行薄方块拒绝直接覆盖后清理再垫高", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "pink_petals",
      type: 173,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [],
      boundingBox: "empty",
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 1);
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader({
        ...bot.registry,
        blocksByName: {
          ...bot.registry.blocksByName,
          pink_petals: {
            id: 173,
            name: "pink_petals",
            boundingBox: "empty",
            diggable: true,
            material: "plant",
            hardness: 0,
          },
        },
      }),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toContain("pink_petals");
    expect(bot.placeBlockCalls).toHaveLength(2);
    expect(bot.unequipCalls).toEqual(["hand"]);
    expect(bot.equipCalls.map((call) => call.item.name)).toEqual(["dirt", "dirt"]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_place_target_replaceable:pink_petals:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_start:pink_petals:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_done:pink_petals:0,64,0");
  });

  it("terrain-action placeUp1 应在三轮 delay 队列全失败后返回结构化动作失败", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 6);
    const diagnostics: string[] = [];

    await expect(
      executeTerrainRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action: {
          kind: "placeUp1",
          toFoot: { x: 0, y: 65, z: 0 },
          dir: "north",
          placeAt: { x: 0, y: 64, z: 0 },
          support: { x: 0, y: 63, z: 0 },
          digs: [],
        },
        diagnostics,
        control: NOOP_SKILL_EXECUTION_CONTROL,
      }),
    ).rejects.toThrow("terrain_place_up_failed:target blocked");

    expect(bot.placeBlockCalls).toHaveLength(6);
    expect(diagnostics).toContain("terrain_place_up_round_failed:round=3/3");
  });

  it("terrain-action foot 判定应以离散脚下格为准，不被跳跃余波 raw y 误杀", () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: -17.04,
      y: 112.753,
      z: -209.53,
    };

    expect(isTerrainBotAtFoot(bot, { x: -18, y: 112, z: -210 })).toBe(true);
    expect(isTerrainBotAtFoot(bot, { x: -18, y: 112, z: -209 })).toBe(false);
  });

  it("progress watchdog 应在有真实进展时刷新 idle 计时", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let progress = { x: 0 };
      const watchdog = createProgressWatchdog({
        idleTimeoutMs: 15_000,
        readProgress: () => progress,
        isProgressAdvanced: (previous, current) => current.x !== previous.x,
        describeProgress: (value) => `x=${value.x}`,
        createTimeoutMessage: ({ idleMs }) => `stuck:${idleMs}`,
      });

      vi.setSystemTime(14_000);
      watchdog.assertAlive();
      progress = { x: 1 };
      watchdog.assertAlive();
      vi.setSystemTime(28_000);
      watchdog.assertAlive();
      vi.setSystemTime(30_100);
      expect(() => watchdog.assertAlive()).toThrow("stuck:16100");
    } finally {
      vi.useRealTimers();
    }
  });

  it("progress watchdog 等待 dig/place 原语时应优先响应取消信号", async () => {
    const neverSettled = new Promise<void>(() => {});
    let conditionChecks = 0;

    await expect(
      waitForPromiseOrCondition({
        promise: neverSettled,
        condition: () => {
          conditionChecks += 1;
          return false;
        },
        idleTimeoutMs: 15_000,
        pollMs: 50,
        timeoutMessage: () => "should_not_timeout",
        throwIfAborted: () => {
          throw new Error("skill_aborted");
        },
      }),
    ).rejects.toThrow("skill_aborted");
    expect(conditionChecks).toBe(0);
  });

  it("foot-step 移动卡死时应松开控制键并带当前位置诊断", async () => {
    const bot = new NonMovingMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const diagnostics: string[] = [];

    await expect(
      stepToFoot({
        bot,
        target: { x: 2, y: 64, z: 0 },
        jump: false,
        timeoutMs: 120,
        lookTimeoutMs: 50,
        diagnosticPrefix: "mine",
        actionKind: "walk",
        diagnostics,
      }),
    ).rejects.toThrow(/mine_step_stuck_timeout:2,64,0:current=0\.50,64\.00,0\.50;idle_ms=/u);

    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: false });
    expect(bot.clearedControlStates).toBeGreaterThan(0);
    expect(diagnostics[0]).toBe(
      "mine_move_start:walk:target=2,64,0;from=0.50,64.00,0.50;jump=false",
    );
  });

  it("foot-step 水平到中心但 Y 未到目标 foot 时不得提前停止移动", async () => {
    const bot = new HorizontalOnlyMineflayerBot();
    bot.entity.position = {
      x: -30.5,
      y: 112,
      z: -235.7,
    };

    await expect(
      stepToFoot({
        bot,
        target: { x: -31, y: 111, z: -236 },
        jump: true,
        timeoutMs: 180,
        lookTimeoutMs: 50,
        diagnosticPrefix: "mine",
        actionKind: "digStepDown",
      }),
    ).rejects.toThrow(
      /mine_step_stuck_timeout:-31,111,-236:current=-30\.50,112\.00,-235\.50;idle_ms=.*best_horizontal=0\.00;target_y=111;current_y=112;y_matched=false/u,
    );

    const forwardStarts = bot.controlStateCalls.filter(
      (call) => call.control === "forward" && call.state,
    );
    expect(forwardStarts).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "jump", state: true });
    expect(bot.controlStateCalls).toContainEqual({ control: "jump", state: false });
  });

  it("mine-action digStepDown 应挖开后下落进坑而不是持续跳跃", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "digStepDown",
        toFoot: { x: 1, y: 63, z: 0 },
        dir: "east",
        digs: [],
      },
      diagnostics: [],
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.controlStateCalls).not.toContainEqual({ control: "jump", state: true });
    expect(bot.entity.position).toMatchObject({ x: 1.5, y: 63, z: 0.5 });
  });

  it("mine-action 自然小位移应优先使用局部 pathfinder", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const diagnostics: string[] = [];

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "walk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
      pathfinder: bot.pathfinder,
      pathfinderModule: fakePathfinderModule,
    });

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.entity.position).toMatchObject({ x: 1.5, y: 64, z: 0.5 });
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("mine_local_pathfinder_reached:walk:target=1,64,0;"),
      ),
    ).toBe(true);
  });

  it("mine-action 局部 pathfinder 失败时应回退到自研按键原语", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    bot.onGoto = () => {
      throw new Error("no_path");
    };
    const diagnostics: string[] = [];

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "walk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
      pathfinder: bot.pathfinder,
      pathfinderModule: fakePathfinderModule,
    });

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(
      diagnostics.some((entry) => entry.includes("mine_local_pathfinder_failed:walk:no_path")),
    ).toBe(true);
  });

  it("mine-action 局部 pathfinder 期间取消应向上传播且不得回退移动", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const abortController = new AbortController();
    const abortError = Object.assign(new Error("cancelled by test"), {
      name: "AbortError",
    });
    const control = {
      signal: abortController.signal,
      throwIfAborted(): void {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
      },
    };
    bot.onGoto = () => {
      abortController.abort(abortError);
      return new Promise<void>(() => {});
    };
    const diagnostics: string[] = [];

    await expect(
      executeMineRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action: {
          kind: "walk",
          toFoot: { x: 1, y: 64, z: 0 },
          dir: "east",
        },
        diagnostics,
        control,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
      }),
    ).rejects.toBe(abortError);

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toEqual([]);
    expect(diagnostics.some((entry) => entry.includes("mine_local_pathfinder_failed:walk"))).toBe(
      false,
    );
  });
});
