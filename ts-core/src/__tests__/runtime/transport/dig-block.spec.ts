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

describe("runtime/transport digBlockAt 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("digBlockAt（按坐标挖掘） 应移动到推荐坐标并只挖该目标方块", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-dig-block-at",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          populateFlatWalkway(bot, { minX: 0, maxX: 8, y: 64 });
          bot.resourceBlocks.push(
            {
              name: "oak_log",
              type: 7,
              position: { x: 8, y: 64, z: 0 },
              diggable: true,
            },
            {
              name: "oak_log",
              type: 7,
              position: { x: 9, y: 64, z: 0 },
              diggable: true,
            },
          );
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await transport.digBlockAt({ x: 8, y: 64, z: 0 });

    expect(
      createdBots[0]?.resourceBlocks
        .filter((block) => block.name === "oak_log")
        .map((block) => block.position),
    ).toEqual([{ x: 9, y: 64, z: 0 }]);
    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);

    await transport.disconnect("test shutdown");
  });

  it("digBlockAt（按坐标挖掘） 对手边目标应不寻路直接挖掘", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-dig-block-near-level-direct",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          populateFlatWalkway(bot, { minX: 0, maxX: 2, y: 64 });
          bot.resourceBlocks.push({
            name: "oak_log",
            type: 7,
            position: { x: 1, y: 66, z: 0 },
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

    await transport.digBlockAt({ x: 1, y: 66, z: 0 });

    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 0, y: 64, z: 0 });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "oak_log")).toBe(false);

    await transport.disconnect("test shutdown");
  });

  it("digBlockAt（按坐标挖掘） 对远处目标应高成本靠近到树根两格内", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-dig-block-near-level-approach",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          populateFlatWalkway(bot, { minX: 0, maxX: 8, y: 64 });
          bot.resourceBlocks.push({
            name: "oak_log",
            type: 7,
            position: { x: 8, y: 66, z: 0 },
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

    await transport.digBlockAt({ x: 8, y: 66, z: 0 });

    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 6.5, y: 64, z: 0.5 });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "oak_log")).toBe(false);

    await transport.disconnect("test shutdown");
  });

  it("digBlockAt（按坐标挖掘） 靠近树根时允许站在相邻高度的可挖位置", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-dig-block-near-y-tolerant",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 65, z: 0 };
          populateFlatWalkway(bot, { minX: 0, maxX: 6, y: 65 });
          bot.resourceBlocks.push({
            name: "oak_log",
            type: 7,
            position: { x: 8, y: 64, z: 0 },
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

    await transport.digBlockAt({ x: 8, y: 64, z: 0 });

    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 6.5, y: 65, z: 0.5 });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "oak_log")).toBe(false);

    await transport.disconnect("test shutdown");
  });

  it("digBlockAt（按坐标挖掘） 不得因出发高度高于树根而启用一格塔", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-dig-block-downhill-tree",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 70, z: 0 };
          for (let step = 0; step <= 6; step += 1) {
            populateFlatWalkway(bot, { minX: step, maxX: step, y: 70 - step });
          }
          populateFlatWalkway(bot, { minX: 6, maxX: 8, y: 64 });
          bot.resourceBlocks.push({
            name: "oak_log",
            type: 7,
            position: { x: 8, y: 64, z: 0 },
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

    await transport.digBlockAt({ x: 8, y: 64, z: 0 });

    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 6.5, y: 64, z: 0.5 });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "oak_log")).toBe(false);

    await transport.disconnect("test shutdown");
  });
});
