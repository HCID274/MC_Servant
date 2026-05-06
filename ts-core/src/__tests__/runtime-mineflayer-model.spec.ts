import { EventEmitter } from "node:events";
import type { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";

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
  createBotActorRuntime,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createMineflayerRuntimeTransport,
  createMineflayerTransportDescriptor,
  createObservationRuntimeCache,
  executeMineflayerCraft,
  executeMineflayerEquip,
  executeMineflayerPlaceCraftingTable,
  readMineflayerBlockAt,
  resolveGoalBlockConstructor,
  resolveGoalNearConstructor,
  resolveGoalNearXZConstructor,
} from "../index.js";
import type {
  CraftingTablePlacementCache,
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerControlState,
  MineflayerEntityHandle,
  MineflayerItemHandle,
  MineflayerRecipeHandle,
} from "../runtime/transport.js";
import { createMineBlockFactReader } from "../runtime/transport/mine-block-facts.js";
import { planMineQueue } from "../runtime/transport/mine-queue.js";

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
      wooden_pickaxe: {
        id: 2,
        repairWith: ["oak_planks", "birch_planks"],
      },
      oak_planks: {
        id: 3,
      },
      birch_planks: {
        id: 4,
      },
      birch_log: {
        id: 5,
      },
      stick: {
        id: 6,
      },
      crafting_table: {
        id: 7,
      },
      stone_pickaxe: {
        id: 8,
      },
      bread: {
        id: 9,
      },
      raw_iron: {
        id: 10,
      },
    },
    items: {
      "1": {
        id: 1,
        name: "cobblestone",
      },
      "2": {
        id: 2,
        name: "wooden_pickaxe",
      },
      "3": {
        id: 3,
        name: "oak_planks",
      },
      "4": {
        id: 4,
        name: "birch_planks",
      },
      "5": {
        id: 5,
        name: "birch_log",
      },
      "6": {
        id: 6,
        name: "stick",
      },
      "7": {
        id: 7,
        name: "crafting_table",
      },
      "8": {
        id: 8,
        name: "stone_pickaxe",
      },
      "9": {
        id: 9,
        name: "bread",
      },
      "10": {
        id: 10,
        name: "raw_iron",
      },
    },
    blocksByName: {
      crafting_table: {
        id: 7,
      },
      air: {
        id: 20,
        name: "air",
        diggable: false,
        drops: [],
      },
      dirt: {
        id: 21,
        name: "dirt",
        diggable: false,
        drops: [],
      },
      stone: {
        id: 22,
        name: "stone",
        diggable: true,
        drops: [1],
        harvestTools: {
          "2": true,
          "8": true,
        },
      },
      iron_ore: {
        id: 23,
        name: "iron_ore",
        diggable: true,
        drops: [10],
        harvestTools: {
          "8": true,
        },
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
  readonly dugAirPositions = new Set<string>();
  readonly inventoryItems: MineflayerItemHandle[] = [];
  readonly entities: Record<string, MineflayerEntityHandle | undefined> = {};
  readonly craftRecipes = new Map<number, MineflayerRecipeHandle[]>();
  readonly craftCalls: {
    readonly recipe: MineflayerRecipeHandle;
    readonly count: number | undefined;
    readonly table: MineflayerBlockHandle | undefined;
  }[] = [];
  readonly equipCalls: { readonly item: MineflayerItemHandle; readonly destination: string }[] = [];
  readonly unequipCalls: string[] = [];
  readonly controlStateCalls: {
    readonly control: MineflayerControlState;
    readonly state: boolean;
  }[] = [];
  readonly gotoCalls: unknown[] = [];
  readonly digCalls: MineflayerBlockHandle[] = [];
  readonly digPositions: {
    readonly block: { readonly x: number; readonly y: number; readonly z: number } | undefined;
    readonly bot: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  }[] = [];
  suppressDigDrops = false;
  readonly lookAtCalls: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly force?: boolean;
  }[] = [];
  readonly placeBlockCalls: {
    readonly referenceBlock: MineflayerBlockHandle;
    readonly faceVector: { readonly x: number; readonly y: number; readonly z: number };
  }[] = [];
  readonly placeBlockFailureTargets = new Set<string>();
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
      this.gotoCalls.push(goal);
      await this.onGoto?.(goal);
      const goalPosition = asGoalPosition(goal);
      if (goalPosition !== null) {
        this.entity.position = goalPosition;
      }
    },
  };
  closed = false;
  clearedControlStates = 0;
  pathfinderStops = 0;
  findBlocksCalls = 0;
  heldItem: MineflayerItemHandle | null = null;
  onGoto?: (goal?: unknown) => void | Promise<void>;

  chat(text: string): void {
    this.chatWrites.push(text);
  }

  loadPlugin(): void {}

  clearControlStates(): void {
    this.clearedControlStates += 1;
  }

  setControlState(control: MineflayerControlState, state: boolean): void {
    this.controlStateCalls.push({ control, state });
    if (control !== "forward" || !state) {
      return;
    }

    const target = this.lookAtCalls.at(-1)?.position;
    if (target === undefined) {
      return;
    }

    this.entity.position = {
      x: Math.floor(target.x) + 0.5,
      y: Math.floor(target.y - 1),
      z: Math.floor(target.z) + 0.5,
    };
  }

  findBlocks(input: {
    matching: (block: MineflayerBlockHandle) => boolean;
    count: number;
  }): readonly { readonly x: number; readonly y: number; readonly z: number }[] {
    this.findBlocksCalls += 1;
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
    if (this.dugAirPositions.has(formatPositionKey(position))) {
      return {
        name: "air",
        type: 20,
        position,
        diggable: false,
      };
    }

    return (
      this.resourceBlocks.find(
        (block) =>
          block.position?.x === position.x &&
          block.position.y === position.y &&
          block.position.z === position.z,
      ) ?? null
    );
  }

  dig(block: MineflayerBlockHandle): void {
    this.digCalls.push(block);
    this.digPositions.push({
      block: block.position,
      bot: this.entity.position,
    });
    if (this.suppressDigDrops) {
      this.resourceBlocks.splice(
        0,
        this.resourceBlocks.length,
        ...this.resourceBlocks.filter((candidate) => candidate !== block),
      );
      if (block.position !== undefined) {
        this.dugAirPositions.add(formatPositionKey(block.position));
      }
      return;
    }
    const drops = readFakeBlockDrops(this.registry, block.name);
    for (const drop of drops) {
      const itemName = this.registry.items[String(drop)]?.name;
      if (itemName === undefined) {
        continue;
      }
      const stack = this.inventoryItems.find((item) => item.type === drop);
      if (stack === undefined) {
        this.inventoryItems.push({ type: drop, name: itemName, count: 1 });
      } else {
        this.inventoryItems.splice(this.inventoryItems.indexOf(stack), 1, {
          ...stack,
          count: (stack.count ?? 0) + 1,
        });
      }
    }
    this.resourceBlocks.splice(
      0,
      this.resourceBlocks.length,
      ...this.resourceBlocks.filter((candidate) => candidate !== block),
    );
    if (block.position !== undefined) {
      this.dugAirPositions.add(formatPositionKey(block.position));
    }
  }

  canDigBlock(block: MineflayerBlockHandle): boolean {
    const botPosition = this.entity.position;
    const blockPosition = block.position;

    if (botPosition === undefined || blockPosition === undefined || block.diggable === false) {
      return false;
    }

    return (
      Math.hypot(
        blockPosition.x - botPosition.x,
        blockPosition.y + 0.5 - (botPosition.y + 1.65),
        blockPosition.z - botPosition.z,
      ) <= 5.1
    );
  }

  canSeeBlock(block: MineflayerBlockHandle): boolean {
    return block.name !== "blocked_log";
  }

  recipesAll(
    itemType: number,
    _metadata: number | null,
    craftingTable: MineflayerBlockHandle | boolean | null,
  ): readonly MineflayerRecipeHandle[] {
    return (this.craftRecipes.get(itemType) ?? []).filter(
      (recipe) => recipe.requiresTable !== true || Boolean(craftingTable),
    );
  }

  recipesFor(
    itemType: number,
    metadata: number | null,
    minResultCount: number | null,
    craftingTable: MineflayerBlockHandle | boolean | null,
  ): readonly MineflayerRecipeHandle[] {
    return this.recipesAll(itemType, metadata, craftingTable).filter((recipe) =>
      this.hasRecipeMaterials(recipe, minResultCount ?? 1),
    );
  }

  async craft(
    recipe: MineflayerRecipeHandle,
    count?: number,
    craftingTable?: MineflayerBlockHandle,
  ): Promise<void> {
    this.craftCalls.push({ recipe, count, table: craftingTable });
    const completedCount = Math.max(1, recipe.result.count) * Math.max(1, count ?? 1);
    const existingStack = this.inventoryItems.find((item) => item.type === recipe.result.id);
    if (existingStack === undefined) {
      const itemName = this.registry.items[String(recipe.result.id)]?.name;
      this.inventoryItems.push({
        type: recipe.result.id,
        ...(itemName === undefined ? {} : { name: itemName }),
        count: completedCount,
      });
      return;
    }

    this.inventoryItems.splice(this.inventoryItems.indexOf(existingStack), 1, {
      ...existingStack,
      count: (existingStack.count ?? 0) + completedCount,
    });
  }

  async equip(item: MineflayerItemHandle, destination: string): Promise<void> {
    this.equipCalls.push({ item, destination });
    if (destination === "hand") {
      this.heldItem = item;
    }
  }

  async unequip(destination: string): Promise<void> {
    this.unequipCalls.push(destination);
    if (destination === "hand") {
      this.heldItem = null;
    }
  }

  async lookAt(position: Vec3, force?: boolean): Promise<void> {
    if (typeof position.minus !== "function") {
      throw new Error("point.minus is not a function");
    }
    this.lookAtCalls.push({ position, force });
  }

  async placeBlock(
    referenceBlock: MineflayerBlockHandle,
    faceVector: { readonly x: number; readonly y: number; readonly z: number },
  ): Promise<void> {
    this.placeBlockCalls.push({ referenceBlock, faceVector });
    const referencePosition = referenceBlock.position;

    if (referencePosition === undefined) {
      throw new Error("missing reference position");
    }

    const target = {
      x: referencePosition.x + faceVector.x,
      y: referencePosition.y + faceVector.y,
      z: referencePosition.z + faceVector.z,
    };
    if (this.placeBlockFailureTargets.has(formatPositionKey(target))) {
      throw new Error("target blocked");
    }

    this.resourceBlocks.splice(
      0,
      this.resourceBlocks.length,
      ...this.resourceBlocks.filter(
        (block) =>
          block.position === undefined ||
          block.position.x !== target.x ||
          block.position.y !== target.y ||
          block.position.z !== target.z,
      ),
      {
        name: "crafting_table",
        type: 7,
        position: target,
      },
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

  private hasRecipeMaterials(recipe: MineflayerRecipeHandle, minResultCount: number): boolean {
    const craftRuns = Math.max(1, Math.ceil(minResultCount / Math.max(1, recipe.result.count)));

    return (recipe.delta ?? [])
      .filter((delta) => delta.count < 0)
      .every((delta) => this.countInventoryByType(delta.id) >= Math.abs(delta.count) * craftRuns);
  }

  private countInventoryByType(type: number): number {
    return this.inventoryItems.reduce(
      (sum, item) => sum + (item.type === type ? (item.count ?? 0) : 0),
      0,
    );
  }
}

function readFakeBlockDrops(
  registry: FakeMineflayerBot["registry"],
  blockName: string | undefined,
): readonly number[] {
  if (blockName === undefined) {
    return [];
  }

  const fact =
    registry.blocksByName[blockName as keyof FakeMineflayerBot["registry"]["blocksByName"]];
  const drops = fact === undefined || !("drops" in fact) ? [] : fact.drops;

  return Array.isArray(drops) ? drops : [];
}

function populateFlatMiningFixture(
  bot: FakeMineflayerBot,
  input: {
    readonly target: { readonly x: number; readonly y: number; readonly z: number };
    readonly targetBlockName: "stone" | "iron_ore";
  },
): void {
  for (let x = -1; x <= 2; x += 1) {
    for (let y = 60; y <= 67; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        const isTarget = x === input.target.x && y === input.target.y && z === input.target.z;
        const isAir = y >= 64;
        bot.resourceBlocks.push({
          name: isTarget ? input.targetBlockName : isAir ? "air" : "dirt",
          type: isTarget ? (input.targetBlockName === "stone" ? 22 : 23) : isAir ? 20 : 21,
          position: { x, y, z },
          diggable: isTarget,
        });
      }
    }
  }
}

