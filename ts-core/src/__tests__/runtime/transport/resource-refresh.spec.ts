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

describe("runtime/transport resource refresh 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("应从 transport（传输层） 采样 planner（规划器） 所需 observation（观测）输入", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-observation-sampling",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 10, y: 64, z: -2 };
          bot.inventoryItems.push({ name: "oak_log", count: 3 });
          bot.resourceBlocks.push({
            name: "sample_floor",
            position: { x: 10, y: 63, z: -2 },
          });
          Object.assign(bot, {
            health: 18,
            food: 17,
            heldItem: { name: "stone_pickaxe", count: 1 },
            players: {
              Steve: {
                entity: {
                  id: "owner",
                  name: "player",
                  username: "Steve",
                  position: { x: 13, y: 64, z: -2 },
                },
              },
            },
            time: {
              isDay: true,
              timeOfDay: 6000,
            },
          });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    const observation = transport.readObservationInput("Steve");

    expect(observation).toMatchObject({
      bot: {
        position: { x: 10, y: 64, z: -2 },
        world_key: "multiworld:resource",
        health: 18,
        food: 17,
      },
      owner: {
        name: "Steve",
        online: true,
        position: { x: 13, y: 64, z: -2 },
      },
      time: {
        phase: "day",
        time_of_day: 6000,
      },
    });
    expect(observation?.inventory.items).toEqual([{ slot: 0, item_name: "oak_log", count: 3 }]);
    expect(observation?.equipment.main_hand?.item_name).toBe("stone_pickaxe");
    expect(observation?.nearby_blocks[0]?.block_name).toBe("sample_floor");

    await transport.disconnect("test shutdown");
  });

  it("资源刷新应把 tree（树木类） 公共键解析到 logs（原木） tag（标签）事实且不把当前挖掘距离混入可挖事实", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-resource-tags",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          Object.assign(bot.registry, {
            blockTags: {
              logs: [7],
            },
          });
          bot.resourceBlocks.push({
            name: "sample_runtime_block",
            type: 7,
            position: { x: 8, y: 64, z: 0 },
            tags: ["logs"],
            diggable: true,
          });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      status: "found",
      resource_key: "tree",
      blocks: [
        {
          block_name: "sample_runtime_block",
          resource_keys: ["tree"],
          resource_tags: ["logs"],
          semantic_roles: ["cut_tree_log"],
          is_diggable: true,
          is_reachable: true,
          target_diagnostics: [],
        },
      ],
    });

    await transport.disconnect("test shutdown");
  });

  it("资源刷新不应把 canSeeBlock（视线可见性） 当成 tree（树木） 可达硬门禁", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-resource-line-of-sight",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          Object.assign(bot.registry, {
            blockTags: {
              logs: [7],
            },
          });
          bot.resourceBlocks.push({
            name: "blocked_log",
            type: 7,
            position: { x: 8, y: 64, z: 0 },
            tags: ["logs"],
            diggable: true,
          });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      status: "found",
      resource_key: "tree",
      blocks: [
        {
          block_name: "blocked_log",
          semantic_roles: ["cut_tree_log"],
          is_diggable: true,
          is_reachable: true,
          target_diagnostics: ["line_of_sight_blocked", "reachability_deferred_to_skill"],
        },
      ],
    });

    await transport.disconnect("test shutdown");
  });

  it("资源刷新应在 registry（注册表） 缺少 blockTags（方块标签） 时用 minecraft-data（Minecraft 数据库） 方块事实识别可砍原木", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-resource-facts",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          Object.assign(bot.registry, {
            blocksByName: {
              oak_log: {
                id: 7,
                name: "oak_log",
                diggable: true,
                material: "mineable/axe",
                states: [{ name: "axis" }],
              },
            },
          });
          bot.resourceBlocks.push({
            name: "oak_log",
            type: 7,
            position: { x: 2, y: 64, z: 0 },
          });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      status: "found",
      resource_key: "tree",
      blocks: [
        {
          block_name: "oak_log",
          resource_keys: ["tree"],
          semantic_roles: ["cut_tree_log"],
          is_diggable: true,
          is_reachable: true,
          target_diagnostics: [],
        },
      ],
    });

    await transport.disconnect("test shutdown");
  });

  it("资源刷新不应把 Bot 自己放置的临时原木纳入 tree 资源簇快照", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-resource-self-placed-log",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          Object.assign(bot.registry, {
            blockTags: {
              logs: [7],
            },
          });
          bot.resourceBlocks.push(
            {
              name: "cherry_log",
              type: 7,
              position: { x: 1, y: 64, z: 0 },
              tags: ["logs"],
              diggable: true,
            },
            {
              name: "oak_log",
              type: 7,
              position: { x: 3, y: 64, z: 0 },
              tags: ["logs"],
              diggable: true,
            },
          );
          recordSelfPlacedTerrainBlock(bot, { x: 1, y: 64, z: 0 });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      status: "found",
      resource_key: "tree",
      blocks: [
        {
          block_name: "oak_log",
          semantic_roles: ["cut_tree_log"],
        },
      ],
    });

    await transport.disconnect("test shutdown");
  });
});
