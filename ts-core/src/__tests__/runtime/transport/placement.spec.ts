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

describe("runtime/transport placement 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("place（放置） 应复用仍存在的 crafting table（工作台） 缓存", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: { x: 2, y: 64, z: 0 } };
    bot.resourceBlocks.push({
      type: 7,
      name: "crafting_table",
      position: { x: 2, y: 64, z: 0 },
    });

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toEqual([]);
    expect(bot.equipCalls).toEqual([]);
  });

  it("place（放置） 带 near（参考点） 时不应复用远处缓存工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: { x: 20, y: 64, z: 20 } };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.resourceBlocks.push(
      { type: 7, name: "crafting_table", position: { x: 20, y: 64, z: 20 } },
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("place（放置） 缺工作台物品时应返回结构化失败，不在放置层合成", async () => {
    const missingItemBot = new FakeMineflayerBot();
    missingItemBot.entity.position = { x: 0, y: 64, z: 0 };
    missingItemBot.craftRecipes.set(7, [
      {
        result: { id: 7, count: 1 },
        delta: [
          { id: 4, count: -4 },
          { id: 7, count: 1 },
        ],
        requiresTable: false,
      },
    ]);
    missingItemBot.craftRecipes.set(4, [
      {
        result: { id: 4, count: 4 },
        delta: [
          { id: 5, count: -1 },
          { id: 4, count: 4 },
        ],
        requiresTable: false,
      },
    ]);

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot: missingItemBot,
        pathfinder: missingItemBot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache: { position: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_crafting_table_item",
      },
    });
    expect(missingItemBot.craftCalls).toEqual([]);

    const noPositionBot = new FakeMineflayerBot();
    noPositionBot.entity.position = { x: 0, y: 64, z: 0 };
    noPositionBot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot: noPositionBot,
        pathfinder: noPositionBot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache: { position: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "no_placeable_position",
      },
    });
  });

  it("place（放置） 背包无工作台时不应调用 Mineflayer recipe（配方） 合成", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    const tableRecipe: MineflayerRecipeHandle = {
      result: { id: 7, count: 1 },
      delta: [
        { id: 4, count: -4 },
        { id: 7, count: 1 },
      ],
      requiresTable: false,
    };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 4, name: "birch_planks", count: 4 });
    bot.craftRecipes.set(7, [tableRecipe]);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_crafting_table_item",
      },
    });
    expect(bot.craftCalls).toEqual([]);
    expect(bot.equipCalls).toEqual([]);
    expect(cache.position).toBeNull();
  });

  it("place（放置） 背包只有 logs（原木） 时不应递归合成工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    const planksRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    const tableRecipe: MineflayerRecipeHandle = {
      result: { id: 7, count: 1 },
      delta: [
        { id: 4, count: -4 },
        { id: 7, count: 1 },
      ],
      requiresTable: false,
    };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 5, name: "birch_log", count: 1 });
    bot.craftRecipes.set(4, [planksRecipe]);
    bot.craftRecipes.set(7, [tableRecipe]);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_crafting_table_item",
      },
    });
    expect(bot.craftCalls).toEqual([]);
    expect(bot.placeBlockCalls).toHaveLength(0);
    expect(cache.position).toBeNull();
  });

  it("place（放置） 应选择附近空位、调用 Mineflayer placeBlock（放方块） 并缓存位置", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
    expect(bot.equipCalls).toEqual([
      { item: { type: 7, name: "crafting_table", count: 1 }, destination: "hand" },
    ]);
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(readMineflayerBlockAt(bot, { x: 2, y: 64, z: 0 })).toMatchObject({
      name: "crafting_table",
    });
  });

  it("place（放置） 应走到邻近站位而不是站进目标放置格", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.rejectPlaceIntoCurrentFoot = true;
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    for (let x = 1; x <= 5; x += 1) {
      bot.resourceBlocks.push(
        { type: 2, name: "grass_block", position: { x, y: 63, z: 0 } },
        { type: 0, name: "air", position: { x, y: 64, z: 0 } },
        { type: 0, name: "air", position: { x, y: 65, z: 0 } },
      );
    }

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 5, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 5, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(bot.entity.position).toMatchObject({ x: 4.5, y: 64, z: 0.5 });
    expect(cache.position).toEqual({ x: 5, y: 64, z: 0 });
  });

  it("place（放置） 应在 approach（接近）改掉主手后重新装备工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.rejectNonCraftingTablePlacement = true;
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push(
      { type: 7, name: "crafting_table", count: 1 },
      { type: 2, name: "dirt", count: 16 },
    );
    bot.onAfterStep = () => {
      bot.heldItem = { type: 2, name: "dirt", count: 1 };
      bot.onAfterStep = undefined;
    };
    for (let x = 1; x <= 5; x += 1) {
      bot.resourceBlocks.push(
        { type: 2, name: "grass_block", position: { x, y: 63, z: 0 } },
        { type: 0, name: "air", position: { x, y: 64, z: 0 } },
        { type: 0, name: "air", position: { x, y: 65, z: 0 } },
      );
    }

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 5, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 5, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(bot.equipCalls.at(-1)).toEqual({
      item: { type: 7, name: "crafting_table", count: 1 },
      destination: "hand",
    });
    expect(readMineflayerBlockAt(bot, { x: 5, y: 64, z: 0 })).toMatchObject({
      name: "crafting_table",
    });
  });

  it("place（放置） 应在 Mineflayer 放置事件超时后复查真实方块并判定成功", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockPostPlaceFailureCounts.set("2:64:0", 1);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("place（放置） 应在放置未生效时重试同一候选点", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockTransientFailureCounts.set("2:64:0", 2);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(3);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("place（放置） 应预选 3 个候选位置并在第一个被挡住时顺延", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockFailureTargets.add("2:64:0");
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
      { type: 2, name: "grass_block", position: { x: 1, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 1, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 1, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(2);
    expect(cache.position).toEqual({ x: 1, y: 64, z: 0 });
  });
});