function populateMiningBox(
  bot: FakeMineflayerBot,
  input: {
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
    readonly minZ: number;
    readonly maxZ: number;
    readonly blockName: "stone" | "dirt" | "air";
  },
): void {
  for (let x = input.minX; x <= input.maxX; x += 1) {
    for (let y = input.minY; y <= input.maxY; y += 1) {
      for (let z = input.minZ; z <= input.maxZ; z += 1) {
        setFakeBlock(bot, { x, y, z }, input.blockName);
      }
    }
  }
}

function setFakeBlock(
  bot: FakeMineflayerBot,
  position: { readonly x: number; readonly y: number; readonly z: number },
  blockName: "air" | "dirt" | "stone" | "iron_ore",
): void {
  const type = bot.registry.blocksByName[blockName].id;
  const existingIndex = bot.resourceBlocks.findIndex(
    (block) =>
      block.position?.x === position.x &&
      block.position.y === position.y &&
      block.position.z === position.z,
  );
  const block: MineflayerBlockHandle = {
    name: blockName,
    type,
    position,
    diggable: blockName !== "air",
  };
  if (existingIndex < 0) {
    bot.resourceBlocks.push(block);
    return;
  }

  bot.resourceBlocks.splice(existingIndex, 1, block);
}

function formatPositionKey(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function asGoalPosition(
  goal: unknown,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  if (goal === null || typeof goal !== "object") {
    return null;
  }
  const candidate = goal as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };

  return typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.z === "number"
    ? { x: candidate.x, y: candidate.y, z: candidate.z }
    : null;
}

