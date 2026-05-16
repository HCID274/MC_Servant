import type { RuntimeResourceBlockSemanticRole } from "../../../core-ports/runtime.js";
import type {
  ToolchainEnsureFacts,
  ToolchainEnsureInventoryItem,
  ToolchainMaterialRequirement,
  ToolchainMaterialSource,
} from "../../../core-ports/skills.js";
import type { MineflayerBotHandle } from "../types.js";
import {
  asRecord,
  createInventoryItemIdsForRegistryBlockTag,
  createInventoryItemIdsForSemanticRole,
  isCutTreeLogLikeBlockFact,
  normalizeRegistryName,
  readNumber,
  readRegistryBlockDropIds,
  readRegistryBlockFactByName,
  readRegistryBlockFacts,
  readRegistryItemFactByName,
  readRegistryItemName,
  readStringValue,
} from "./registry-facts.js";

/** 创建工具链 ensure 所需的 runtime facts 读取端口。 */
export function createMineflayerToolchainEnsureFacts(source: {
  readonly getBot: () => MineflayerBotHandle | null;
}): ToolchainEnsureFacts {
  return Object.freeze({
    resolveRequiredEquipment(
      input: Parameters<ToolchainEnsureFacts["resolveRequiredEquipment"]>[0],
    ) {
      const bot = source.getBot();
      const blockName = readStringValue(input.failure.params.blockName);
      if (bot === null || blockName === null) {
        return null;
      }

      return resolveRequiredEquipmentFromRegistry(bot, blockName, input.inventory);
    },
    resolveMaterialSource(input: Parameters<ToolchainEnsureFacts["resolveMaterialSource"]>[0]) {
      const bot = source.getBot();
      return bot === null ? null : resolveMaterialSourceFromRegistry(bot.registry, input.itemName);
    },
    resolveMaterialRequirement(
      input: Parameters<ToolchainEnsureFacts["resolveMaterialRequirement"]>[0],
    ) {
      const bot = source.getBot();
      return bot === null
        ? null
        : resolveMaterialRequirementFromRegistry(
            bot.registry,
            input.itemName,
            input.missing,
            input.inventory,
          );
    },
    evaluateMaterialRequirement(
      input: Parameters<ToolchainEnsureFacts["evaluateMaterialRequirement"]>[0],
    ) {
      return evaluateMaterialRequirement(input.requirement, input.inventory);
    },
    canCraft(input: Parameters<ToolchainEnsureFacts["canCraft"]>[0]) {
      const bot = source.getBot();
      return bot === null ? false : canCraftItemByName(bot, input.itemName);
    },
    resolveCraftingTableBlockName() {
      const bot = source.getBot();
      const registryRecord = asRecord(bot?.registry);
      const blocksByName = asRecord(registryRecord?.blocksByName);
      const table = asRecord(blocksByName?.crafting_table);
      const name = readStringValue(table?.name);
      return name ?? (table === undefined ? null : "crafting_table");
    },
    resolveBlockDropItemNames(
      input: Parameters<ToolchainEnsureFacts["resolveBlockDropItemNames"]>[0],
    ) {
      const bot = source.getBot();
      return bot === null
        ? Object.freeze([])
        : resolveBlockDropItemNamesFromRegistry(bot.registry, input.blockName);
    },
    countInventoryItemsByTag(
      input: Parameters<ToolchainEnsureFacts["countInventoryItemsByTag"]>[0],
    ) {
      const bot = source.getBot();
      return bot === null
        ? 0
        : countInventoryItemsByRegistryTag(bot.registry, input.tagName, input.inventory);
    },
  });
}

export function countMineflayerInventoryItemsBySemanticRole(
  bot: MineflayerBotHandle,
  role: RuntimeResourceBlockSemanticRole,
): number {
  const matchingItemIds = createInventoryItemIdsForSemanticRole(bot.registry, role);

  if (matchingItemIds.size === 0) {
    return 0;
  }

  return (bot.inventory?.items() ?? []).reduce(
    (sum, item) =>
      item.type !== undefined && matchingItemIds.has(item.type) ? sum + (item.count ?? 1) : sum,
    0,
  );
}

