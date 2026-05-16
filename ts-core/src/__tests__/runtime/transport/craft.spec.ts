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

describe("runtime/transport craft 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("craft（合成） 应用 Mineflayer recipe（配方） 从现有背包合成 planks（木板） 泛化目标", async () => {
    const bot = new FakeMineflayerBot();
    const oakRecipe: MineflayerRecipeHandle = {
      result: { id: 3, count: 4 },
      delta: [
        { id: 11, count: -1 },
        { id: 3, count: 4 },
      ],
      requiresTable: false,
    };
    const birchRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    bot.inventoryItems.push({ type: 5, name: "birch_log", count: 1 });
    bot.craftRecipes.set(3, [oakRecipe]);
    bot.craftRecipes.set(4, [birchRecipe]);

    const result = await executeMineflayerCraft({
      bot,
      params: { itemName: "planks", count: 4 },
      worldKey: "minecraft:overworld",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 4,
        item_name: "birch_planks",
      },
    });
    expect(bot.craftCalls).toEqual([{ recipe: birchRecipe, count: 1, table: undefined }]);
  });

  it("craft（合成） 应区分缺材料与缺 crafting table（工作台）", async () => {
    const missingMaterialBot = new FakeMineflayerBot();
    const stonePickaxeRecipe: MineflayerRecipeHandle = {
      result: { id: 8, count: 1 },
      delta: [
        { id: 1, count: -3 },
        { id: 6, count: -2 },
        { id: 8, count: 1 },
      ],
      requiresTable: true,
    };
    missingMaterialBot.resourceBlocks.push({
      type: 7,
      name: "crafting_table",
      position: { x: 1, y: 64, z: 1 },
    });
    missingMaterialBot.inventoryItems.push({ type: 6, name: "stick", count: 2 });
    missingMaterialBot.craftRecipes.set(8, [stonePickaxeRecipe]);

    await expect(
      executeMineflayerCraft({
        bot: missingMaterialBot,
        params: { itemName: "stone_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_materials",
      },
    });

    const missingTableBot = new FakeMineflayerBot();
    missingTableBot.inventoryItems.push(
      { type: 4, name: "birch_planks", count: 3 },
      { type: 6, name: "stick", count: 2 },
    );
    missingTableBot.craftRecipes.set(2, [
      {
        result: { id: 2, count: 1 },
        delta: [
          { id: 4, count: -3 },
          { id: 6, count: -2 },
          { id: 2, count: 1 },
        ],
        requiresTable: true,
      },
    ]);

    await expect(
      executeMineflayerCraft({
        bot: missingTableBot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_crafting_table",
      },
    });
  });

  it("craft（合成） 有 crafting table（工作台） 时应调用 Mineflayer craft（合成）", async () => {
    const bot = new FakeMineflayerBot();
    const recipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 4, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const tableBlock: MineflayerBlockHandle = {
      type: 7,
      name: "crafting_table",
      position: { x: 1, y: 64, z: 1 },
    };
    bot.resourceBlocks.push(tableBlock);
    bot.inventoryItems.push(
      { type: 4, name: "birch_planks", count: 3 },
      { type: 6, name: "stick", count: 2 },
    );
    bot.craftRecipes.set(2, [recipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
        item_name: "wooden_pickaxe",
      },
    });
    expect(bot.craftCalls).toEqual([{ recipe, count: 1, table: tableBlock }]);
  });

  it("craft（合成） 应在 12 格内扫描并复用附近 crafting table（工作台）", async () => {
    const bot = new FakeMineflayerBot();
    const recipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 4, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const tableBlock: MineflayerBlockHandle = {
      type: 7,
      name: "crafting_table",
      position: { x: 11, y: 64, z: 0 },
    };
    bot.resourceBlocks.push(tableBlock);
    bot.inventoryItems.push(
      { type: 4, name: "birch_planks", count: 3 },
      { type: 6, name: "stick", count: 2 },
    );
    bot.craftRecipes.set(2, [recipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        item_name: "wooden_pickaxe",
      },
    });
    expect(bot.findBlocksRequests).toContainEqual({ count: 1, maxDistance: 12 });
    expect(bot.craftCalls).toEqual([{ recipe, count: 1, table: tableBlock }]);
  });

  it("craft（合成） 应基于 Mineflayer recipe（配方） 递归补齐中间材料", async () => {
    const bot = new FakeMineflayerBot();
    const planksRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    const stickRecipe: MineflayerRecipeHandle = {
      result: { id: 6, count: 4 },
      delta: [
        { id: 4, count: -2 },
        { id: 6, count: 4 },
      ],
      requiresTable: false,
    };
    const pickaxeRecipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 4, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const tableBlock: MineflayerBlockHandle = {
      type: 7,
      name: "crafting_table",
      position: { x: 1, y: 64, z: 1 },
    };
    bot.resourceBlocks.push(tableBlock);
    bot.inventoryItems.push({ type: 5, name: "birch_log", count: 1 });
    bot.craftRecipes.set(4, [planksRecipe]);
    bot.craftRecipes.set(6, [stickRecipe]);
    bot.craftRecipes.set(2, [pickaxeRecipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
        item_name: "wooden_pickaxe",
      },
    });
    expect(bot.craftCalls).toEqual([
      { recipe: planksRecipe, count: 1, table: undefined },
      { recipe: stickRecipe, count: 1, table: undefined },
      { recipe: pickaxeRecipe, count: 1, table: tableBlock },
    ]);
  });

  it("craft（合成） 应在某种木板不足时用 recipe（配方） 事实补齐可用木板变体", async () => {
    const bot = new FakeMineflayerBot();
    const birchPlanksRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    const oakPickaxeRecipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 3, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const birchPickaxeRecipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 4, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const tableBlock: MineflayerBlockHandle = {
      type: 7,
      name: "crafting_table",
      position: { x: 1, y: 64, z: 1 },
    };
    bot.resourceBlocks.push(tableBlock);
    bot.inventoryItems.push(
      { type: 3, name: "oak_planks", count: 2 },
      { type: 5, name: "birch_log", count: 1 },
      { type: 6, name: "stick", count: 2 },
    );
    bot.craftRecipes.set(4, [birchPlanksRecipe]);
    bot.craftRecipes.set(2, [oakPickaxeRecipe, birchPickaxeRecipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
        item_name: "wooden_pickaxe",
      },
    });
    expect(bot.craftCalls).toEqual([
      { recipe: birchPlanksRecipe, count: 1, table: undefined },
      { recipe: birchPickaxeRecipe, count: 1, table: tableBlock },
    ]);
  });

  it("craft（合成） 收到具体木板变体时应按 planks（木板） 泛化目标处理", async () => {
    const bot = new FakeMineflayerBot();
    const birchPlanksRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    bot.inventoryItems.push({ type: 5, name: "birch_log", count: 1 });
    bot.craftRecipes.set(4, [birchPlanksRecipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "oak_planks", count: 1 },
        worldKey: "minecraft:overworld",
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 4,
        item_name: "birch_planks",
      },
    });
    expect(bot.craftCalls).toEqual([{ recipe: birchPlanksRecipe, count: 1, table: undefined }]);
  });

  it("craft（合成） 应优先复用 PlacementService（放置服务） 缓存的工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: { x: 2, y: 64, z: 0 } };
    const recipe: MineflayerRecipeHandle = {
      result: { id: 2, count: 1 },
      delta: [
        { id: 4, count: -3 },
        { id: 6, count: -2 },
        { id: 2, count: 1 },
      ],
      requiresTable: true,
    };
    const tableBlock: MineflayerBlockHandle = {
      type: 7,
      name: "crafting_table",
      position: { x: 2, y: 64, z: 0 },
    };
    bot.resourceBlocks.push(tableBlock);
    bot.inventoryItems.push(
      { type: 4, name: "birch_planks", count: 3 },
      { type: 6, name: "stick", count: 2 },
    );
    bot.craftRecipes.set(2, [recipe]);

    await expect(
      executeMineflayerCraft({
        bot,
        params: { itemName: "wooden_pickaxe", count: 1 },
        worldKey: "minecraft:overworld",
        craftingTableCache: cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        item_name: "wooden_pickaxe",
      },
    });
    expect(bot.craftCalls).toEqual([{ recipe, count: 1, table: tableBlock }]);
  });
});
