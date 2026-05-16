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

describe("runtime/transport world compatibility 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("应在适配层修正 1.20.3+ entity_velocity（实体速度） 嵌套向量，避免 Mineflayer 写入 NaN", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-velocity-compat",
        version: "1.20.4",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.id = 77;
          bot.entity.position = { x: 0, y: 64, z: 0 };
          if (bot.entity.velocity !== undefined) {
            bot.entity.velocity.x = Number.NaN;
            bot.entity.velocity.y = Number.NaN;
            bot.entity.velocity.z = Number.NaN;
          }
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    createdBots[0]?._client.emit("entity_velocity", {
      entityId: 77,
      velocity: { x: 4000, y: 1200, z: -2400 },
    });

    expect(createdBots[0]?.entity.velocity).toMatchObject({
      x: 0.5,
      y: 0.15,
      z: -0.3,
    });

    await transport.disconnect("test shutdown");
    expect(createdBots[0]?._client.listenerCount("entity_velocity")).toBe(0);
  });

  it("应在适配层把 Multiworld（多世界） respawn（切维） 包的方块世界键对齐到 worldName（世界名）", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const observedBlockWorlds: string[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-block-world-compat",
        version: "1.20.4",
        worldDimensionMap: {
          resource: "minecraft:overworld",
        },
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          let blockPluginDimension = "minecraft:overworld";
          let blockPluginWorldName = "minecraft:overworld";

          bot._client.on("respawn", (packet: unknown) => {
            const respawn = packet as { readonly dimension?: string; readonly worldName?: string };
            if (blockPluginDimension === respawn.dimension) {
              return;
            }
            blockPluginDimension = respawn.dimension ?? blockPluginDimension;
            blockPluginWorldName = respawn.worldName ?? blockPluginWorldName;
            observedBlockWorlds.push(blockPluginWorldName);
          });

          createdBots.push(bot);
          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    const bot = createdBots[0];
    bot?.emit("spawn");
    await connectPromise;

    bot?._client.emit("respawn", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:resource",
    });

    expect(observedBlockWorlds).toEqual(["multiworld:resource"]);

    await transport.disconnect("test shutdown");
  });

  it("应在 Multiworld（多世界） overworld 类型世界解析 map_chunk（区块） 时临时提供真实维度类型", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const dimensionsDuringChunk: string[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-block-world-skylight",
        version: "1.20.4",
        worldDimensionMap: {
          cherry: "minecraft:overworld",
          resource: "minecraft:overworld",
          "minecraft:overworld": "minecraft:overworld",
          "minecraft:the_nether": "minecraft:the_nether",
          "minecraft:the_end": "minecraft:the_end",
        },
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();

          bot._client.on("map_chunk", () => {
            dimensionsDuringChunk.push(bot.game.dimension);
          });

          createdBots.push(bot);
          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    const bot = createdBots[0];
    bot?._client.emit("login", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:cherry",
    });
    if (bot !== undefined) {
      bot.game.dimension = "multiworld:cherry";
    }
    bot?.emit("spawn");
    await connectPromise;

    bot?._client.emit("map_chunk", { x: -2, z: -2 });
    await Promise.resolve();

    expect(dimensionsDuringChunk).toEqual(["overworld"]);
    expect(bot?.game.dimension).toBe("multiworld:cherry");

    await transport.disconnect("test shutdown");
  });

  it("应按真实 dimension type（维度类型）解析 Nether（下界） 与 End（末地）子世界区块", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const dimensionsDuringChunk: string[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-block-world-dimension-types",
        version: "1.20.4",
        worldDimensionMap: {
          "minecraft:the_nether": "minecraft:the_nether",
          "minecraft:the_end": "minecraft:the_end",
        },
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();

          bot._client.on("map_chunk", () => {
            dimensionsDuringChunk.push(bot.game.dimension);
          });

          createdBots.push(bot);
          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    const bot = createdBots[0];
    bot?._client.emit("login", {
      dimension: "minecraft:the_nether",
      worldName: "minecraft:the_nether",
    });
    if (bot !== undefined) {
      bot.game.dimension = "minecraft:the_nether";
    }
    bot?.emit("spawn");
    await connectPromise;

    bot?._client.emit("map_chunk", { x: 0, z: 0 });
    await Promise.resolve();
    bot?._client.emit("respawn", {
      dimension: "minecraft:the_end",
      worldName: "minecraft:the_end",
    });
    bot?._client.emit("map_chunk", { x: 0, z: 0 });
    await Promise.resolve();

    expect(dimensionsDuringChunk).toEqual(["the_nether", "the_end"]);
    expect(bot?.game.dimension).toBe("the_end");

    await transport.disconnect("test shutdown");
  });

  it("切换 world key（世界键） 后应清理旧实体与 pathfinder（寻路器） 状态", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-world-state-reset",
        version: "1.20.4",
        worldDimensionMap: {
          cherry: "minecraft:overworld",
          resource: "minecraft:overworld",
        },
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          Object.assign(bot, {
            players: {
              Steve: {
                entity: {
                  id: "owner",
                  name: "player",
                  username: "Steve",
                  position: { x: 1, y: 80, z: 1 },
                },
              },
            },
          });
          bot.entities.owner = {
            id: "owner",
            name: "player",
            username: "Steve",
            position: { x: 1, y: 80, z: 1 },
          };
          bot.entities.drop = {
            id: "drop",
            name: "item",
            position: { x: 2, y: 80, z: 1 },
          };
          createdBots.push(bot);
          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    const bot = createdBots[0];
    bot?._client.emit("login", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:cherry",
    });
    if (bot !== undefined) {
      bot.game.dimension = "multiworld:cherry";
    }
    bot?.emit("spawn");
    await connectPromise;

    bot?._client.emit("respawn", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:resource",
    });
    await Promise.resolve();

    expect(bot?.resetGoals).toEqual([null]);
    expect(bot?.pathfinderStops).toBe(1);
    expect(bot?.clearedControlStates).toBe(1);
    expect(Object.keys(bot?.entities ?? {})).toEqual(["42"]);
    expect(
      (bot as unknown as { players?: { Steve?: { entity?: unknown } } })?.players?.Steve?.entity,
    ).toBeNull();
    expect(transport.readObservationInput("Steve")?.owner).toMatchObject({
      name: "Steve",
      online: false,
    });

    await transport.disconnect("test shutdown");
  });

  it("同 world key（世界键） respawn（重生） 不应清理实体状态", async () => {
    const bot = new FakeMineflayerBot();
    bot.entities.owner = {
      id: "owner",
      name: "player",
      username: "Steve",
      position: { x: 1, y: 80, z: 1 },
    };
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-same-world-respawn",
        version: "1.20.4",
        worldDimensionMap: {
          resource: "minecraft:overworld",
        },
      }),
      {
        createBot: () => bot,
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    bot._client.emit("login", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:resource",
    });
    bot.game.dimension = "multiworld:resource";
    bot.emit("spawn");
    await connectPromise;

    bot._client.emit("respawn", {
      dimension: "minecraft:overworld",
      worldName: "multiworld:resource",
    });
    await Promise.resolve();

    expect(bot.resetGoals).toEqual([]);
    expect(bot.pathfinderStops).toBe(0);
    expect(bot.entities.owner).toBeDefined();

    await transport.disconnect("test shutdown");
  });
});