function resolveRequiredEquipmentFromRegistry(
  bot: MineflayerBotHandle,
  blockName: string,
  inventory: readonly ToolchainEnsureInventoryItem[],
): string | null {
  const allowedToolIds = readRequiredHarvestToolIdsFromRegistry(bot.registry, blockName);
  if (allowedToolIds.length === 0) {
    return null;
  }

  const candidates = allowedToolIds.flatMap((itemId) => {
    const itemName = readRegistryItemName(bot.registry, itemId);
    return itemName === null ? [] : [itemName];
  });
  if (candidates.length === 0) {
    return null;
  }

  const inventoryCounts = new Map(
    inventory.map((item) => [normalizeRegistryName(item.item_name), item.count] as const),
  );
  const inventoryCandidate = candidates.find(
    (itemName) => (inventoryCounts.get(normalizeRegistryName(itemName)) ?? 0) > 0,
  );
  if (inventoryCandidate !== undefined) {
    return inventoryCandidate;
  }

  return candidates.find((itemName) => canCraftItemByName(bot, itemName)) ?? candidates[0] ?? null;
}

function resolveMaterialSourceFromRegistry(
  registry: unknown,
  itemName: string,
): ToolchainMaterialSource | null {
  const normalizedItemName = normalizeRegistryName(itemName);
  const item = readRegistryItemFactByName(registry, normalizedItemName);
  if (item === undefined) {
    return null;
  }

  const candidates = readRegistryBlockFacts(registry)
    .filter((block) => readRegistryBlockDropIds(block).includes(item.id))
    .sort((left, right) => compareMaterialSourceBlocks(left, right, normalizedItemName));
  const logCandidate = candidates.find((block) => isCutTreeLogLikeBlockFact(block));
  if (logCandidate !== undefined) {
    const blockName = readStringValue(logCandidate.name);
    return Object.freeze({
      action: "cutTree" as const,
      itemName: normalizedItemName,
      ...(blockName === null ? {} : { blockName: normalizeRegistryName(blockName) }),
    });
  }

  const sourceBlock = candidates[0];
  const sourceBlockName = readStringValue(sourceBlock?.name);
  return sourceBlockName === null
    ? null
    : Object.freeze({
        action: "mine" as const,
        itemName: normalizedItemName,
        blockName: normalizeRegistryName(sourceBlockName),
      });
}

function resolveMaterialRequirementFromRegistry(
  registry: unknown,
  itemName: string,
  missing: number,
  _inventory: readonly ToolchainEnsureInventoryItem[],
): ToolchainMaterialRequirement | null {
  const normalizedItemName = normalizeRegistryName(itemName);
  const source = resolveMaterialSourceFromRegistry(registry, normalizedItemName);
  if (source === null) {
    return null;
  }

  const acceptableItems = resolveAcceptableMaterialItemNames(registry, normalizedItemName, source);
  const completedCount = countInventoryItemsByNames(acceptableItems, _inventory);
  return Object.freeze({
    itemName: normalizedItemName,
    targetCount:
      source.action === "cutTree" ? Math.max(1, missing) : completedCount + Math.max(1, missing),
    acceptableItems,
    source,
  });
}

function resolveAcceptableMaterialItemNames(
  registry: unknown,
  itemName: string,
  source: ToolchainMaterialSource,
): readonly string[] {
  if (source.action !== "cutTree") {
    return Object.freeze([normalizeRegistryName(itemName)]);
  }

  const names = readRegistryBlockFacts(registry)
    .filter((block) => isCutTreeLogLikeBlockFact(block))
    .flatMap((block) =>
      readRegistryBlockDropIds(block)
        .map((dropId) => readRegistryItemName(registry, dropId))
        .filter((name): name is string => name !== null),
    )
    .map(normalizeRegistryName);

  return names.length === 0
    ? Object.freeze([normalizeRegistryName(itemName)])
    : Object.freeze([...new Set([normalizeRegistryName(itemName), ...names])]);
}

