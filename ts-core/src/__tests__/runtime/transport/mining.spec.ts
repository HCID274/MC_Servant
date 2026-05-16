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

describe("runtime/transport mining 行为", () => {
  beforeEach(() => {
    clearSelfPlacedTerrainMemoryForTests();
  });

  it("mine-bfs 应允许 2 格高矿道，并支持只挖 head 的 digWalk", () => {
    const bot = new FakeMineflayerBot();
    for (const x of [0, 1, 2]) {
      setFakeBlock(bot, { x, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 64, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 65, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 66, z: 0 }, "dirt");
    }
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 2, y: 64, z: 0 }, "stone");

    const result = planMineRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      blockName: "stone",
      startFoot: { x: 0, y: 64, z: 0 },
      targets: [{ blockName: "stone", position: { x: 2, y: 64, z: 0 } }],
    });

    expect(result.plan?.actions[0]).toEqual({
      kind: "digWalk",
      toFoot: { x: 1, y: 64, z: 0 },
      dir: "east",
      digs: [{ x: 1, y: 65, z: 0 }],
    });
  });

  it("mine-bfs 规划下挖矿道时不得连续 180 度折返", () => {
    const bot = new FakeMineflayerBot();
    for (let x = -4; x <= 4; x += 1) {
      for (let y = 108; y <= 118; y += 1) {
        for (let z = -4; z <= 4; z += 1) {
          setFakeBlock(bot, { x, y, z }, y >= 111 ? "dirt" : "stone");
        }
      }
    }
    setFakeBlock(bot, { x: 0, y: 115, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 116, z: 0 }, "air");

    const targets = [];
    for (let x = -4; x <= 4; x += 1) {
      for (let y = 108; y <= 110; y += 1) {
        for (let z = -4; z <= 4; z += 1) {
          targets.push({ blockName: "stone", position: { x, y, z } });
        }
      }
    }

    const result = planMineRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      blockName: "stone",
      startFoot: { x: 0, y: 115, z: 0 },
      targets,
    });

    expect(result.plan).not.toBeNull();
    const verticalExcavations =
      result.plan?.actions.filter(
        (action) => action.kind === "digStepDown" || action.kind === "digStepUp",
      ) ?? [];
    expect(verticalExcavations.length).toBeGreaterThan(1);
    for (let index = 1; index < verticalExcavations.length; index += 1) {
      expect(
        isOppositeRouteDirection(
          verticalExcavations[index - 1]?.dir ?? "",
          verticalExcavations[index]?.dir ?? "",
        ),
      ).toBe(false);
    }
  });

  it("mine-bfs 深层矿物应使用目标启发和动态 plannedAir 预算规划下挖路线", () => {
    const bot = new FakeMineflayerBot();
    for (let x = -7; x <= 7; x += 1) {
      for (let y = 104; y <= 116; y += 1) {
        for (let z = -7; z <= 7; z += 1) {
          setFakeBlock(bot, { x, y, z }, "stone");
        }
      }
    }
    setFakeBlock(bot, { x: 0, y: 112, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 113, z: 0 }, "air");

    const targets = [
      { blockName: "stone", position: { x: -2, y: 106, z: 0 } },
      { blockName: "stone", position: { x: 0, y: 106, z: -2 } },
      { blockName: "stone", position: { x: 2, y: 106, z: 0 } },
    ];

    const result = planMineRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      blockName: "stone",
      startFoot: { x: 0, y: 112, z: 0 },
      targets,
    });

    expect(result.plan).not.toBeNull();
    expect(result.expandedStates).toBeLessThan(12_000);
    expect(result.diagnostics).toContain(
      "mine_bfs_budget:max_expanded=24000;max_depth=60;max_air=32;heuristic=target_aware",
    );
    expect(result.plan?.actions.some((action) => action.kind === "digStepDown")).toBe(true);
  });

  it("mine（挖掘） 应通过 mine-bfs（自研动作 BFS） 挖到附近 stone（石头） 并按背包增量返回", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-stair-bfs-stone",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          populateFlatMiningFixture(bot, {
            target: { x: 1, y: 63, z: 0 },
            targetBlockName: "stone",
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

    await expect(transport.mine({ blockName: "stone", count: 1 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      world_key: "multiworld:resource",
      collected_item_name: "cobblestone",
      collected_count: 1,
      mined_count: 1,
    });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "stone")).toBe(false);
    expect(createdBots[0]?.findBlocksCalls).toBeGreaterThan(0);
    expect(createdBots[0]?.gotoCalls).toEqual([]);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 普通资源应通过临时 findBlocks（查找方块） 扫描候选并迭代挖到目标数量", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-stair-bfs-stone-count",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          for (let x = -1; x <= 6; x += 1) {
            for (let y = 58; y <= 67; y += 1) {
              for (let z = -1; z <= 1; z += 1) {
                const isStartBody = x === 0 && y >= 64 && z === 0;
                bot.resourceBlocks.push({
                  name: isStartBody ? "air" : "stone",
                  type: isStartBody ? 20 : 22,
                  position: { x, y, z },
                  diggable: !isStartBody,
                });
              }
            }
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

    await expect(transport.mine({ blockName: "stone", count: 10 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 10,
      mined_count: 10,
    });
    expect(createdBots[0]?.findBlocksCalls).toBeGreaterThan(0);
    expect(createdBots[0]?.gotoCalls).toEqual([]);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 扫描 provider 抛错时不得伪装成无目标路径失败", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-findblocks-error",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          bot.findBlocks = () => {
            throw new Error("findBlocks backend unavailable");
          };
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.mine({ blockName: "stone", count: 1 })).rejects.toMatchObject({
      error_code: "runtime_adapter_error",
      message: "runtime_adapter_error:scan_nearby_targets:findBlocks_failed",
      details: {
        failure_stage: "scan_nearby_targets",
        provider: "findBlocks",
        block_name: "stone",
        requested_count: 1,
        reason: "findBlocks_failed",
        cause_summary: "findBlocks backend unavailable",
      },
    });

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 缺少 findBlocks provider 时不得静默返回空候选", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-findblocks-missing",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          Object.defineProperty(bot, "findBlocks", { value: undefined });
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(transport.mine({ blockName: "stone", count: 1 })).rejects.toMatchObject({
      error_code: "runtime_adapter_error",
      message: "runtime_adapter_error:scan_nearby_targets:findBlocks_unavailable",
      details: {
        failure_stage: "scan_nearby_targets",
        provider: "findBlocks",
        block_name: "stone",
        requested_count: 1,
        reason: "findBlocks_unavailable",
      },
    });

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） ore（矿石） 应只执行 ResourceService（资源服务） 传入候选，不调用 findBlocks（查找方块）重扫", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-ore-resource-target",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 64, z: 0 };
          bot.heldItem = { type: 8, name: "stone_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 8, name: "stone_pickaxe", count: 1 });
          populateFlatMiningFixture(bot, {
            target: { x: 1, y: 63, z: 0 },
            targetBlockName: "iron_ore",
          });
          bot.resourceBlocks.push({
            type: 23,
            name: "iron_ore",
            position: { x: 20, y: 63, z: 0 },
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

    await expect(
      transport.mine({
        blockName: "iron_ore",
        count: 1,
        targets: [
          {
            block_name: "iron_ore",
            position: { x: 1, y: 63, z: 0 },
          },
        ],
      }),
    ).resolves.toMatchObject({
      block_name: "iron_ore",
      world_key: "multiworld:resource",
      collected_item_name: "raw_iron",
      collected_count: 1,
      mined_count: 1,
    });
    expect(createdBots[0]?.findBlocksCalls).toBe(0);
    expect(createdBots[0]?.digCalls.some((block) => block.position?.x === 20)).toBe(false);
    const targetDig = createdBots[0]?.digPositions.find(
      (entry) => entry.block?.x === 1 && entry.block.y === 63 && entry.block.z === 0,
    );
    expect(targetDig?.bot).not.toEqual({ x: 1, y: 63, z: 0 });
    expect(
      Math.hypot(
        (targetDig?.bot?.x ?? 99) - 1.5,
        (targetDig?.bot?.y ?? 99) + 1.65 - 63.5,
        (targetDig?.bot?.z ?? 99) - 0.5,
      ),
    ).toBeLessThanOrEqual(5.1);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） supplied target 的 mine-bfs 无路时应借 terrain-router 接近高处目标", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-supplied-terrain-fallback",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 1.5, y: 64, z: 0.5 };
          bot.heldItem = { type: 8, name: "stone_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 8, name: "stone_pickaxe", count: 1 });
          bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 8 });
          setFakeBlockWithDiggable(bot, { x: 1, y: 63, z: 0 }, "dirt", false);
          for (let y = 64; y <= 71; y += 1) {
            setFakeBlock(bot, { x: 1, y, z: 0 }, "air");
          }
          setFakeBlock(bot, { x: 0, y: 69, z: 0 }, "iron_ore");
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    await expect(
      transport.mine({
        blockName: "iron_ore",
        count: 1,
        targets: [
          {
            block_name: "iron_ore",
            position: { x: 0, y: 69, z: 0 },
          },
        ],
      }),
    ).resolves.toMatchObject({
      block_name: "iron_ore",
      collected_item_name: "raw_iron",
      collected_count: 1,
      mined_count: 1,
    });
    expect(createdBots[0]?.findBlocksCalls).toBe(0);
    expect(createdBots[0]?.placeBlockCalls.length).toBeGreaterThan(0);
    expect(
      createdBots[0]?.digPositions.some(
        (entry) => entry.block?.x === 0 && entry.block.y === 69 && entry.block.z === 0,
      ),
    ).toBe(true);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 动态扫描目标的 mine-bfs 无路时应借 terrain-router 接近后重扫", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-dynamic-terrain-fallback",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 1.5, y: 64, z: 0.5 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 8 });
          setFakeBlockWithDiggable(bot, { x: 1, y: 63, z: 0 }, "dirt", false);
          for (let y = 64; y <= 71; y += 1) {
            setFakeBlock(bot, { x: 1, y, z: 0 }, "air");
          }
          setFakeBlock(bot, { x: 0, y: 69, z: 0 }, "stone");
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    createdBots[0]?.emit("spawn");
    await connectPromise;

    const result = await transport.mine({ blockName: "stone", count: 1 });
    expect(result).toMatchObject({
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 1,
      mined_count: 1,
    });
    expect(
      result.diagnostics.some((entry) =>
        entry.startsWith("mine_dynamic_fallback_budget:approach_feet="),
      ),
    ).toBe(true);
    expect(createdBots[0]?.findBlocksCalls).toBeGreaterThan(1);
    expect(createdBots[0]?.placeBlockCalls.length).toBeGreaterThan(0);
    expect(
      createdBots[0]?.digPositions.some(
        (entry) => entry.block?.x === 0 && entry.block.y === 69 && entry.block.z === 0,
      ),
    ).toBe(true);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 应先规划完整 dig queue（挖掘队列），穿过泥土后再挖够 stone（石头）", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-stair-bfs-full-queue",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 70, z: 0 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          for (let x = -1; x <= 14; x += 1) {
            for (let y = 58; y <= 73; y += 1) {
              for (let z = -1; z <= 1; z += 1) {
                const isStartBody = x === 0 && y >= 70 && z === 0;
                const isDirtLayer = y >= 66;
                bot.resourceBlocks.push({
                  name: isStartBody ? "air" : isDirtLayer ? "dirt" : "stone",
                  type: isStartBody ? 20 : isDirtLayer ? 21 : 22,
                  position: { x, y, z },
                  diggable: !isStartBody,
                });
              }
            }
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

    await expect(transport.mine({ blockName: "stone", count: 6 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 6,
      mined_count: 6,
    });
    expect(createdBots[0]?.findBlocksCalls).toBeGreaterThan(0);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.equipCalls.length).toBeGreaterThan(0);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 半山腰场景：bot 在 ledge 上、石头在脚下方时应能下落抵达并挖到", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-half-mountain",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 110, z: 0 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          // bot 站在一个孤立 ledge：脚下方 (0,109,0) 是 stone（支撑），
          // 旁边 z=1 方向为悬空，在 z=1 的 y=107 平面上铺一片 stone（落下后可挖）。
          for (let x = -1; x <= 1; x += 1) {
            for (let z = -1; z <= 1; z += 1) {
              setFakeBlock(bot, { x, y: 109, z }, z === 0 ? "stone" : "air");
              setFakeBlock(bot, { x, y: 110, z }, "air");
              setFakeBlock(bot, { x, y: 111, z }, "air");
              setFakeBlock(bot, { x, y: 108, z }, z === 1 ? "stone" : "air");
              setFakeBlock(bot, { x, y: 107, z }, "stone");
            }
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

    await expect(transport.mine({ blockName: "stone", count: 1 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 1,
      mined_count: 1,
    });

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 规划阶段拿不到足够目标方块时不得先挖开路方块", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-stair-bfs-no-partial-dig",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 70, z: 0 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          for (let x = -1; x <= 6; x += 1) {
            for (let y = 64; y <= 73; y += 1) {
              for (let z = -1; z <= 1; z += 1) {
                const isStartBody = x === 0 && y >= 70 && z === 0;
                bot.resourceBlocks.push({
                  name: isStartBody ? "air" : "dirt",
                  type: isStartBody ? 20 : 21,
                  position: { x, y, z },
                  diggable: !isStartBody,
                });
              }
            }
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

    await expect(transport.mine({ blockName: "stone", count: 1 })).rejects.toThrow(
      /unsafe_path:stone:(no_safe_route|no_visible_target)/,
    );
    expect(createdBots[0]?.dugAirPositions.size).toBe(0);

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 执行完整预规划队列后掉落不足应失败，不得二次重规划继续短挖", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mine-stair-bfs-no-runtime-replan",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          bot.entity.position = { x: 0, y: 70, z: 0 };
          bot.heldItem = { type: 2, name: "wooden_pickaxe", count: 1 };
          bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
          bot.suppressDigDrops = true;
          for (let x = -1; x <= 8; x += 1) {
            for (let y = 62; y <= 73; y += 1) {
              for (let z = -1; z <= 1; z += 1) {
                const isStartBody = x === 0 && y >= 70 && z === 0;
                bot.resourceBlocks.push({
                  name: isStartBody ? "air" : "stone",
                  type: isStartBody ? 20 : 22,
                  position: { x, y, z },
                  diggable: !isStartBody,
                });
              }
            }
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

    await expect(transport.mine({ blockName: "stone", count: 2 })).rejects.toThrow(
      "drop_not_obtained:cobblestone:0/2:mine route completed without enough inventory diff",
    );
    expect(
      createdBots[0]?.digCalls.filter((block) => block.name === "stone").length ?? 0,
    ).toBeGreaterThanOrEqual(2);

    await transport.disconnect("test shutdown");
  });
});
