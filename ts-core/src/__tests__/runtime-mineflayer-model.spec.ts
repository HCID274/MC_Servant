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
    goto: async (): Promise<void> => {
      await this.onGoto?.();
    },
  };
  closed = false;
  onGoto?: () => void | Promise<void>;

  chat(text: string): void {
    this.chatWrites.push(text);
  }

  loadPlugin(): void {}

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
        radius: 8,
      }),
    ).resolves.toMatchObject({
      skill: "collect",
      item_name: "cobblestone",
      radius: 8,
    });
    expect(collectBot.receivedMovements[0]).toMatchObject({
      canDig: false,
    });
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
        radius: 8,
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

  it("collect（捡拾） 只能选择 radius（搜索半径） 内的掉落物目标", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    let gotoCalls = 0;
    collectBot.entities.collectible = {
      id: 9,
      position: { x: 12, y: 64, z: 0 },
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
        radius: 8,
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