function evaluateMaterialRequirement(
  requirement: ToolchainMaterialRequirement,
  inventory: readonly ToolchainEnsureInventoryItem[],
) {
  const acceptableItems = new Set(requirement.acceptableItems.map(normalizeRegistryName));
  const matchedItems = inventory
    .map((item) =>
      Object.freeze({ item_name: normalizeRegistryName(item.item_name), count: item.count }),
    )
    .filter((item) => acceptableItems.has(item.item_name));
  const completedCount = matchedItems.reduce((sum, item) => sum + item.count, 0);

  return Object.freeze({
    ok: completedCount >= requirement.targetCount,
    completedCount,
    targetCount: requirement.targetCount,
    matchedItems: Object.freeze(matchedItems),
  });
}

function countInventoryItemsByNames(
  itemNames: readonly string[],
  inventory: readonly ToolchainEnsureInventoryItem[],
): number {
  const names = new Set(itemNames.map(normalizeRegistryName));
  return inventory.reduce(
    (sum, item) => (names.has(normalizeRegistryName(item.item_name)) ? sum + item.count : sum),
    0,
  );
}

function resolveBlockDropItemNamesFromRegistry(
  registry: unknown,
  blockName: string,
): readonly string[] {
  const block = readRegistryBlockFactByName(registry, blockName);
  const dropNames = readRegistryBlockDropIds(block ?? {})
    .map((dropId) => readRegistryItemName(registry, dropId))
    .filter((name): name is string => name !== null);
  if (dropNames.length > 0) {
    return Object.freeze([...new Set(dropNames.map(normalizeRegistryName))]);
  }

  const item = readRegistryItemFactByName(registry, blockName);
  return item?.name === undefined
    ? Object.freeze([normalizeRegistryName(blockName)])
    : Object.freeze([normalizeRegistryName(item.name)]);
}

function countInventoryItemsByRegistryTag(
  registry: unknown,
  tagName: string,
  inventory: readonly ToolchainEnsureInventoryItem[],
): number {
  const matchingItemIds = createInventoryItemIdsForRegistryBlockTag(registry, tagName);
  if (matchingItemIds.size === 0) {
    return 0;
  }

  return inventory.reduce((sum, item) => {
    const fact = readRegistryItemFactByName(registry, item.item_name);
    return fact !== undefined && matchingItemIds.has(fact.id) ? sum + item.count : sum;
  }, 0);
}

function compareMaterialSourceBlocks(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  itemName: string,
): number {
  const leftName = normalizeRegistryName(readStringValue(left.name) ?? "");
  const rightName = normalizeRegistryName(readStringValue(right.name) ?? "");
  const leftSame = leftName === itemName ? 1 : 0;
  const rightSame = rightName === itemName ? 1 : 0;
  if (leftSame !== rightSame) {
    return leftSame - rightSame;
  }

  const leftDiggable = left.diggable ? 0 : 1;
  const rightDiggable = right.diggable ? 0 : 1;
  if (leftDiggable !== rightDiggable) {
    return leftDiggable - rightDiggable;
  }

  return (
    readNumber(left.id, Number.MAX_SAFE_INTEGER) - readNumber(right.id, Number.MAX_SAFE_INTEGER)
  );
}

function canCraftItemByName(bot: MineflayerBotHandle, itemName: string): boolean {
  if (typeof bot.recipesAll !== "function" && typeof bot.recipesFor !== "function") {
    return false;
  }

  return resolveCraftCandidateItemIds(bot.registry, itemName).some((itemId) => {
    const allRecipes = bot.recipesAll?.(itemId, null, true) ?? [];
    const readyRecipes = bot.recipesFor?.(itemId, null, 1, true) ?? [];
    return allRecipes.length > 0 || readyRecipes.length > 0;
  });
}

function resolveCraftCandidateItemIds(registry: unknown, itemName: string): readonly number[] {
  const normalized = normalizeRegistryName(itemName);
  const item = readRegistryItemFactByName(registry, normalized);
  return item === undefined ? Object.freeze([]) : Object.freeze([item.id]);
}

function readRequiredHarvestToolIdsFromRegistry(
  registry: unknown,
  blockName: string,
): readonly number[] {
  const block = readRegistryBlockFactByName(registry, blockName);
  const harvestTools = asRecord(block?.harvestTools);
  if (harvestTools === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.keys(harvestTools)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value))
      .sort((left, right) => left - right),
  );
}
