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

export class FakeMineflayerBot extends EventEmitter implements MineflayerBotHandle {
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
  readonly findBlocksRequests: Readonly<{
    readonly count: number;
    readonly maxDistance?: number;
  }>[] = [];
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
    maxDistance?: number;
  }): readonly { readonly x: number; readonly y: number; readonly z: number }[] {
    this.findBlocksCalls += 1;
    this.findBlocksRequests.push({ count: input.count, maxDistance: input.maxDistance });
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

export class NonMovingMineflayerBot extends FakeMineflayerBot {
  override setControlState(control: MineflayerControlState, state: boolean): void {
    this.controlStateCalls.push({ control, state });
  }
}

export class HorizontalOnlyMineflayerBot extends FakeMineflayerBot {
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

export class DriftAfterDigDropMineflayerBot extends FakeMineflayerBot {
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

export class DriftAfterDropMineflayerBot extends FakeMineflayerBot {
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

export class DriftAfterPlaceUpMineflayerBot extends FakeMineflayerBot {
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

export class FirstCenterPulseOvershootMineflayerBot extends FakeMineflayerBot {
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

export function readFakeBlockDrops(
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

export function readFakeDroppedItem(
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

export function populateFlatMiningFixture(
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

export function populateMiningBox(
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

export function populateFlatWalkway(
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

export function setFakeBlock(
  bot: FakeMineflayerBot,
  position: { readonly x: number; readonly y: number; readonly z: number },
  blockName: "air" | "dirt" | "stone" | "iron_ore",
): void {
  setFakeBlockWithDiggable(bot, position, blockName, blockName !== "air");
}

export function setFakeBlockWithDiggable(
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

export function formatPositionKey(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return `${position.x}:${position.y}:${position.z}`;
}

export function isOppositeRouteDirection(left: string, right: string): boolean {
  return (
    (left === "north" && right === "south") ||
    (left === "south" && right === "north") ||
    (left === "east" && right === "west") ||
    (left === "west" && right === "east")
  );
}

export function asGoalPosition(
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

export const fakePathfinderModule = {
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

export {
  beforeEach,
  describe,
  expect,
  it,
  vi,
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
  blockMatchesResourceKey,
  createMineflayerToolchainEnsureFacts,
  createRuntimeResourceSemanticRoles,
  createRuntimeResourceTags,
  readRegistryBlockDropIds,
  readRegistryBlockFactByName,
  readRegistryItemName,
  registryCanResolveResourceKey,
  executeMineRouteAction,
  createMineBlockFactReader,
  planMineRoute,
  executeMineflayerPlaceCraftingTable,
  createProgressWatchdog,
  waitForPromiseOrCondition,
  executeTerrainRouteAction,
  isTerrainBotAtFoot,
  stepToFoot,
  planTerrainRoute,
  clearSelfPlacedTerrainMemoryForTests,
  recordSelfPlacedTerrainBlock,
  readMineflayerBlockAt,
};

export type {
  Vec3,
  CraftingTablePlacementCache,
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerControlState,
  MineflayerEntityHandle,
  MineflayerItemHandle,
  MineflayerRecipeHandle,
};
