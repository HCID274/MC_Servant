import type { MineflayerBlockHandle, MineflayerItemHandle } from "../types.js";
import {
  normalizeOptionalRegistryName,
  readRegistryBlockFactByName,
  readRegistryItemName,
} from "./registry-facts.js";

/** mine（挖掘） 对方块事实的只读适配，事实优先来自 Mineflayer（Minecraft 协议客户端） registry（注册表）。 */
export interface MineBlockFactReader {
  readonly registry: unknown;
  normalizeName(value: string | undefined): string;
  isLiteralAirBlock(block: MineflayerBlockHandle): boolean;
  isAirBlock(block: MineflayerBlockHandle): boolean;
  isHazardBlock(block: MineflayerBlockHandle): boolean;
  isSupportBlock(block: MineflayerBlockHandle): boolean;
  isDiggableBlock(block: MineflayerBlockHandle): boolean;
  resolveExpectedDropName(blockName: string): string;
  readRequiredHarvestToolIds(blockName: string): readonly number[];
  isInventoryItemAllowedForBlock(item: MineflayerItemHandle, blockName: string): boolean;
}

/** 创建 mine（挖掘） 方块事实读取器。 */
export function createMineBlockFactReader(registry: unknown): MineBlockFactReader {
  return Object.freeze({
    registry,
    normalizeName,
    isLiteralAirBlock(block) {
      return isLiteralAirBlock(block);
    },
    isAirBlock(block) {
      return isAirBlock(registry, block);
    },
    isHazardBlock(block) {
      return isHazardBlock(registry, block);
    },
    isSupportBlock(block) {
      return isSupportBlock(registry, block);
    },
    isDiggableBlock(block) {
      return isDiggableBlock(registry, block);
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

function isLiteralAirBlock(block: MineflayerBlockHandle): boolean {
  return AIR_BLOCK_NAMES.has(normalizeName(block.name));
}

function isAirBlock(registry: unknown, block: MineflayerBlockHandle): boolean {
  const blockName = normalizeName(block.name);
  return isAirBlockFact(blockName, readRegistryMiningBlockFact(registry, blockName));
}

function isHazardBlock(registry: unknown, block: MineflayerBlockHandle): boolean {
  const blockName = normalizeName(block.name);
  return isHazardBlockFact(blockName, readRegistryMiningBlockFact(registry, blockName));
}

function isSupportBlock(registry: unknown, block: MineflayerBlockHandle): boolean {
  return !isAirBlock(registry, block) && !isHazardBlock(registry, block);
}

function isDiggableBlock(registry: unknown, block: MineflayerBlockHandle): boolean {
  const blockName = normalizeName(block.name);
  const fact = readRegistryMiningBlockFact(registry, blockName);
  if (block.diggable === false) return false;
  if (isLiteralAirBlock(block)) return false;
  if (isHazardBlockFact(blockName, fact)) return false;
  if (isUnbreakableBlockFact(blockName, fact)) return false;
  return true;
}

function resolveExpectedDropName(registry: unknown, blockName: string): string {
  const fact = readRegistryMiningBlockFact(registry, blockName);
  const firstDrop = fact?.drops?.find((drop): drop is number => Number.isInteger(drop));
  if (firstDrop === undefined) {
    return blockName;
  }

  return readRegistryItemName(registry, firstDrop) ?? blockName;
}

function readRequiredHarvestToolIds(registry: unknown, blockName: string): readonly number[] {
  const harvestTools = readRegistryMiningBlockFact(registry, blockName)?.harvestTools;
  if (harvestTools === undefined || harvestTools === null || typeof harvestTools !== "object") {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.keys(harvestTools)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value)),
  );
}

function readRegistryMiningBlockFact(
  registry: unknown,
  blockName: string,
): MineflayerRegistryBlockFactWithMining | undefined {
  return readRegistryBlockFactByName(registry, blockName) as
    | MineflayerRegistryBlockFactWithMining
    | undefined;
}

function isAirBlockFact(
  blockName: string,
  fact: MineflayerRegistryBlockFactWithMining | undefined,
): boolean {
  return AIR_BLOCK_NAMES.has(blockName) || fact?.boundingBox === "empty";
}

function isHazardBlockFact(
  blockName: string,
  fact: MineflayerRegistryBlockFactWithMining | undefined,
): boolean {
  const material = normalizeName(fact?.material);
  return HAZARD_BLOCK_NAMES.has(blockName) || HAZARD_MATERIALS.has(material);
}

function isUnbreakableBlockFact(
  blockName: string,
  fact: MineflayerRegistryBlockFactWithMining | undefined,
): boolean {
  return (
    UNBREAKABLE_BLOCK_NAMES.has(blockName) ||
    (typeof fact?.hardness === "number" && fact.hardness < 0)
  );
}

function normalizeName(value: string | undefined): string {
  return normalizeOptionalRegistryName(value);
}

interface MineflayerRegistryBlockFactWithMining {
  readonly id: number;
  readonly name?: string;
  readonly diggable?: boolean;
  readonly drops?: readonly number[];
  readonly boundingBox?: string;
  readonly material?: string;
  readonly hardness?: number;
  readonly harvestTools?: Readonly<Record<string, unknown>>;
}

const AIR_BLOCK_NAMES = new Set(["air", "cave_air", "void_air"]);
const HAZARD_BLOCK_NAMES = new Set(["lava", "water", "magma_block", "fire"]);
const HAZARD_MATERIALS = new Set(["lava", "water", "fire"]);
const UNBREAKABLE_BLOCK_NAMES = new Set(["bedrock"]);
