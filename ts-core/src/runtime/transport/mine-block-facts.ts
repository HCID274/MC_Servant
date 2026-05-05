import type { StairBFSBlockRole } from "../../domain/stair-bfs-planner.js";
import { normalizeMinecraftName as normalizeMineflayerName } from "./naming.js";
import type {
  MineflayerBlockHandle,
  MineflayerItemHandle,
  MineflayerRegistryFacts,
} from "./types.js";

/** mine（挖掘） 对方块事实的只读适配，事实优先来自 Mineflayer（Minecraft 协议客户端） registry（注册表）。 */
export interface MineBlockFactReader {
  readonly registry: unknown;
  normalizeName(value: string | undefined): string;
  classifyBlockRole(block: MineflayerBlockHandle, targetBlockName: string): StairBFSBlockRole;
  resolveExpectedDropName(blockName: string): string;
  readRequiredHarvestToolIds(blockName: string): readonly number[];
  isInventoryItemAllowedForBlock(item: MineflayerItemHandle, blockName: string): boolean;
}

/** 创建 mine（挖掘） 方块事实读取器。 */
export function createMineBlockFactReader(registry: unknown): MineBlockFactReader {
  return Object.freeze({
    registry,
    normalizeName,
    classifyBlockRole(block, targetBlockName) {
      return classifyMineBlockRole(registry, block, targetBlockName);
    },
    resolveExpectedDropName(blockName) {
      return resolveExpectedDropName(registry, blockName);
    },
    readRequiredHarvestToolIds(blockName) {
      return readRequiredHarvestToolIds(registry, blockName);
    },
    isInventoryItemAllowedForBlock(item, blockName) {
      const itemType = item.type;
      return (
        itemType !== undefined && readRequiredHarvestToolIds(registry, blockName).includes(itemType)
      );
    },
  });
}

function classifyMineBlockRole(
  registry: unknown,
  block: MineflayerBlockHandle,
  targetBlockName: string,
): StairBFSBlockRole {
  const blockName = normalizeName(block.name);
  const fact = readRegistryBlockFact(registry, blockName);

  if (isAirBlockFact(blockName, fact) || fact?.boundingBox === "empty") {
    return "air";
  }

  const material = normalizeName(fact?.material);
  if (material === "lava" || blockName === "lava") {
    return "lava";
  }
  if (material === "water" || blockName === "water") {
    return "water";
  }
  if (isFallingBlockFact(fact)) {
    return "falling";
  }
  if (blockName === targetBlockName) {
    return readRequiredHarvestToolIds(registry, targetBlockName).length > 0 ? "ore" : "mineable";
  }
  if (block.diggable === true || fact?.diggable === true) {
    return "mineable";
  }

  return "solid";
}

function resolveExpectedDropName(registry: unknown, blockName: string): string {
  const fact = readRegistryBlockFact(registry, blockName);
  const firstDrop = fact?.drops?.find((drop): drop is number => Number.isInteger(drop));
  if (firstDrop === undefined) {
    return blockName;
  }

  return readRegistryItemName(registry, firstDrop) ?? blockName;
}

function readRequiredHarvestToolIds(registry: unknown, blockName: string): readonly number[] {
  const harvestTools = readRegistryBlockFact(registry, blockName)?.harvestTools;
  if (harvestTools === undefined || harvestTools === null || typeof harvestTools !== "object") {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.keys(harvestTools)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
  );
}

function readRegistryBlockFact(
  registry: unknown,
  blockName: string,
): MineflayerRegistryBlockFactWithMining | undefined {
  const registryRecord = asRecord(registry) as MineflayerRegistryFacts | undefined;
  return registryRecord?.blocksByName?.[blockName] as
    | MineflayerRegistryBlockFactWithMining
    | undefined;
}

function readRegistryItemName(registry: unknown, itemId: number): string | undefined {
  const registryRecord = asRecord(registry) as MineflayerRegistryFacts | undefined;
  const item = registryRecord?.items?.[String(itemId)] ?? registryRecord?.items?.[itemId];
  return typeof item?.name === "string" && item.name.length > 0
    ? normalizeName(item.name)
    : undefined;
}

function isAirBlockFact(
  blockName: string,
  fact: MineflayerRegistryBlockFactWithMining | undefined,
): boolean {
  return blockName === "air" || fact?.boundingBox === "empty";
}

function isFallingBlockFact(fact: MineflayerRegistryBlockFactWithMining | undefined): boolean {
  return fact?.falling === true;
}

function normalizeName(value: string | undefined): string {
  const normalized = normalizeMineflayerName(value);
  return normalized.startsWith("minecraft:") ? normalized.slice("minecraft:".length) : normalized;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

interface MineflayerRegistryBlockFactWithMining {
  readonly id: number;
  readonly name?: string;
  readonly diggable?: boolean;
  readonly drops?: readonly number[];
  readonly boundingBox?: string;
  readonly material?: string;
  readonly falling?: boolean;
  readonly harvestTools?: Readonly<Record<string, unknown>>;
}
