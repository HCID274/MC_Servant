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

describe("runtime/transport terrain router 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("terrain-router 平移应允许 2 格高通道，不要求目标 top 为空", () => {
    const bot = new FakeMineflayerBot();
    for (const x of [0, 1]) {
      setFakeBlock(bot, { x, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 64, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 65, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 66, z: 0 }, "dirt");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 64, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
    });

    expect(result.plan?.actions).toEqual([
      { kind: "walk", toFoot: { x: 1, y: 64, z: 0 }, dir: "east" },
    ]);
  });

  it("terrain-router digWalk 只清 foot/head，不应因为 top 被挡而拒绝 2 格高平洞", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "digWalk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
        digs: [{ x: 1, y: 65, z: 0 }],
      },
    ]);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase2_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 同水平被障碍封住时应优先规划水平挖穿，不应耗尽 expanded 预算", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 4; x += 1) {
      setFakeBlock(bot, { x, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 66, z: 0 }, "dirt");
    }
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 4, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 4, y: 65, z: 0 }, "air");
    for (const x of [1, 2, 3]) {
      setFakeBlock(bot, { x, y: 64, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 65, z: 0 }, "dirt");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 4, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.expandedStates).toBeLessThan(80);
    expect(result.plan?.actions.filter((action) => action.kind === "digWalk")).toHaveLength(3);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase4_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 短距离可绕行时不应为了直线距离挖穿障碍", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 63,
      maxY: 63,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 64,
      maxY: 65,
      minZ: 0,
      maxZ: 1,
      blockName: "air",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 66,
      maxY: 66,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 3, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions).toHaveLength(5);
    expect(result.plan?.actions.every((action) => action.kind === "walk")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 应按预算剪掉连续不接近目标的分支并输出诊断", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 63,
      maxY: 63,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 64,
      maxY: 65,
      minZ: 0,
      maxZ: 1,
      blockName: "air",
    });
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 3, y: 64, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
      routeBudget: {
        noProgressStepLimit: 0,
      },
    });

    expect(result.plan).toBeNull();
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_pruned_no_progress"))).toBe(
      true,
    );
  });

  it("terrain-router 自然阶段应允许 5 格以内连续下落且不挖不垫", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 5; x += 1) {
      const footY = 64 - x;
      setFakeBlock(bot, { x, y: footY - 1, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: footY, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 1, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 2, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 5, y: 59, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toHaveLength(5);
    expect(result.plan?.actions.every((action) => action.kind === "drop1")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 超过 5 格连续下落时应离开自然阶段再求解", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 6; x += 1) {
      const footY = 64 - x;
      setFakeBlock(bot, { x, y: footY - 1, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: footY, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 1, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 2, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 6, y: 58, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toHaveLength(6);
    expect(result.plan?.actions.every((action) => action.kind === "drop1")).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_no_natural_path")),
    ).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase2_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 只允许把 Bot 自己垫的脚下方块作为直下挖通路", () => {
    const createStuckOnSupportBot = () => {
      const bot = new FakeMineflayerBot();
      bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
      setFakeBlock(bot, { x: 0, y: 62, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
      setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
      return bot;
    };

    const naturalBlockBot = createStuckOnSupportBot();
    const rejected = planTerrainRoute({
      bot: naturalBlockBot,
      facts: createMineBlockFactReader(naturalBlockBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(rejected.plan).toBeNull();

    const wrongWorldBot = createStuckOnSupportBot();
    recordSelfPlacedTerrainBlock(wrongWorldBot, { x: 0, y: 64, z: 0 });
    wrongWorldBot.game.dimension = "multiworld:other";
    const rejectedCrossWorld = planTerrainRoute({
      bot: wrongWorldBot,
      facts: createMineBlockFactReader(wrongWorldBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(rejectedCrossWorld.plan).toBeNull();

    const selfPlacedBot = createStuckOnSupportBot();
    recordSelfPlacedTerrainBlock(selfPlacedBot, { x: 0, y: 64, z: 0 });
    recordSelfPlacedTerrainBlock(selfPlacedBot, { x: 0, y: 63, z: 0 });
    const solved = planTerrainRoute({
      bot: selfPlacedBot,
      facts: createMineBlockFactReader(selfPlacedBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 63, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(solved.plan?.actions).toEqual([
      {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 63, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 63, z: 0 }],
      },
    ]);
  });

  it("terrain-router digStepDown 应在当前 top 被挡时纳入 digs，并拒绝终点只有 2 格净空", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 62, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "air");

    const solved = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 63, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    expect(solved.plan?.actions[0]).toEqual({
      kind: "digStepDown",
      toFoot: { x: 1, y: 63, z: 0 },
      dir: "east",
      digs: [
        { x: 0, y: 66, z: 0 },
        { x: 1, y: 63, z: 0 },
      ],
    });

    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    const rejected = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 63, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
    });

    expect(rejected.plan).toBeNull();
  });

  it("terrain-router digStepUp 应允许清当前 top 且 digs 不重复", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    const action = result.plan?.actions[0];
    expect(action).toMatchObject({
      kind: "digStepUp",
      toFoot: { x: 1, y: 65, z: 0 },
      dir: "east",
    });
    const digKeys = "digs" in (action ?? {}) ? action.digs.map(formatPositionKey) : [];
    expect(new Set(digKeys).size).toBe(digKeys.length);
    expect(digKeys).toContain("0:66:0");
  });

  it("terrain-router placeUp1 应在 2 格高坑道内先清顶再垫高", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [{ x: 0, y: 66, z: 0 }],
      },
    ]);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase3_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 深坑 30 格纯垫高不得被 24 格 plannedSolid 旧预算剪掉", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    for (let y = 64; y <= 97; y += 1) {
      setFakeBlock(bot, { x: 0, y, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 94, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions.filter((action) => action.kind === "placeUp1")).toHaveLength(30);
  });

  it("terrain-router 应优先向目标高度收敛，避免深坑返回被水平旁支耗尽 expanded 预算", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: -12,
      maxX: 12,
      minY: 63,
      maxY: 63,
      minZ: -12,
      maxZ: 12,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: -12,
      maxX: 12,
      minY: 64,
      maxY: 76,
      minZ: -12,
      maxZ: 12,
      blockName: "air",
    });

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 74, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions.filter((action) => action.kind === "placeUp1")).toHaveLength(10);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase4_solved"))).toBe(
      true,
    );
  });

  it("terrain-router placeUp1 应让放置覆盖之前 digWalk 产生的 plannedAir", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlockWithDiggable(bot, { x: 0, y: 66, z: 0 }, "dirt", false);
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "digWalk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
        digs: [{ x: 1, y: 64, z: 0 }],
      },
      {
        kind: "placeUp1",
        toFoot: { x: 1, y: 65, z: 0 },
        dir: "east",
        placeAt: { x: 1, y: 64, z: 0 },
        support: { x: 1, y: 63, z: 0 },
        digs: [],
      },
    ]);
  });

  it("terrain-router placeUp1 应拒绝垫高后目标 foot 三格净空不足且不可挖", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    setFakeBlockWithDiggable(bot, { x: 0, y: 67, z: 0 }, "dirt", false);

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 65, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
    });

    expect(result.plan).toBeNull();
  });
});
