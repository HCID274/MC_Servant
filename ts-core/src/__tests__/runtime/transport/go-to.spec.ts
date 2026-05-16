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

describe("runtime/transport goTo 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("goTo（前往坐标） 应走受控地形路由并同步 Multiworld（多世界模组） 维度高度边界", async () => {
    const goToBot = new FakeMineflayerBot();
    goToBot.entity.position = { x: 0, y: 64, z: 0 };
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-goto-multiworld",
      }),
      {
        createBot: () => goToBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    goToBot._client.emit("login", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:resource",
    });
    goToBot.emit("spawn");
    await connectPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      transport.goTo({
        x: 0,
        y: 64,
        z: 0,
      }),
    ).resolves.toMatchObject({
      skill: "goTo",
      world_key: "multiworld:resource",
      reached: true,
    });
    expect(goToBot.game).toMatchObject({
      dimension: "multiworld:resource",
      minY: -64,
      height: 384,
    });
    expect(goToBot.receivedMovements).toEqual([]);
    expect(goToBot.gotoCalls).toEqual([]);
  });
});
