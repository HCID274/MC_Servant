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

describe("runtime/transport collect 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("collect（捡拾） 应以背包目标物品总数量增加为成功条件，即使只是同一物品栈 count（数量） 增加", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.inventoryItems.push({
      name: "cobblestone",
      count: 4,
    });
    collectBot.entities.collectible = {
      id: 7,
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "cobblestone",
      },
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-count",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        itemName: "cobblestone",
        radius: 32,
      }),
    ).resolves.toMatchObject({
      skill: "collect",
      item_name: "cobblestone",
      world_key: "multiworld:resource",
      radius: 32,
    });
    expect(collectBot.inventoryItems.find((item) => item.name === "cobblestone")?.count).toBe(5);
    expect(collectBot.receivedMovements).toEqual([]);
    expect(collectBot.gotoCalls).toEqual([]);
  });

  it("collect（捡拾） 执行层应允许 cutTree（砍树） 使用半径 8 的小范围收集", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.entities.logDrop = {
      id: 17,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
      metadata: [{ itemCount: 3 }],
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-small-radius",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        center: { x: 0, y: 64, z: 0 },
        radius: 8,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      radius: 8,
      collected: [{ name: "oak_log", count: 3 }],
    });
  });

  it("collect（捡拾） 范围内仍有可见掉落物时不得因已捡到一部分而提前成功", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.entities.firstLogDrop = {
      id: 18,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };
    collectBot.entities.secondLogDrop = {
      id: 19,
      name: "item",
      displayName: "Item",
      position: { x: 4, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-drain-radius",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        center: { x: 0, y: 64, z: 0 },
        radius: 8,
        timeoutMs: 350,
      }),
    ).rejects.toThrow("unreachable");
    expect(collectBot.inventoryItems.find((item) => item.name === "oak_log")?.count).toBe(1);
    expect(collectBot.gotoCalls).toEqual([]);
  });

  it("collect（捡拾） 应忽略与 Bot（机器人） 高度差超过 3 格的树叶滞留掉落物", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.entities.groundLogDrop = {
      id: 20,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };
    collectBot.entities.hangingLeafDrop = {
      id: 21,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 68, z: 0 },
      item: {
        name: "oak_sapling",
      },
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-ignore-hanging-drop",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        center: { x: 0, y: 64, z: 0 },
        radius: 8,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      collected: [{ name: "oak_log", count: 1 }],
    });
    expect(collectBot.gotoCalls).toEqual([]);
  });

  it("collect（捡拾） 不得把登录后的旧背包同步误判为本次捡拾成功", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    setTimeout(() => {
      collectBot.inventoryItems.push({
        name: "shield",
        count: 1,
      });
    }, 50);

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-inventory-sync",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        radius: 32,
        timeoutMs: 300,
      }),
    ).rejects.toThrow("not_found");
  });

  it("collect（捡拾） 未显式 center（中心点） 时应使用实时 Bot（机器人） 坐标扫描", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 0, z: 0 };
    populateFlatWalkway(collectBot, { minX: -11, maxX: -9, y: 104, minZ: -14, maxZ: -12 });
    collectBot.entities.shieldDrop = {
      id: 10,
      name: "item",
      displayName: "Item",
      position: { x: -10, y: 104, z: -14 },
      metadata: [{ itemId: 1155, itemCount: 1 }],
    };
    setTimeout(() => {
      collectBot.entity.position = { x: -9, y: 104, z: -12 };
    }, 50);

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-live-center",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        radius: 32,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      collected: [{ name: "shield", count: 1 }],
      center: { x: -9.5, y: 104, z: -13.5 },
    });
  });

  it("collect（捡拾） 应优先用 XZ 平面靠近掉落物", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: -9, y: 104, z: -12 };
    populateFlatWalkway(collectBot, { minX: -11, maxX: -9, y: 104, minZ: -14, maxZ: -12 });
    collectBot.entities.shieldDrop = {
      id: 11,
      name: "item",
      displayName: "Item",
      position: { x: -11, y: 104, z: -14 },
      metadata: [{ itemId: 1155, itemCount: 1 }],
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-xz-fallback",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        radius: 32,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      collected: [{ name: "shield", count: 1 }],
    });
    expect(collectBot.gotoCalls).toEqual([]);
  });

  it("collect（捡拾） 应贴近掉落物到拾取碰撞范围内", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.entities.logDrop = {
      id: 22,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-pickup-collision-range",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        center: { x: 0, y: 64, z: 0 },
        radius: 8,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      collected: [{ name: "oak_log", count: 1 }],
    });
    expect(collectBot.gotoCalls).toEqual([]);
    expect(collectBot.entity.position).toEqual({ x: 2.5, y: 64, z: 0.5 });
  });

  it("collect（捡拾） 目标实体消失但背包数量未增加时必须显式失败", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 2, y: 64 });
    collectBot.autoPickupEnabled = false;
    collectBot.inventoryItems.push({
      name: "cobblestone",
      count: 4,
    });
    collectBot.entities.collectible = {
      id: 8,
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "cobblestone",
      },
    };
    collectBot.onAfterStep = () => {
      collectBot.entities.collectible = undefined;
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-fail",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        itemName: "cobblestone",
        radius: 32,
      }),
    ).rejects.toThrow("despawned_or_collected_by_other");
  }, 10_000);

  it("collect（捡拾） 应在 32 格未命中时自动扩到 64 格搜索", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    populateFlatWalkway(collectBot, { minX: 0, maxX: 40, y: 64 });
    collectBot.entities.collectible = {
      id: 9,
      position: { x: 40, y: 64, z: 0 },
      item: {
        name: "cobblestone",
      },
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-radius-expand",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        itemName: "cobblestone",
        radius: 32,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      radius: 64,
      collected: [{ name: "cobblestone", count: 1 }],
    });
    expect(collectBot.gotoCalls).toEqual([]);
  });

  it("collect（捡拾） 只能选择最大 radius（搜索半径） 内的掉落物目标", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    let gotoCalls = 0;
    collectBot.entities.collectible = {
      id: 9,
      position: { x: 70, y: 64, z: 0 },
      item: {
        name: "cobblestone",
      },
    };
    collectBot.onGoto = () => {
      gotoCalls += 1;
    };

    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-collect-radius",
      }),
      {
        createBot: () => collectBot,
      },
    );
    const connectPromise = transport.connect();

    await Promise.resolve();
    collectBot.emit("spawn");
    await connectPromise;

    await expect(
      transport.collect({
        itemName: "cobblestone",
        radius: 32,
        timeoutMs: 300,
      }),
    ).rejects.toThrow("not_found");
    expect(gotoCalls).toBe(0);
  });
});
