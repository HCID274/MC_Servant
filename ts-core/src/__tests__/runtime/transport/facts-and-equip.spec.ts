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

describe("runtime/transport facts 与 equip 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("WorldReader（世界读取器） 应集中封装单点方块读取", () => {
    const bot = new FakeMineflayerBot();
    const block: MineflayerBlockHandle = {
      name: "oak_log",
      position: { x: 1, y: 64, z: 2 },
    };
    bot.resourceBlocks.push(block);

    expect(readMineflayerBlockAt(bot, { x: 1, y: 64, z: 2 })).toBe(block);
    expect(readMineflayerBlockAt(bot, { x: 9, y: 64, z: 9 })).toBeNull();

    expect(
      readMineflayerBlockAt(
        {
          blockAt(position) {
            if (typeof (position as { floored?: unknown }).floored !== "function") {
              throw new Error("expected Vec3 compatible position");
            }

            return { name: "sample_floor", position };
          },
        },
        { x: 1.2, y: 64.8, z: 2.4 },
      ),
    ).toMatchObject({
      name: "sample_floor",
    });
  });

  it("MineBlockFactReader 应集中提供 air/hazard/support/diggable 判断", () => {
    const facts = createMineBlockFactReader({
      blocksByName: {
        air: { id: 1, name: "air", boundingBox: "empty" },
        hot_liquid: { id: 2, name: "hot_liquid", material: "lava" },
        bedrock: { id: 3, name: "bedrock", hardness: -1 },
        stone: { id: 4, name: "stone", diggable: true },
        pink_petals: { id: 5, name: "pink_petals", boundingBox: "empty", diggable: true },
      },
    });

    expect(facts.isLiteralAirBlock({ name: "air" })).toBe(true);
    expect(facts.isLiteralAirBlock({ name: "pink_petals" })).toBe(false);
    expect(facts.isAirBlock({ name: "air" })).toBe(true);
    expect(facts.isAirBlock({ name: "cave_air" })).toBe(true);
    expect(facts.isAirBlock({ name: "pink_petals" })).toBe(true);
    expect(facts.isHazardBlock({ name: "hot_liquid" })).toBe(true);
    expect(facts.isSupportBlock({ name: "stone", diggable: true })).toBe(true);
    expect(facts.isSupportBlock({ name: "hot_liquid" })).toBe(false);
    expect(facts.isDiggableBlock({ name: "stone", diggable: true })).toBe(true);
    expect(facts.isDiggableBlock({ name: "pink_petals", diggable: true })).toBe(true);
    expect(facts.isDiggableBlock({ name: "air", diggable: false })).toBe(false);
    expect(facts.isDiggableBlock({ name: "bedrock", diggable: true })).toBe(false);
  });

  it("transport facts 应让资源刷新与工具链 ensure 使用同一套 logs/drop/tag 事实", () => {
    const registry = {
      blocksByName: {
        oak_log: {
          id: 7,
          name: "oak_log",
          diggable: true,
          drops: [17],
          material: "mineable/axe",
          states: [{ name: "axis" }],
        },
      },
      itemsByName: {
        oak_log: { id: 17, name: "oak_log" },
      },
      items: {
        17: { id: 17, name: "oak_log" },
      },
      tags: {
        blocks: {
          logs: [7],
        },
      },
    };
    const logBlock: MineflayerBlockHandle = {
      name: "oak_log",
      type: 7,
      tags: ["logs"],
      diggable: true,
    };
    const facts = createMineflayerToolchainEnsureFacts({
      getBot: () =>
        ({
          registry,
          inventory: {
            items: () => [{ type: 17, name: "oak_log", count: 3 }],
          },
        }) as unknown as MineflayerBotHandle,
    });

    expect(blockMatchesResourceKey(registry, logBlock, "tree")).toBe(true);
    expect(registryCanResolveResourceKey(registry, "tree")).toBe(true);
    expect(createRuntimeResourceTags(registry, logBlock)).toContain("logs");
    expect(createRuntimeResourceSemanticRoles(registry, logBlock)).toEqual(["cut_tree_log"]);
    expect(
      readRegistryBlockDropIds(readRegistryBlockFactByName(registry, "oak_log") ?? {}).map(
        (dropId) => readRegistryItemName(registry, dropId),
      ),
    ).toEqual(["oak_log"]);
    expect(facts.resolveBlockDropItemNames({ blockName: "oak_log" })).toEqual(["oak_log"]);
    expect(
      facts.countInventoryItemsByTag({
        tagName: "logs",
        inventory: [{ item_name: "oak_log", count: 3 }],
      }),
    ).toBe(3);
  });

  it("transport facts 应把不同树种原木解析为同一语义材料需求", () => {
    const registry = {
      blocksByName: {
        oak_log: {
          id: 7,
          name: "oak_log",
          diggable: true,
          drops: [17],
          material: "mineable/axe",
          states: [{ name: "axis" }],
        },
        cherry_log: {
          id: 8,
          name: "cherry_log",
          diggable: true,
          drops: [18],
          material: "mineable/axe",
          states: [{ name: "axis" }],
        },
      },
      itemsByName: {
        oak_log: { id: 17, name: "oak_log" },
        cherry_log: { id: 18, name: "cherry_log" },
      },
      items: {
        17: { id: 17, name: "oak_log" },
        18: { id: 18, name: "cherry_log" },
      },
      tags: {
        blocks: {
          logs: [7, 8],
        },
      },
    };
    const facts = createMineflayerToolchainEnsureFacts({
      getBot: () =>
        ({
          registry,
          inventory: {
            items: () => [{ type: 18, name: "cherry_log", count: 1 }],
          },
        }) as unknown as MineflayerBotHandle,
    });

    const requirement = facts.resolveMaterialRequirement({
      itemName: "oak_log",
      missing: 1,
      inventory: [],
    });

    expect(requirement).toMatchObject({
      itemName: "oak_log",
      targetCount: 1,
      acceptableItems: expect.arrayContaining(["oak_log", "cherry_log"]),
      source: { action: "cutTree", itemName: "oak_log", blockName: "oak_log" },
    });
    expect(
      requirement === null
        ? null
        : facts.evaluateMaterialRequirement({
            requirement,
            inventory: [{ item_name: "cherry_log", count: 1 }],
          }),
    ).toMatchObject({
      ok: true,
      completedCount: 1,
      matchedItems: [{ item_name: "cherry_log", count: 1 }],
    });
  });

  it("equip（装备） 已手持目标工具时应返回 already_equipped（已装备） 且不重复调用 Mineflayer", async () => {
    const bot = new FakeMineflayerBot();
    bot.heldItem = { type: 8, name: "stone_pickaxe", count: 1 };

    await expect(
      executeMineflayerEquip({
        bot,
        params: { itemName: "stone_pickaxe", destination: "hand" },
        worldKey: "multiworld:resource",
      }),
    ).resolves.toEqual({
      skill: "equip",
      item_name: "stone_pickaxe",
      world_key: "multiworld:resource",
      destination: "hand",
      status: "already_equipped",
      total_steps: 0,
    });
    expect(bot.equipCalls).toEqual([]);
  });

  it("equip（装备） 应从背包把任意目标物品拿到主手", async () => {
    const bot = new FakeMineflayerBot();
    bot.inventoryItems.push({ type: 9, name: "bread", count: 1 });

    await expect(
      executeMineflayerEquip({
        bot,
        params: { itemName: "bread" },
        worldKey: "multiworld:resource",
      }),
    ).resolves.toEqual({
      skill: "equip",
      item_name: "bread",
      world_key: "multiworld:resource",
      destination: "hand",
      status: "equipped",
      total_steps: 1,
    });
    expect(bot.equipCalls).toEqual([
      { item: { type: 9, name: "bread", count: 1 }, destination: "hand" },
    ]);
    expect(bot.heldItem).toEqual({ type: 9, name: "bread", count: 1 });
  });

  it("equip（装备） 背包无目标工具时应抛出 missing_item（缺目标物品）", async () => {
    const bot = new FakeMineflayerBot();

    await expect(
      executeMineflayerEquip({
        bot,
        params: { itemName: "stone_pickaxe", destination: "hand" },
        worldKey: "multiworld:resource",
      }),
    ).rejects.toMatchObject({
      error_code: "missing_item",
      details: {
        item_name: "stone_pickaxe",
        destination: "hand",
      },
    });
    expect(bot.equipCalls).toEqual([]);
  });

  it("equip（装备） 底层 Mineflayer 失败时应抛出 runtime_equip_failed（运行时装备失败）", async () => {
    class FailingEquipBot extends FakeMineflayerBot {
      override async equip(item: MineflayerItemHandle, destination: string): Promise<void> {
        this.equipCalls.push({ item, destination });
        throw new Error("equip rejected");
      }
    }
    const bot = new FailingEquipBot();
    bot.inventoryItems.push({ type: 8, name: "stone_pickaxe", count: 1 });

    await expect(
      executeMineflayerEquip({
        bot,
        params: { itemName: "stone_pickaxe", destination: "hand" },
        worldKey: "multiworld:resource",
      }),
    ).rejects.toMatchObject({
      error_code: "runtime_equip_failed",
      details: {
        item_name: "stone_pickaxe",
        destination: "hand",
      },
    });
    expect(bot.equipCalls).toEqual([
      { item: { type: 8, name: "stone_pickaxe", count: 1 }, destination: "hand" },
    ]);
  });
});