const fakePathfinderModule = {
  pathfinder: Symbol("mock-pathfinder-plugin"),
  Movements: class MockPlacementMovements {},
  goals: {
    GoalBlock: class MockPlacementGoalBlock {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly z: number,
      ) {}
    },
    GoalNear: class MockPlacementGoalNear {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly z: number,
        readonly range: number,
      ) {}
    },
  },
};

const fakeDefaultOnlyPathfinderModule = {
  pathfinder: fakePathfinderModule.pathfinder,
  Movements: fakePathfinderModule.Movements,
  default: {
    goals: fakePathfinderModule.goals,
  },
} as unknown as typeof fakePathfinderModule;

describe("runtime Mineflayer（Minecraft 协议客户端） 最小闭环", () => {
  it("pathfinder goals（寻路目标） 应集中兼容 direct/default/module.exports 导出形态", () => {
    expect(resolveGoalBlockConstructor(fakeDefaultOnlyPathfinderModule)).toBe(
      fakePathfinderModule.goals.GoalBlock,
    );
    expect(resolveGoalNearConstructor(fakeDefaultOnlyPathfinderModule)).toBe(
      fakePathfinderModule.goals.GoalNear,
    );
    const moduleExportsOnlyPathfinderModule = {
      pathfinder: fakePathfinderModule.pathfinder,
      Movements: fakePathfinderModule.Movements,
      "module.exports": {
        goals: fakePathfinderModule.goals,
      },
    };
    expect(resolveGoalNearConstructor(moduleExportsOnlyPathfinderModule)).toBe(
      fakePathfinderModule.goals.GoalNear,
    );
    expect(resolveGoalNearXZConstructor(moduleExportsOnlyPathfinderModule)).toBeUndefined();
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

  it("place（放置） 应复用仍存在的 crafting table（工作台） 缓存", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: { x: 2, y: 64, z: 0 } };
    bot.resourceBlocks.push({
      type: 7,
      name: "crafting_table",
      position: { x: 2, y: 64, z: 0 },
    });

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toEqual([]);
    expect(bot.equipCalls).toEqual([]);
  });

  it("place（放置） 带 near（参考点） 时不应复用远处缓存工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: { x: 20, y: 64, z: 20 } };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.resourceBlocks.push(
      { type: 7, name: "crafting_table", position: { x: 20, y: 64, z: 20 } },
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("place（放置） 应先尝试合成工作台，并暴露材料不足与附近无可放位置", async () => {
    const missingItemBot = new FakeMineflayerBot();
    missingItemBot.entity.position = { x: 0, y: 64, z: 0 };
    missingItemBot.craftRecipes.set(7, [
      {
        result: { id: 7, count: 1 },
        delta: [
          { id: 4, count: -4 },
          { id: 7, count: 1 },
        ],
        requiresTable: false,
      },
    ]);
    missingItemBot.craftRecipes.set(4, [
      {
        result: { id: 4, count: 4 },
        delta: [
          { id: 5, count: -1 },
          { id: 4, count: 4 },
        ],
        requiresTable: false,
      },
    ]);

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot: missingItemBot,
        pathfinder: missingItemBot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache: { position: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "missing_materials",
      },
    });

    const noPositionBot = new FakeMineflayerBot();
    noPositionBot.entity.position = { x: 0, y: 64, z: 0 };
    noPositionBot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot: noPositionBot,
        pathfinder: noPositionBot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table" },
        worldKey: "minecraft:overworld",
        cache: { position: null },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "no_placeable_position",
      },
    });
  });

  it("place（放置） 应在背包无工作台时先用 Mineflayer recipe（配方） 合成再放置", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    const tableRecipe: MineflayerRecipeHandle = {
      result: { id: 7, count: 1 },
      delta: [
        { id: 4, count: -4 },
        { id: 7, count: 1 },
      ],
      requiresTable: false,
    };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 4, name: "birch_planks", count: 4 });
    bot.craftRecipes.set(7, [tableRecipe]);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.craftCalls).toEqual([{ recipe: tableRecipe, count: 1, table: undefined }]);
    expect(bot.equipCalls).toEqual([
      { item: { type: 7, name: "crafting_table", count: 1 }, destination: "hand" },
    ]);
  });

  it("place（放置） 背包只有 logs（原木） 时应先按配方合成 planks（木板） 再合成工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    const planksRecipe: MineflayerRecipeHandle = {
      result: { id: 4, count: 4 },
      delta: [
        { id: 5, count: -1 },
        { id: 4, count: 4 },
      ],
      requiresTable: false,
    };
    const tableRecipe: MineflayerRecipeHandle = {
      result: { id: 7, count: 1 },
      delta: [
        { id: 4, count: -4 },
        { id: 7, count: 1 },
      ],
      requiresTable: false,
    };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 5, name: "birch_log", count: 1 });
    bot.craftRecipes.set(4, [planksRecipe]);
    bot.craftRecipes.set(7, [tableRecipe]);
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.craftCalls).toEqual([
      { recipe: planksRecipe, count: 1, table: undefined },
      { recipe: tableRecipe, count: 1, table: undefined },
    ]);
    expect(bot.placeBlockCalls).toHaveLength(1);
  });

  it("place（放置） 应选择附近空位、调用 Mineflayer placeBlock（放方块） 并缓存位置", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
    expect(bot.equipCalls).toEqual([
      { item: { type: 7, name: "crafting_table", count: 1 }, destination: "hand" },
    ]);
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(readMineflayerBlockAt(bot, { x: 2, y: 64, z: 0 })).toMatchObject({
      name: "crafting_table",
    });
  });

  it("place（放置） 应兼容真实 mineflayer-pathfinder（寻路插件） default.goals 导出形态", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakeDefaultOnlyPathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 2, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
  });

  it("place（放置） 应预选 3 个候选位置并在第一个被挡住时顺延", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockFailureTargets.add("2:64:0");
    bot.resourceBlocks.push(
      { type: 2, name: "grass_block", position: { x: 2, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 2, y: 64, z: 0 } },
      { type: 2, name: "grass_block", position: { x: 1, y: 63, z: 0 } },
      { type: 0, name: "air", position: { x: 1, y: 64, z: 0 } },
    );

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 2, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 1, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(2);
    expect(cache.position).toEqual({ x: 1, y: 64, z: 0 });
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

  it("mine（挖掘） 应通过 StairBFSPlanner（阶梯规划器） 安全短段挖到 stone（石头） 并按背包增量返回", async () => {
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
      diagnostics: ["stair_bfs_phase:no_fill"],
    });
    expect(createdBots[0]?.resourceBlocks.some((block) => block.name === "stone")).toBe(false);
    expect(createdBots[0]?.findBlocksCalls).toBe(0);
    expect(createdBots[0]?.receivedMovements).toEqual([]);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.controlStateCalls).toContainEqual({
      control: "forward",
      state: true,
    });

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 普通资源应沿 StairBFS（阶梯广度优先搜索） 路线发现候选而不是先全局 findBlocks（查找方块）", async () => {
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

    await expect(transport.mine({ blockName: "stone", count: 3 })).resolves.toMatchObject({
      skill: "mine",
      block_name: "stone",
      collected_item_name: "cobblestone",
      collected_count: 3,
      mined_count: 3,
    });
    expect(createdBots[0]?.findBlocksCalls).toBe(0);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.controlStateCalls).toContainEqual({
      control: "forward",
      state: true,
    });

    await transport.disconnect("test shutdown");
  });

  it("mine（挖掘） 队列规划应按总 walking distance（行走距离）丢弃超过 32 步的已有洞候选", () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0, y: 70, z: 0 };
    bot.inventoryItems.push({ type: 2, name: "wooden_pickaxe", count: 1 });
    populateMiningBox(bot, {
      minX: -3,
      maxX: 42,
      minY: 24,
      maxY: 73,
      minZ: -3,
      maxZ: 3,
      blockName: "stone",
    });
    setFakeBlock(bot, { x: 0, y: 70, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 71, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 72, z: 0 }, "air");
    for (let step = 1; step <= 40; step += 1) {
      const foot = { x: step, y: 70 - step, z: 0 };
      setFakeBlock(bot, foot, "air");
      setFakeBlock(bot, { x: foot.x, y: foot.y + 1, z: foot.z }, "air");
      setFakeBlock(bot, { x: foot.x, y: foot.y + 2, z: foot.z }, "air");
    }
    for (const step of [10, 20, 30]) {
      const foot = { x: step, y: 70 - step, z: 0 };
      setFakeBlock(bot, foot, "dirt");
      setFakeBlock(bot, { x: foot.x, y: foot.y + 1, z: foot.z }, "dirt");
      setFakeBlock(bot, { x: foot.x, y: foot.y + 2, z: foot.z }, "dirt");
    }

    const queue = planMineQueue({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      blockName: "stone",
      requiredTargetCount: 1,
    });

    expect(queue).not.toBeNull();
    const firstDig = queue?.actions.find((action) => action.kind === "dig");
    expect(firstDig?.pos.x).toBeLessThanOrEqual(0);
    expect(queue?.actions.some((action) => action.pos.x > 32)).toBe(false);
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
    expect(createdBots[0]?.findBlocksCalls).toBe(0);
    expect(createdBots[0]?.gotoCalls).toEqual([]);
    expect(createdBots[0]?.unequipCalls).toContain("hand");
    expect(createdBots[0]?.equipCalls.length).toBeGreaterThan(0);
    expect(
      createdBots[0]?.digCalls
        .slice(0, 3)
        .map((block) => block.position)
        .map((position) => position?.y),
    ).toEqual([71, 70, 69]);

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
      "unsafe_path:stone:no_safe_route",
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
      "drop_not_obtained:cobblestone:0/2:planned queue completed without enough inventory diff",
    );
    expect(createdBots[0]?.digCalls.filter((block) => block.name === "stone")).toHaveLength(2);

    await transport.disconnect("test shutdown");
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

    expect(createdBots[0]?.resourceBlocks.map((block) => block.position)).toEqual([
      { x: 9, y: 64, z: 0 },
    ]);
    expect(createdBots[0]?.receivedMovements).toHaveLength(1);

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
    expect(createdBots[0]?.resourceBlocks).toEqual([]);

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

    expect(createdBots[0]?.receivedMovements).toHaveLength(1);
    expect(createdBots[0]?.receivedMovements[0]).toMatchObject({
      canDig: true,
      digCost: 100,
      placeCost: 100,
      allow1by1towers: false,
    });
    expect(createdBots[0]?.gotoCalls[0]).toMatchObject({
      x: 8,
      y: 66,
      z: 0,
      range: 2,
    });
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 8, y: 66, z: 0 });
    expect(createdBots[0]?.resourceBlocks).toEqual([]);

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

    expect(createdBots[0]?.receivedMovements).toHaveLength(1);
    expect(createdBots[0]?.receivedMovements[0]).toMatchObject({
      canDig: true,
      digCost: 100,
      placeCost: 100,
      allow1by1towers: false,
    });
    expect(createdBots[0]?.gotoCalls[0]).toMatchObject({
      x: 8,
      y: 64,
      z: 0,
      range: 2,
    });
    expect(createdBots[0]?.digPositions[0]?.bot).toEqual({ x: 8, y: 64, z: 0 });
    expect(createdBots[0]?.resourceBlocks).toEqual([]);

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
      world_key: "multiworld:resource",
      radius: 32,
    });
    expect(collectBot.receivedMovements[0]).toMatchObject({
      canDig: false,
    });
  });

  it("collect（捡拾） 执行层应允许 cutTree（砍树） 使用半径 8 的小范围收集", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    collectBot.entities.logDrop = {
      id: 17,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };
    collectBot.onGoto = () => {
      collectBot.inventoryItems.push({
        name: "oak_log",
        count: 3,
      });
      collectBot.entities.logDrop = undefined;
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
    let gotoCalls = 0;
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
      position: { x: 3, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };
    collectBot.onGoto = () => {
      gotoCalls += 1;

      if (gotoCalls === 1) {
        collectBot.inventoryItems.push({
          name: "oak_log",
          count: 1,
        });
        collectBot.entities.firstLogDrop = undefined;
        return;
      }

      throw new Error("second drop is still unreachable");
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
    expect(gotoCalls).toBeGreaterThan(1);
  });

  it("collect（捡拾） 应忽略与 Bot（机器人） 高度差超过 3 格的树叶滞留掉落物", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    let gotoCalls = 0;
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
      position: { x: 2, y: 69, z: 0 },
      item: {
        name: "oak_sapling",
      },
    };
    collectBot.onGoto = () => {
      gotoCalls += 1;
      collectBot.inventoryItems.push({
        name: "oak_log",
        count: 1,
      });
      collectBot.entities.groundLogDrop = undefined;
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
    expect(gotoCalls).toBe(1);
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

  it("collect（捡拾） 应贴近掉落物到拾取碰撞范围内", async () => {
    const collectBot = new FakeMineflayerBot();
    collectBot.entity.position = { x: 0, y: 64, z: 0 };
    const goalRanges: number[] = [];
    collectBot.entities.logDrop = {
      id: 22,
      name: "item",
      displayName: "Item",
      position: { x: 2, y: 64, z: 0 },
      item: {
        name: "oak_log",
      },
    };
    collectBot.onGoto = (goal) => {
      const range =
        typeof (goal as { readonly range?: unknown } | undefined)?.range === "number"
          ? (goal as { readonly range: number }).range
          : Number.POSITIVE_INFINITY;
      goalRanges.push(range);

      if (range <= 0.75) {
        collectBot.inventoryItems.push({
          name: "oak_log",
          count: 1,
        });
        collectBot.entities.logDrop = undefined;
      }
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
    expect(goalRanges).toEqual([0.75]);
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
      world_key: "multiworld:resource",
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
