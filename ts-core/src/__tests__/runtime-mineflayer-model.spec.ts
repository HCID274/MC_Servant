import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("mineflayer-pathfinder", () => ({
  pathfinder: Symbol("mock-pathfinder-plugin"),
  Movements: class MockMovements {
    canDig = false;
    digCost = 1;
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
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerRuntimeTransport,
  createMineflayerTransportDescriptor,
  createObservationRuntimeCache,
  readMineflayerBlockAt,
} from "../index.js";
import type {
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerEntityHandle,
  MineflayerItemHandle,
} from "../runtime/transport.js";

class FakeMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username = "bot-mc";
  readonly _client = new EventEmitter();
  readonly chatWrites: string[] = [];
  readonly registry = {
    dimensionsByName: {
      "minecraft:overworld": {
        minY: -64,
        height: 384,
      },
      overworld: {
        minY: -64,
        height: 384,
      },
    },
    itemsByName: {
      cobblestone: {
        id: 1,
      },
    },
  };
  readonly game = {
    dimension: "multiworld:resource",
    minY: 0,
    height: 256,
  };
  readonly receivedMovements: unknown[] = [];
  readonly resetGoals: unknown[] = [];
  readonly resourceBlocks: MineflayerBlockHandle[] = [];
  readonly inventoryItems: MineflayerItemHandle[] = [];
  readonly entities: Record<string, MineflayerEntityHandle | undefined> = {};
  readonly inventory = {
    items: (): readonly MineflayerItemHandle[] => this.inventoryItems,
  };
  readonly entity: MineflayerEntityHandle = {
    id: 42,
    position: undefined,
    velocity: {
      x: 0,
      y: 0,
      z: 0,
      update(value): void {
        this.x = value.x;
        this.y = value.y;
        this.z = value.z;
      },
    },
  };
  readonly pathfinder = {
    setMovements: (movements: unknown): void => {
      this.receivedMovements.push(movements);
    },
    setGoal: (goal: unknown): void => {
      this.resetGoals.push(goal);
    },
    stop: (): void => {
      this.pathfinderStops += 1;
    },
    goto: async (goal?: unknown): Promise<void> => {
      await this.onGoto?.(goal);
    },
  };
  closed = false;
  clearedControlStates = 0;
  pathfinderStops = 0;
  onGoto?: (goal?: unknown) => void | Promise<void>;

  chat(text: string): void {
    this.chatWrites.push(text);
  }

  loadPlugin(): void {}

  clearControlStates(): void {
    this.clearedControlStates += 1;
  }

  findBlocks(input: {
    matching: (block: MineflayerBlockHandle) => boolean;
    count: number;
  }): readonly { readonly x: number; readonly y: number; readonly z: number }[] {
    return this.resourceBlocks
      .filter(input.matching)
      .map((block) => block.position)
      .filter(
        (position): position is { readonly x: number; readonly y: number; readonly z: number } =>
          position !== undefined,
      )
      .slice(0, input.count);
  }

  blockAt(position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }): MineflayerBlockHandle | null {
    return (
      this.resourceBlocks.find(
        (block) =>
          block.position?.x === position.x &&
          block.position.y === position.y &&
          block.position.z === position.z,
      ) ?? null
    );
  }

  nearestEntity(
    matcher: (entity: MineflayerEntityHandle) => boolean,
  ): MineflayerEntityHandle | null {
    const botPosition = this.entity.position;

    if (botPosition === undefined) {
      return null;
    }

    const candidates = Object.values(this.entities).filter(
      (entity): entity is MineflayerEntityHandle =>
        entity !== undefined && entity !== null && entity.position !== undefined && matcher(entity),
    );

    candidates.sort((left, right) => {
      const leftDistance =
        ((left.position?.x ?? 0) - botPosition.x) ** 2 +
        ((left.position?.y ?? 0) - botPosition.y) ** 2 +
        ((left.position?.z ?? 0) - botPosition.z) ** 2;
      const rightDistance =
        ((right.position?.x ?? 0) - botPosition.x) ** 2 +
        ((right.position?.y ?? 0) - botPosition.y) ** 2 +
        ((right.position?.z ?? 0) - botPosition.z) ** 2;

      return leftDistance - rightDistance;
    });

    return candidates[0] ?? null;
  }

  quit(): void {
    this.closed = true;
    this.emit("end");
  }
}

describe("runtime Mineflayer（Minecraft 协议客户端） 最小闭环", () => {
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

  it("应通过可注入工厂完成连接、spawn（生成） 与断开生命周期", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-mc",
        host: "mc.local",
        port: 25566,
      }),
      {
        createBot: (options) => {
          expect(options).toMatchObject({
            username: "bot-mc",
            host: "mc.local",
            port: 25566,
          });

          const bot = new FakeMineflayerBot();
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();

    expect(transport.getSnapshot().state).toBe("connecting");
    await Promise.resolve();
    createdBots[0]?.emit("spawn");

    const connected = await connectPromise;

    expect(connected.state).toBe("connected");
    expect(connected.connected).toBe(true);
    expect(connected.username).toBe("bot-mc");
    const eventSource = transport.getEventSource();
    expect(eventSource).not.toBeNull();
    expect(eventSource).not.toBe(createdBots[0]);
    expect("quit" in (eventSource ?? {})).toBe(false);

    const disconnected = await transport.disconnect("test shutdown");

    expect(disconnected.state).toBe("disconnected");
    expect(createdBots[0]?.closed).toBe(true);
    expect(transport.getEventSource()).toBeNull();
  });

  it("应允许 EasyAuth（离线服认证模组） 场景在 login（协议登录） 后进入最小聊天连接态，但 world_ready（世界就绪） 仍保持关闭直到 spawn（生成）", async () => {
    const createdBots: FakeMineflayerBot[] = [];
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-login-ready",
      }),
      {
        createBot: () => {
          const bot = new FakeMineflayerBot();
          createdBots.push(bot);

          return bot;
        },
      },
    );

    const connectPromise = transport.connect();

    await Promise.resolve();
    createdBots[0]?.emit("login");

    const connected = await connectPromise;

    expect(connected.state).toBe("connected");
    expect(connected.connected).toBe(true);
    expect(connected.world_ready).toBe(false);
    expect(transport.getEventSource()).not.toBeNull();

    createdBots[0]?.emit("spawn");
    await Promise.resolve();

    expect(transport.getSnapshot().world_ready).toBe(true);
    await transport.disconnect("test shutdown");
  });

  it("资源刷新应在 Mineflayer（Minecraft 协议客户端） 未 ready（就绪） 时返回 runtime_unavailable（运行时不可用）", async () => {
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-resource-not-ready",
      }),
      {
        createBot: () => new FakeMineflayerBot(),
      },
    );

    await expect(transport.refreshAroundBot("tree", 16)).resolves.toMatchObject({
      status: "runtime_unavailable",
      diagnostics: ["runtime_unavailable", "mineflayer_transport_not_connected"],
    });
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

  it("stopCurrentAction（停止当前动作） 应停止 pathfinder（寻路器） 并清理控制键", async () => {
    const bot = new FakeMineflayerBot();
    bot.entities.owner = {
      id: "owner",
      name: "player",
      username: "Steve",
      position: { x: 1, y: 80, z: 1 },
    };
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-stop-current-action",
        version: "1.20.4",
      }),
      {
        createBot: () => bot,
      },
    );

    const connectPromise = transport.connect();
    await Promise.resolve();
    bot.emit("spawn");
    await connectPromise;

    transport.stopCurrentAction();

    expect(bot.resetGoals).toEqual([null]);
    expect(bot.pathfinderStops).toBe(1);
    expect(bot.clearedControlStates).toBe(1);
    expect(bot.entities.owner).toBeDefined();

    await transport.disconnect("test shutdown");
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

  it("资源刷新不得把 tree（树木类） 硬编码映射到其他 tag（标签）", async () => {
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
            position: { x: 1, y: 64, z: 0 },
            tags: ["logs"],
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
      status: "unsupported_resource_key",
      blocks: [],
      diagnostics: ["unsupported_resource_key:tree"],
    });

    await transport.disconnect("test shutdown");
  });

  it("应在 spawn（生成） 前失败时回收 Bot（机器人） 与运行时监听器", async () => {
    const failedBot = new FakeMineflayerBot();
    const transport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-failed",
      }),
      {
        createBot: () => failedBot,
      },
    );

    const connectPromise = transport.connect();

    await Promise.resolve();
    failedBot.emit("error", new Error("server refused"));

    await expect(connectPromise).rejects.toThrow("server refused");
    expect(transport.getSnapshot()).toMatchObject({
      state: "failed",
      connected: false,
      last_error: "server refused",
    });
    expect(failedBot.closed).toBe(true);
    expect(transport.getEventSource()).toBeNull();
    expect(failedBot.listenerCount("login")).toBe(0);
    expect(failedBot.listenerCount("spawn")).toBe(0);
    expect(failedBot.listenerCount("end")).toBe(0);
    expect(failedBot.listenerCount("kicked")).toBe(0);
    expect(failedBot.listenerCount("error")).toBe(0);
  });

  it("collect（捡拾） 应以背包目标物品总数量增加为成功条件，即使只是同一物品栈 count（数量） 增加", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
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
    collectBot.onGoto = () => {
      const stack = collectBot.inventoryItems[0];

      if (stack !== undefined) {
        Object.assign(stack, {
          count: 5,
        });
      }
      collectBot.entities.collectible = undefined;
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
      radius: 32,
    });
    expect(collectBot.receivedMovements[0]).toMatchObject({
      canDig: false,
    });
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
    collectBot.onGoto = () => {
      collectBot.inventoryItems.push({
        name: "shield",
        count: 1,
      });
      collectBot.entities.shieldDrop = undefined;
    };

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
      center: { x: -9, y: 104, z: -12 },
    });
  });

  it("collect（捡拾） 应优先用 XZ 平面靠近掉落物", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: -9, y: 104, z: -12 };
    collectBot.entities.shieldDrop = {
      id: 11,
      name: "item",
      displayName: "Item",
      position: { x: -11, y: 104, z: -14 },
      metadata: [{ itemId: 1155, itemCount: 1 }],
    };
    const goalNames: string[] = [];
    collectBot.onGoto = (goal) => {
      goalNames.push(goal?.constructor?.name ?? "unknown");
      collectBot.inventoryItems.push({
        name: "shield",
        count: 1,
      });
      collectBot.entities.shieldDrop = undefined;
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
    expect(goalNames).toEqual(["MockGoalNearXZ"]);
  });

  it("collect（捡拾） 目标实体消失但背包数量未增加时必须显式失败", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
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
    collectBot.onGoto = () => {
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

  it("goTo（前往坐标） 应启用必要挖掘并同步 Multiworld（多世界模组） 维度高度边界", async () => {
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
        x: -16,
        y: 104,
        z: 10,
      }),
    ).resolves.toMatchObject({
      skill: "goTo",
      reached: true,
    });
    expect(goToBot.game).toMatchObject({
      dimension: "multiworld:resource",
      minY: -64,
      height: 384,
    });
    expect(goToBot.receivedMovements[0]).toMatchObject({
      canDig: true,
      digCost: 10,
    });
  });

  it("collect（捡拾） 应在 32 格未命中时自动扩到 64 格搜索", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    let gotoCalls = 0;
    collectBot.entities.collectible = {
      id: 9,
      position: { x: 40, y: 64, z: 0 },
      item: {
        name: "cobblestone",
      },
    };
    collectBot.onGoto = () => {
      gotoCalls += 1;
      collectBot.inventoryItems.push({
        name: "cobblestone",
        count: 1,
      });
      collectBot.entities.collectible = undefined;
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
    expect(gotoCalls).toBe(1);
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

  it("应只在 Mineflayer（Minecraft 协议客户端） 已连接且外部认证允许时进入 IDLE（空闲）", async () => {
    const readyBot = new FakeMineflayerBot();
    const readyTransport = createMineflayerRuntimeTransport(
      createMineflayerTransportDescriptor({
        botId: "bot-ready",
      }),
      {
        createBot: () => readyBot,
      },
    );
    const readyActor = createBotActorRuntime({
      botId: "bot-ready",
      transport: readyTransport,
      observation: createObservationRuntimeCache(),
      externalAuth: createExternalAuthState({ status: "not_required" }),
      externalAuthPlan: createExternalAuthExecutionPlan(
        createExternalAuthState({ status: "not_required" }),
      ),
    });
    const readyPromise = readyActor.start();

    await Promise.resolve();
    readyBot.emit("spawn");

    const readySnapshot = await readyPromise;

    expect(readySnapshot.status).toBe(BotStatus.IDLE);
    expect(readySnapshot.ready_gate.ready).toBe(true);
    expect(readySnapshot.emitted_events).toContain("bot.ready");

    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const pendingAuth = createExternalAuthState({
      status: "pending",
      secret,
    });
    const pendingBot = new FakeMineflayerBot();
    const pendingActor = createBotActorRuntime({
      botId: "bot-pending",
      transport: createMineflayerRuntimeTransport(
        createMineflayerTransportDescriptor({
          botId: "bot-pending",
        }),
        {
          createBot: () => pendingBot,
        },
      ),
      observation: createObservationRuntimeCache(),
      externalAuth: pendingAuth,
      externalAuthPlan: createExternalAuthExecutionPlan(pendingAuth, secret),
    });
    const pendingPromise = pendingActor.start();

    await Promise.resolve();
    pendingBot.emit("spawn");

    const pendingSnapshot = await pendingPromise;

    expect(pendingBot.chatWrites).toEqual(["/login hunter2"]);
    expect(pendingSnapshot.status).toBe(BotStatus.IDLE);
    expect(pendingSnapshot.ready_gate.ready).toBe(true);
    expect(pendingSnapshot.external_auth.status).toBe("authenticated");
    expect(pendingSnapshot.external_auth_plan.status).toBe("authenticated");
    expect(pendingSnapshot.external_auth_plan.next_action).toBeNull();
    expect(pendingSnapshot.emitted_events).toContain("bot.ready");
  });
});
