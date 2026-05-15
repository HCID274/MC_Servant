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
  executeMineflayerCraft,
  executeMineflayerEquip,
  executeMineflayerPlaceCraftingTable,
  readMineflayerBlockAt,
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
import { stepToFoot } from "../runtime/transport/foot-step.js";
import { executeMineRouteAction } from "../runtime/transport/mine-action-executor.js";
import { planMineRoute } from "../runtime/transport/mine-bfs.js";
import { createMineBlockFactReader } from "../runtime/transport/mine-block-facts.js";
import {
  createProgressWatchdog,
  waitForPromiseOrCondition,
} from "../runtime/transport/progress-watchdog.js";
import {
  executeTerrainRouteAction,
  isTerrainBotAtFoot,
} from "../runtime/transport/terrain-action-executor.js";
import { planTerrainRoute } from "../runtime/transport/terrain-router.js";
import {
  clearSelfPlacedTerrainMemoryForTests,
  recordSelfPlacedTerrainBlock,
} from "../runtime/transport/terrain-self-placed-memory.js";

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
      shield: {
        id: 1155,
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
      "1155": {
        id: 1155,
        name: "shield",
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
  readonly placeBlockFailureCounts = new Map<string, number>();
  readonly placeBlockTransientFailureCounts = new Map<string, number>();
  readonly placeBlockPostPlaceFailureCounts = new Map<string, number>();
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
  onAfterStep?: () => void;
  autoPickupEnabled = true;
  rejectPlaceIntoCurrentFoot = false;
  rejectNonCraftingTablePlacement = false;

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
    this.onAfterStep?.();
    this.collectNearbyDrops();
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
      this.resourceBlocks.findLast(
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
    this.applyGravityAfterDig(block);
  }

  private applyGravityAfterDig(block: MineflayerBlockHandle): void {
    const dug = block.position;
    if (dug === undefined) return;
    const botX = Math.floor(this.entity.position.x);
    const botY = Math.floor(this.entity.position.y);
    const botZ = Math.floor(this.entity.position.z);
    if (dug.x !== botX || dug.z !== botZ || dug.y !== botY - 1) return;
    this.entity.position = {
      x: this.entity.position.x,
      y: this.entity.position.y - 1,
      z: this.entity.position.z,
    };
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
    if (this.heldItem === null) {
      throw new Error("must be holding an item to place");
    }
    if (this.rejectNonCraftingTablePlacement && this.heldItem.name !== "crafting_table") {
      throw new Error(`wrong held item: ${this.heldItem.name ?? "unknown"}`);
    }
    const referencePosition = referenceBlock.position;

    if (referencePosition === undefined) {
      throw new Error("missing reference position");
    }

    const target = {
      x: referencePosition.x + faceVector.x,
      y: referencePosition.y + faceVector.y,
      z: referencePosition.z + faceVector.z,
    };
    const targetKey = formatPositionKey(target);
    const currentFoot = this.entity.position
      ? {
          x: Math.floor(this.entity.position.x),
          y: Math.floor(this.entity.position.y),
          z: Math.floor(this.entity.position.z),
        }
      : null;
    if (
      this.rejectPlaceIntoCurrentFoot &&
      faceVector.y === 1 &&
      currentFoot !== null &&
      currentFoot.x === target.x &&
      currentFoot.y === target.y &&
      currentFoot.z === target.z
    ) {
      throw new Error("target occupied by bot");
    }

    const remainingTransientFailureCount =
      this.placeBlockTransientFailureCounts.get(targetKey) ?? 0;
    if (remainingTransientFailureCount > 0) {
      this.placeBlockTransientFailureCounts.set(targetKey, remainingTransientFailureCount - 1);
      throw new Error("transient place failure");
    }
    const remainingFailureCount = this.placeBlockFailureCounts.get(targetKey) ?? 0;
    if (remainingFailureCount > 0) {
      this.placeBlockFailureCounts.set(targetKey, remainingFailureCount - 1);
      throw new Error("target blocked");
    }
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
    this.dugAirPositions.delete(targetKey);
    const remainingPostPlaceFailureCount =
      this.placeBlockPostPlaceFailureCounts.get(targetKey) ?? 0;
    if (remainingPostPlaceFailureCount > 0) {
      this.placeBlockPostPlaceFailureCounts.set(targetKey, remainingPostPlaceFailureCount - 1);
      throw new Error(
        `Event blockUpdate:(${target.x}, ${target.y}, ${target.z}) did not fire within timeout of 5000ms`,
      );
    }
    if (
      faceVector.y === 1 &&
      currentFoot !== null &&
      currentFoot.x === target.x &&
      currentFoot.y === target.y &&
      currentFoot.z === target.z
    ) {
      this.entity.position = {
        x: target.x + 0.5,
        y: target.y + 1,
        z: target.z + 0.5,
      };
    }
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

  private collectNearbyDrops(): void {
    if (!this.autoPickupEnabled) return;
    const botPosition = this.entity.position;
    if (botPosition === undefined) return;

    for (const [key, entity] of Object.entries(this.entities)) {
      if (entity?.position === undefined) continue;
      if (
        Math.hypot(
          entity.position.x - botPosition.x,
          entity.position.y - botPosition.y,
          entity.position.z - botPosition.z,
        ) > 1.2
      ) {
        continue;
      }

      const item = readFakeDroppedItem(this.registry, entity);
      if (item === null) continue;
      const stack = this.inventoryItems.find((candidate) => candidate.name === item.name);
      if (stack === undefined) {
        this.inventoryItems.push({ type: item.type, name: item.name, count: item.count });
      } else {
        this.inventoryItems.splice(this.inventoryItems.indexOf(stack), 1, {
          ...stack,
          count: (stack.count ?? 0) + item.count,
        });
      }
      this.entities[key] = undefined;
      this.emit("playerCollect", this.entity, entity);
    }
  }
}

class NonMovingMineflayerBot extends FakeMineflayerBot {
  override setControlState(control: MineflayerControlState, state: boolean): void {
    this.controlStateCalls.push({ control, state });
  }
}

class HorizontalOnlyMineflayerBot extends FakeMineflayerBot {
  override setControlState(control: MineflayerControlState, state: boolean): void {
    this.controlStateCalls.push({ control, state });
    if (control !== "forward" || !state) {
      return;
    }

    const target = this.lookAtCalls.at(-1)?.position;
    const current = this.entity.position;
    if (target === undefined || current === undefined) {
      return;
    }

    this.entity.position = {
      x: Math.floor(target.x) + 0.5,
      y: current.y,
      z: Math.floor(target.z) + 0.5,
    };
  }
}

class DriftAfterDigDropMineflayerBot extends FakeMineflayerBot {
  override dig(block: MineflayerBlockHandle): void {
    super.dig(block);
    const dug = block.position;
    const current = this.entity.position;
    if (dug === undefined || current === undefined) return;
    if (Math.floor(current.y) !== dug.y) return;
    this.entity.position = {
      x: current.x,
      y: current.y,
      z: dug.z - 0.2,
    };
  }
}

class DriftAfterDropMineflayerBot extends FakeMineflayerBot {
  private didDriftDrop = false;

  override setControlState(control: MineflayerControlState, state: boolean): void {
    const target = this.lookAtCalls.at(-1)?.position;
    const current = this.entity.position;
    if (
      control === "forward" &&
      state &&
      !this.didDriftDrop &&
      target !== undefined &&
      current !== undefined &&
      Math.floor(target.y - 1) < Math.floor(current.y)
    ) {
      this.controlStateCalls.push({ control, state });
      this.didDriftDrop = true;
      this.entity.position = {
        x: Math.floor(target.x) + 2.2,
        y: Math.floor(target.y - 1),
        z: Math.floor(target.z) + 1.85,
      };
      return;
    }

    super.setControlState(control, state);
  }
}

class DriftAfterPlaceUpMineflayerBot extends FakeMineflayerBot {
  override async placeBlock(
    referenceBlock: MineflayerBlockHandle,
    faceVector: { readonly x: number; readonly y: number; readonly z: number },
  ): Promise<void> {
    await super.placeBlock(referenceBlock, faceVector);
    const referencePosition = referenceBlock.position;
    if (referencePosition === undefined || faceVector.y !== 1) return;

    const placedAt = {
      x: referencePosition.x + faceVector.x,
      y: referencePosition.y + faceVector.y,
      z: referencePosition.z + faceVector.z,
    };
    this.entity.position = {
      x: placedAt.x + 0.5,
      y: placedAt.y + 1,
      z: placedAt.z - 0.04,
    };
  }
}

class FirstCenterPulseOvershootMineflayerBot extends FakeMineflayerBot {
  private didOvershootCenterPulse = false;

  override setControlState(control: MineflayerControlState, state: boolean): void {
    const target = this.lookAtCalls.at(-1)?.position;
    const current = this.entity.position;
    if (
      control === "forward" &&
      state &&
      !this.didOvershootCenterPulse &&
      target !== undefined &&
      current !== undefined &&
      Math.floor(target.x) === Math.floor(current.x) &&
      Math.floor(target.y - 1) === Math.floor(current.y) &&
      Math.floor(target.z) === Math.floor(current.z)
    ) {
      this.controlStateCalls.push({ control, state });
      this.didOvershootCenterPulse = true;
      this.entity.position = {
        x: current.x,
        y: current.y,
        z: Math.floor(current.z) - 0.1,
      };
      return;
    }

    super.setControlState(control, state);
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

function readFakeDroppedItem(
  registry: FakeMineflayerBot["registry"],
  entity: MineflayerEntityHandle,
): { readonly type: number | undefined; readonly name: string; readonly count: number } | null {
  const explicitName = [
    entity.item?.name,
    entity.droppedItem?.name,
    ...(entity.metadata ?? [])
      .map((entry) =>
        typeof entry === "object" && entry !== null && "name" in entry
          ? (entry as { readonly name?: unknown }).name
          : undefined,
      )
      .filter((name): name is string => typeof name === "string"),
  ].find((name): name is string => typeof name === "string");
  const metadataItem = (entity.metadata ?? [])
    .map((entry) =>
      typeof entry === "object" && entry !== null && "itemId" in entry
        ? (entry as { readonly itemId?: unknown; readonly itemCount?: unknown })
        : null,
    )
    .find(
      (entry): entry is { readonly itemId?: unknown; readonly itemCount?: unknown } =>
        entry !== null && typeof entry.itemId === "number",
    );
  const metadataCount = (entity.metadata ?? [])
    .map((entry) =>
      typeof entry === "object" && entry !== null && "itemCount" in entry
        ? (entry as { readonly itemCount?: unknown })
        : null,
    )
    .find(
      (entry): entry is { readonly itemCount?: unknown } =>
        entry !== null && typeof entry.itemCount === "number",
    );
  const itemId = typeof metadataItem?.itemId === "number" ? metadataItem.itemId : undefined;
  const name =
    explicitName ?? (itemId === undefined ? undefined : registry.items[String(itemId)]?.name);
  if (name === undefined) return null;
  const type =
    registry.itemsByName[name as keyof FakeMineflayerBot["registry"]["itemsByName"]]?.id ?? itemId;
  const count =
    typeof metadataCount?.itemCount === "number" && metadataCount.itemCount > 0
      ? metadataCount.itemCount
      : 1;

  return Object.freeze({ type, name, count });
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

function populateFlatWalkway(
  bot: FakeMineflayerBot,
  input: {
    readonly minX: number;
    readonly maxX: number;
    readonly y: number;
    readonly minZ?: number;
    readonly maxZ?: number;
  },
): void {
  const minZ = input.minZ ?? 0;
  const maxZ = input.maxZ ?? 0;
  for (let x = input.minX; x <= input.maxX; x += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      setFakeBlockWithDiggable(bot, { x, y: input.y - 1, z }, "dirt", false);
      setFakeBlockWithDiggable(bot, { x, y: input.y, z }, "air", false);
      setFakeBlockWithDiggable(bot, { x, y: input.y + 1, z }, "air", false);
      setFakeBlockWithDiggable(bot, { x, y: input.y + 2, z }, "air", false);
    }
  }
}

function setFakeBlock(
  bot: FakeMineflayerBot,
  position: { readonly x: number; readonly y: number; readonly z: number },
  blockName: "air" | "dirt" | "stone" | "iron_ore",
): void {
  setFakeBlockWithDiggable(bot, position, blockName, blockName !== "air");
}

function setFakeBlockWithDiggable(
  bot: FakeMineflayerBot,
  position: { readonly x: number; readonly y: number; readonly z: number },
  blockName: "air" | "dirt" | "stone" | "iron_ore",
  diggable: boolean,
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
    diggable,
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

function isOppositeRouteDirection(left: string, right: string): boolean {
  return (
    (left === "north" && right === "south") ||
    (left === "south" && right === "north") ||
    (left === "east" && right === "west") ||
    (left === "west" && right === "east")
  );
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

describe("runtime Mineflayer（Minecraft 协议客户端） 最小闭环", () => {
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

  it("place（放置） 缺工作台物品时应返回结构化失败，不在放置层合成", async () => {
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
        code: "missing_crafting_table_item",
      },
    });
    expect(missingItemBot.craftCalls).toEqual([]);

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

  it("place（放置） 背包无工作台时不应调用 Mineflayer recipe（配方） 合成", async () => {
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
      ok: false,
      error: {
        code: "missing_crafting_table_item",
      },
    });
    expect(bot.craftCalls).toEqual([]);
    expect(bot.equipCalls).toEqual([]);
    expect(cache.position).toBeNull();
  });

  it("place（放置） 背包只有 logs（原木） 时不应递归合成工作台", async () => {
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
      ok: false,
      error: {
        code: "missing_crafting_table_item",
      },
    });
    expect(bot.craftCalls).toEqual([]);
    expect(bot.placeBlockCalls).toHaveLength(0);
    expect(cache.position).toBeNull();
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

  it("place（放置） 应走到邻近站位而不是站进目标放置格", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.rejectPlaceIntoCurrentFoot = true;
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    for (let x = 1; x <= 5; x += 1) {
      bot.resourceBlocks.push(
        { type: 2, name: "grass_block", position: { x, y: 63, z: 0 } },
        { type: 0, name: "air", position: { x, y: 64, z: 0 } },
        { type: 0, name: "air", position: { x, y: 65, z: 0 } },
      );
    }

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 5, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 5, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(bot.entity.position).toMatchObject({ x: 4.5, y: 64, z: 0.5 });
    expect(cache.position).toEqual({ x: 5, y: 64, z: 0 });
  });

  it("place（放置） 应在 approach（接近）改掉主手后重新装备工作台", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.rejectNonCraftingTablePlacement = true;
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push(
      { type: 7, name: "crafting_table", count: 1 },
      { type: 2, name: "dirt", count: 16 },
    );
    bot.onAfterStep = () => {
      bot.heldItem = { type: 2, name: "dirt", count: 1 };
      bot.onAfterStep = undefined;
    };
    for (let x = 1; x <= 5; x += 1) {
      bot.resourceBlocks.push(
        { type: 2, name: "grass_block", position: { x, y: 63, z: 0 } },
        { type: 0, name: "air", position: { x, y: 64, z: 0 } },
        { type: 0, name: "air", position: { x, y: 65, z: 0 } },
      );
    }

    await expect(
      executeMineflayerPlaceCraftingTable({
        bot,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
        params: { blockName: "crafting_table", near: { x: 5, y: 64, z: 0 } },
        worldKey: "minecraft:overworld",
        cache,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
        position: { x: 5, y: 64, z: 0 },
      },
    });
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(bot.equipCalls.at(-1)).toEqual({
      item: { type: 7, name: "crafting_table", count: 1 },
      destination: "hand",
    });
    expect(readMineflayerBlockAt(bot, { x: 5, y: 64, z: 0 })).toMatchObject({
      name: "crafting_table",
    });
  });

  it("place（放置） 应在 Mineflayer 放置事件超时后复查真实方块并判定成功", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockPostPlaceFailureCounts.set("2:64:0", 1);
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
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
  });

  it("place（放置） 应在放置未生效时重试同一候选点", async () => {
    const bot = new FakeMineflayerBot();
    const cache: CraftingTablePlacementCache = { position: null };
    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.inventoryItems.push({ type: 7, name: "crafting_table", count: 1 });
    bot.placeBlockTransientFailureCounts.set("2:64:0", 2);
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
    expect(bot.placeBlockCalls).toHaveLength(3);
    expect(cache.position).toEqual({ x: 2, y: 64, z: 0 });
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

  it("terrain-router 平移应允许 2 格高通道，不要求目标 top 为空", () => {
    const bot = new FakeMineflayerBot();
    for (const x of [0, 1]) {
      setFakeBlock(bot, { x, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 64, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 65, z: 0 }, "air");
      setFakeBlock(bot, { x, y: 66, z: 0 }, "dirt");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 64, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
    });

    expect(result.plan?.actions).toEqual([
      { kind: "walk", toFoot: { x: 1, y: 64, z: 0 }, dir: "east" },
    ]);
  });

  it("terrain-router digWalk 只清 foot/head，不应因为 top 被挡而拒绝 2 格高平洞", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "digWalk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
        digs: [{ x: 1, y: 65, z: 0 }],
      },
    ]);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase2_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 同水平被障碍封住时应优先规划水平挖穿，不应耗尽 expanded 预算", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 4; x += 1) {
      setFakeBlock(bot, { x, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 66, z: 0 }, "dirt");
    }
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 4, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 4, y: 65, z: 0 }, "air");
    for (const x of [1, 2, 3]) {
      setFakeBlock(bot, { x, y: 64, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: 65, z: 0 }, "dirt");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 4, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.expandedStates).toBeLessThan(80);
    expect(result.plan?.actions.filter((action) => action.kind === "digWalk")).toHaveLength(3);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase4_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 短距离可绕行时不应为了直线距离挖穿障碍", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 63,
      maxY: 63,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 64,
      maxY: 65,
      minZ: 0,
      maxZ: 1,
      blockName: "air",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 66,
      maxY: 66,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 3, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions).toHaveLength(5);
    expect(result.plan?.actions.every((action) => action.kind === "walk")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 应按预算剪掉连续不接近目标的分支并输出诊断", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 63,
      maxY: 63,
      minZ: 0,
      maxZ: 1,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: 0,
      maxX: 3,
      minY: 64,
      maxY: 65,
      minZ: 0,
      maxZ: 1,
      blockName: "air",
    });
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 3, y: 64, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
      routeBudget: {
        noProgressStepLimit: 0,
      },
    });

    expect(result.plan).toBeNull();
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_pruned_no_progress"))).toBe(
      true,
    );
  });

  it("terrain-router 自然阶段应允许 5 格以内连续下落且不挖不垫", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 5; x += 1) {
      const footY = 64 - x;
      setFakeBlock(bot, { x, y: footY - 1, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: footY, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 1, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 2, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 5, y: 59, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toHaveLength(5);
    expect(result.plan?.actions.every((action) => action.kind === "drop1")).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 超过 5 格连续下落时应离开自然阶段再求解", () => {
    const bot = new FakeMineflayerBot();
    for (let x = 0; x <= 6; x += 1) {
      const footY = 64 - x;
      setFakeBlock(bot, { x, y: footY - 1, z: 0 }, "dirt");
      setFakeBlock(bot, { x, y: footY, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 1, z: 0 }, "air");
      setFakeBlock(bot, { x, y: footY + 2, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 6, y: 58, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toHaveLength(6);
    expect(result.plan?.actions.every((action) => action.kind === "drop1")).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.startsWith("terrain_phase1_no_natural_path")),
    ).toBe(true);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase2_solved"))).toBe(
      true,
    );
  });

  it("terrain-router 只允许把 Bot 自己垫的脚下方块作为直下挖通路", () => {
    const createStuckOnSupportBot = () => {
      const bot = new FakeMineflayerBot();
      bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
      setFakeBlock(bot, { x: 0, y: 62, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
      setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
      setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
      return bot;
    };

    const naturalBlockBot = createStuckOnSupportBot();
    const rejected = planTerrainRoute({
      bot: naturalBlockBot,
      facts: createMineBlockFactReader(naturalBlockBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(rejected.plan).toBeNull();

    const wrongWorldBot = createStuckOnSupportBot();
    recordSelfPlacedTerrainBlock(wrongWorldBot, { x: 0, y: 64, z: 0 });
    wrongWorldBot.game.dimension = "multiworld:other";
    const rejectedCrossWorld = planTerrainRoute({
      bot: wrongWorldBot,
      facts: createMineBlockFactReader(wrongWorldBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 64, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(rejectedCrossWorld.plan).toBeNull();

    const selfPlacedBot = createStuckOnSupportBot();
    recordSelfPlacedTerrainBlock(selfPlacedBot, { x: 0, y: 64, z: 0 });
    recordSelfPlacedTerrainBlock(selfPlacedBot, { x: 0, y: 63, z: 0 });
    const solved = planTerrainRoute({
      bot: selfPlacedBot,
      facts: createMineBlockFactReader(selfPlacedBot.registry),
      startFoot: { x: 0, y: 65, z: 0 },
      targetFoot: { x: 0, y: 63, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
      maxExpandedStates: 80,
    });

    expect(solved.plan?.actions).toEqual([
      {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 63, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 63, z: 0 }],
      },
    ]);
  });

  it("terrain-action digDropSelfPlaced 应挖掉自放置脚手架并直下落地", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 64, z: 0 });
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "digDropSelfPlaced",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toEqual(["dirt"]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_dig_verified:dirt:0,64,0");
  });

  it("terrain-action drop1 下落后若横向漂移，应按 Y 到达先停止再纠偏", async () => {
    const bot = new DriftAfterDropMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "drop1",
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(isTerrainBotAtFoot(bot, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(diagnostics).toContain(
      "terrain_drop_recover_foot:drop1:target=0,64,0;current=2.20,64.00,1.85",
    );
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_move_reached:drop1_drop_recover:target=0,64,0;"),
      ),
    ).toBe(true);
  });

  it("terrain-action digDropSelfPlaced 下落后若漂到边缘，应纠偏并继续后续自放置脚手架", async () => {
    const bot = new DriftAfterDigDropMineflayerBot();
    bot.entity.position = { x: 0.5, y: 65, z: 0.5 };
    setFakeBlock(bot, { x: 0, y: 62, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 64, z: 0 });
    recordSelfPlacedTerrainBlock(bot, { x: 0, y: 63, z: 0 });
    const diagnostics: string[] = [];

    for (const action of [
      {
        kind: "digDropSelfPlaced" as const,
        toFoot: { x: 0, y: 64, z: 0 },
        dir: "north" as const,
        digs: [{ x: 0, y: 64, z: 0 }],
      },
      {
        kind: "digDropSelfPlaced" as const,
        toFoot: { x: 0, y: 63, z: 0 },
        dir: "north" as const,
        digs: [{ x: 0, y: 63, z: 0 }],
      },
    ]) {
      await executeTerrainRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action,
        diagnostics,
        control: NOOP_SKILL_EXECUTION_CONTROL,
      });
    }

    expect(bot.digCalls.map((block) => block.position?.y)).toEqual([64, 63]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 63, z: 0 })).toBe(true);
    expect(diagnostics).toContain(
      "terrain_drop_recover_foot:digDropSelfPlaced:target=0,64,0;current=0.50,64.00,-0.20",
    );
    expect(diagnostics).toContain("terrain_dig_verified:dirt:0,63,0");
  });

  it("terrain-router digStepDown 应在当前 top 被挡时纳入 digs，并拒绝终点只有 2 格净空", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 62, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "air");

    const solved = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 63, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    expect(solved.plan?.actions[0]).toEqual({
      kind: "digStepDown",
      toFoot: { x: 1, y: 63, z: 0 },
      dir: "east",
      digs: [
        { x: 0, y: 66, z: 0 },
        { x: 1, y: 63, z: 0 },
      ],
    });

    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    const rejected = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 63, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: false,
    });

    expect(rejected.plan).toBeNull();
  });

  it("terrain-router digStepUp 应允许清当前 top 且 digs 不重复", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: false,
    });

    const action = result.plan?.actions[0];
    expect(action).toMatchObject({
      kind: "digStepUp",
      toFoot: { x: 1, y: 65, z: 0 },
      dir: "east",
    });
    const digKeys = "digs" in (action ?? {}) ? action.digs.map(formatPositionKey) : [];
    expect(new Set(digKeys).size).toBe(digKeys.length);
    expect(digKeys).toContain("0:66:0");
  });

  it("terrain-router placeUp1 应在 2 格高坑道内先清顶再垫高", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [{ x: 0, y: 66, z: 0 }],
      },
    ]);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase3_solved"))).toBe(
      true,
    );
  });

  it("terrain-action placeUp1 应在单动作内跨轮重试直到成功", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 4);
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(5);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_place_up_round_start:round=3/3");
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_place_up_attempt:round=3;delay=320;status=success"),
      ),
    ).toBe(true);
  });

  it("terrain-action placeUp1 居中脉冲离开 foot 后应回退再垫高", async () => {
    const bot = new FirstCenterPulseOvershootMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.85 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(
      diagnostics.some((entry) => entry.startsWith("terrain_center_recover_foot:placeUp1")),
    ).toBe(true);
    expect(diagnostics.some((entry) => entry.startsWith("terrain_place_up_centered"))).toBe(true);
  });

  it("terrain-action placeUp1 垫高后若横向漂出 foot，应按 Y 到达先停止再纠偏", async () => {
    const bot = new DriftAfterPlaceUpMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_place_up_y_reached:placeUp1:target=0,65,0"),
      ),
    ).toBe(true);
    expect(diagnostics).toContain(
      "terrain_place_up_recover_foot:placeUp1:target=0,65,0;current=0.50,65.00,-0.04",
    );
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("terrain_move_reached:placeUp1_place_up_recover:target=0,65,0"),
      ),
    ).toBe(true);
  });

  it("terrain-action placeUp1 应在目标格有非替换薄方块时先清理再垫高", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "torch",
      type: 171,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [Object.freeze({})],
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toContain("torch");
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(diagnostics).toContain("terrain_place_target_clear_start:torch:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_done:torch:0,64,0");
  });

  it("terrain-action placeUp1 应允许无碰撞可替换植物由服务端直接覆盖", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "short_grass",
      type: 172,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [],
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls).toEqual([]);
    expect(bot.placeBlockCalls).toHaveLength(1);
    expect(diagnostics).toContain("terrain_place_target_replaceable:short_grass:0,64,0");
  });

  it("terrain-action placeUp1 应在可通行薄方块拒绝直接覆盖后清理再垫高", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    bot.resourceBlocks.push({
      name: "pink_petals",
      type: 173,
      position: { x: 0, y: 64, z: 0 },
      diggable: true,
      shapes: [],
      boundingBox: "empty",
    });
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 1);
    const diagnostics: string[] = [];

    await executeTerrainRouteAction({
      bot,
      facts: createMineBlockFactReader({
        ...bot.registry,
        blocksByName: {
          ...bot.registry.blocksByName,
          pink_petals: {
            id: 173,
            name: "pink_petals",
            boundingBox: "empty",
            diggable: true,
            material: "plant",
            hardness: 0,
          },
        },
      }),
      action: {
        kind: "placeUp1",
        toFoot: { x: 0, y: 65, z: 0 },
        dir: "north",
        placeAt: { x: 0, y: 64, z: 0 },
        support: { x: 0, y: 63, z: 0 },
        digs: [],
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.digCalls.map((block) => block.name)).toContain("pink_petals");
    expect(bot.placeBlockCalls).toHaveLength(2);
    expect(bot.unequipCalls).toEqual(["hand"]);
    expect(bot.equipCalls.map((call) => call.item.name)).toEqual(["dirt", "dirt"]);
    expect(isTerrainBotAtFoot(bot, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(diagnostics).toContain("terrain_place_target_replaceable:pink_petals:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_start:pink_petals:0,64,0");
    expect(diagnostics).toContain("terrain_place_target_clear_done:pink_petals:0,64,0");
  });

  it("terrain-action placeUp1 应在三轮 delay 队列全失败后返回结构化动作失败", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
    bot.inventoryItems.push({ type: 21, name: "dirt", count: 8 });
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    bot.placeBlockFailureCounts.set("0:64:0", 6);
    const diagnostics: string[] = [];

    await expect(
      executeTerrainRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action: {
          kind: "placeUp1",
          toFoot: { x: 0, y: 65, z: 0 },
          dir: "north",
          placeAt: { x: 0, y: 64, z: 0 },
          support: { x: 0, y: 63, z: 0 },
          digs: [],
        },
        diagnostics,
        control: NOOP_SKILL_EXECUTION_CONTROL,
      }),
    ).rejects.toThrow("terrain_place_up_failed:target blocked");

    expect(bot.placeBlockCalls).toHaveLength(6);
    expect(diagnostics).toContain("terrain_place_up_round_failed:round=3/3");
  });

  it("terrain-action foot 判定应以离散脚下格为准，不被跳跃余波 raw y 误杀", () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: -17.04,
      y: 112.753,
      z: -209.53,
    };

    expect(isTerrainBotAtFoot(bot, { x: -18, y: 112, z: -210 })).toBe(true);
    expect(isTerrainBotAtFoot(bot, { x: -18, y: 112, z: -209 })).toBe(false);
  });

  it("progress watchdog 应在有真实进展时刷新 idle 计时", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let progress = { x: 0 };
      const watchdog = createProgressWatchdog({
        idleTimeoutMs: 15_000,
        readProgress: () => progress,
        isProgressAdvanced: (previous, current) => current.x !== previous.x,
        describeProgress: (value) => `x=${value.x}`,
        createTimeoutMessage: ({ idleMs }) => `stuck:${idleMs}`,
      });

      vi.setSystemTime(14_000);
      watchdog.assertAlive();
      progress = { x: 1 };
      watchdog.assertAlive();
      vi.setSystemTime(28_000);
      watchdog.assertAlive();
      vi.setSystemTime(30_100);
      expect(() => watchdog.assertAlive()).toThrow("stuck:16100");
    } finally {
      vi.useRealTimers();
    }
  });

  it("progress watchdog 等待 dig/place 原语时应优先响应取消信号", async () => {
    const neverSettled = new Promise<void>(() => {});
    let conditionChecks = 0;

    await expect(
      waitForPromiseOrCondition({
        promise: neverSettled,
        condition: () => {
          conditionChecks += 1;
          return false;
        },
        idleTimeoutMs: 15_000,
        pollMs: 50,
        timeoutMessage: () => "should_not_timeout",
        throwIfAborted: () => {
          throw new Error("skill_aborted");
        },
      }),
    ).rejects.toThrow("skill_aborted");
    expect(conditionChecks).toBe(0);
  });

  it("foot-step 移动卡死时应松开控制键并带当前位置诊断", async () => {
    const bot = new NonMovingMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const diagnostics: string[] = [];

    await expect(
      stepToFoot({
        bot,
        target: { x: 2, y: 64, z: 0 },
        jump: false,
        timeoutMs: 120,
        lookTimeoutMs: 50,
        diagnosticPrefix: "mine",
        actionKind: "walk",
        diagnostics,
      }),
    ).rejects.toThrow(/mine_step_stuck_timeout:2,64,0:current=0\.50,64\.00,0\.50;idle_ms=/u);

    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: false });
    expect(bot.clearedControlStates).toBeGreaterThan(0);
    expect(diagnostics[0]).toBe(
      "mine_move_start:walk:target=2,64,0;from=0.50,64.00,0.50;jump=false",
    );
  });

  it("foot-step 水平到中心但 Y 未到目标 foot 时不得提前停止移动", async () => {
    const bot = new HorizontalOnlyMineflayerBot();
    bot.entity.position = {
      x: -30.5,
      y: 112,
      z: -235.7,
    };

    await expect(
      stepToFoot({
        bot,
        target: { x: -31, y: 111, z: -236 },
        jump: true,
        timeoutMs: 180,
        lookTimeoutMs: 50,
        diagnosticPrefix: "mine",
        actionKind: "digStepDown",
      }),
    ).rejects.toThrow(
      /mine_step_stuck_timeout:-31,111,-236:current=-30\.50,112\.00,-235\.50;idle_ms=.*best_horizontal=0\.00;target_y=111;current_y=112;y_matched=false/u,
    );

    const forwardStarts = bot.controlStateCalls.filter(
      (call) => call.control === "forward" && call.state,
    );
    expect(forwardStarts).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "jump", state: true });
    expect(bot.controlStateCalls).toContainEqual({ control: "jump", state: false });
  });

  it("mine-action digStepDown 应挖开后下落进坑而不是持续跳跃", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "digStepDown",
        toFoot: { x: 1, y: 63, z: 0 },
        dir: "east",
        digs: [],
      },
      diagnostics: [],
      control: NOOP_SKILL_EXECUTION_CONTROL,
    });

    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.controlStateCalls).not.toContainEqual({ control: "jump", state: true });
    expect(bot.entity.position).toMatchObject({ x: 1.5, y: 63, z: 0.5 });
  });

  it("mine-action 自然小位移应优先使用局部 pathfinder", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const diagnostics: string[] = [];

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "walk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
      pathfinder: bot.pathfinder,
      pathfinderModule: fakePathfinderModule,
    });

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(bot.entity.position).toMatchObject({ x: 1.5, y: 64, z: 0.5 });
    expect(
      diagnostics.some((entry) =>
        entry.startsWith("mine_local_pathfinder_reached:walk:target=1,64,0;"),
      ),
    ).toBe(true);
  });

  it("mine-action 局部 pathfinder 失败时应回退到自研按键原语", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    bot.onGoto = () => {
      throw new Error("no_path");
    };
    const diagnostics: string[] = [];

    await executeMineRouteAction({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      action: {
        kind: "walk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
      },
      diagnostics,
      control: NOOP_SKILL_EXECUTION_CONTROL,
      pathfinder: bot.pathfinder,
      pathfinderModule: fakePathfinderModule,
    });

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toContainEqual({ control: "forward", state: true });
    expect(
      diagnostics.some((entry) => entry.includes("mine_local_pathfinder_failed:walk:no_path")),
    ).toBe(true);
  });

  it("mine-action 局部 pathfinder 期间取消应向上传播且不得回退移动", async () => {
    const bot = new FakeMineflayerBot();
    bot.entity.position = {
      x: 0.5,
      y: 64,
      z: 0.5,
    };
    const abortController = new AbortController();
    const abortError = Object.assign(new Error("cancelled by test"), {
      name: "AbortError",
    });
    const control = {
      signal: abortController.signal,
      throwIfAborted(): void {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason;
        }
      },
    };
    bot.onGoto = () => {
      abortController.abort(abortError);
      return new Promise<void>(() => {});
    };
    const diagnostics: string[] = [];

    await expect(
      executeMineRouteAction({
        bot,
        facts: createMineBlockFactReader(bot.registry),
        action: {
          kind: "walk",
          toFoot: { x: 1, y: 64, z: 0 },
          dir: "east",
        },
        diagnostics,
        control,
        pathfinder: bot.pathfinder,
        pathfinderModule: fakePathfinderModule,
      }),
    ).rejects.toBe(abortError);

    expect(bot.gotoCalls).toHaveLength(1);
    expect(bot.controlStateCalls).toEqual([]);
    expect(diagnostics.some((entry) => entry.includes("mine_local_pathfinder_failed:walk"))).toBe(
      false,
    );
  });

  it("terrain-router 深坑 30 格纯垫高不得被 24 格 plannedSolid 旧预算剪掉", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    for (let y = 64; y <= 97; y += 1) {
      setFakeBlock(bot, { x: 0, y, z: 0 }, "air");
    }

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 94, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions.filter((action) => action.kind === "placeUp1")).toHaveLength(30);
  });

  it("terrain-router 应优先向目标高度收敛，避免深坑返回被水平旁支耗尽 expanded 预算", () => {
    const bot = new FakeMineflayerBot();
    populateMiningBox(bot, {
      minX: -12,
      maxX: 12,
      minY: 63,
      maxY: 63,
      minZ: -12,
      maxZ: 12,
      blockName: "dirt",
    });
    populateMiningBox(bot, {
      minX: -12,
      maxX: 12,
      minY: 64,
      maxY: 76,
      minZ: -12,
      maxZ: 12,
      blockName: "air",
    });

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 74, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
      maxExpandedStates: 80,
    });

    expect(result.plan).not.toBeNull();
    expect(result.plan?.actions.filter((action) => action.kind === "placeUp1")).toHaveLength(10);
    expect(result.diagnostics.some((entry) => entry.startsWith("terrain_phase4_solved"))).toBe(
      true,
    );
  });

  it("terrain-router placeUp1 应让放置覆盖之前 digWalk 产生的 plannedAir", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlockWithDiggable(bot, { x: 0, y: 66, z: 0 }, "dirt", false);
    setFakeBlock(bot, { x: 1, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 64, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 1, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 66, z: 0 }, "air");
    setFakeBlock(bot, { x: 1, y: 67, z: 0 }, "air");

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 1, y: 65, z: 0 },
      goalRange: 0,
      allowDig: true,
      allowPlaceUp: true,
    });

    expect(result.plan?.actions).toEqual([
      {
        kind: "digWalk",
        toFoot: { x: 1, y: 64, z: 0 },
        dir: "east",
        digs: [{ x: 1, y: 64, z: 0 }],
      },
      {
        kind: "placeUp1",
        toFoot: { x: 1, y: 65, z: 0 },
        dir: "east",
        placeAt: { x: 1, y: 64, z: 0 },
        support: { x: 1, y: 63, z: 0 },
        digs: [],
      },
    ]);
  });

  it("terrain-router placeUp1 应拒绝垫高后目标 foot 三格净空不足且不可挖", () => {
    const bot = new FakeMineflayerBot();
    setFakeBlock(bot, { x: 0, y: 63, z: 0 }, "dirt");
    setFakeBlock(bot, { x: 0, y: 64, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 65, z: 0 }, "air");
    setFakeBlock(bot, { x: 0, y: 66, z: 0 }, "air");
    setFakeBlockWithDiggable(bot, { x: 0, y: 67, z: 0 }, "dirt", false);

    const result = planTerrainRoute({
      bot,
      facts: createMineBlockFactReader(bot.registry),
      startFoot: { x: 0, y: 64, z: 0 },
      targetFoot: { x: 0, y: 65, z: 0 },
      goalRange: 0,
      allowDig: false,
      allowPlaceUp: true,
    });

    expect(result.plan).toBeNull();
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
