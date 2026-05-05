import type {
  CraftCapabilityParams,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailureCode,
} from "../../core-ports/skills.js";
import { type CraftingTablePlacementCache, isCraftingTableBlock } from "./crafting-table.js";
import type {
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerInventoryPort,
  MineflayerItemHandle,
  MineflayerRecipeHandle,
  MineflayerRegistryFacts,
} from "./types.js";
import { readMineflayerBlockAt } from "./world-reader.js";

const CRAFTING_TABLE_SEARCH_RADIUS = 6;
const CRAFT_RECURSION_LIMIT = 5;
const PHASE1_CRAFT_ALLOWLIST = Object.freeze([
  "planks",
  "stick",
  "crafting_table",
  "wooden_pickaxe",
  "stone_pickaxe",
] as const);

type CraftTransportResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** 执行最小 craft（合成） 能力，配方事实全部来自 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）。 */
export async function executeMineflayerCraft(input: {
  readonly bot: MineflayerBotHandle;
  readonly params: Readonly<CraftCapabilityParams>;
  readonly worldKey: string | null;
  readonly craftingTableCache?: CraftingTablePlacementCache;
}): Promise<CraftTransportResult> {
  const capabilitiesError = validateCraftingCapabilities(input.bot, input.worldKey);

  if (capabilitiesError !== null) {
    return capabilitiesError;
  }

  const requestedTarget = normalizeCraftName(input.params.itemName);
  const normalizedTarget = isWoodenRepairMaterial(input.bot.registry, requestedTarget)
    ? "planks"
    : requestedTarget;
  if (!isPhase1CraftAllowed(normalizedTarget)) {
    return createCraftFailure({
      code: "unsupported_capability",
      message: `Craft target is not enabled in Phase 1: ${input.params.itemName}`,
      worldKey: input.worldKey,
      details: { item_name: input.params.itemName },
    });
  }

  return executeMineflayerCraftInternal({
    ...input,
    params: {
      itemName: normalizedTarget,
      count: input.params.count,
    },
    depth: 0,
    visited: new Set<string>(),
    allowIntermediateTarget: false,
  });
}

async function executeMineflayerCraftInternal(input: {
  readonly bot: MineflayerBotHandle;
  readonly params: Readonly<CraftCapabilityParams>;
  readonly worldKey: string | null;
  readonly craftingTableCache?: CraftingTablePlacementCache;
  readonly depth: number;
  readonly visited: Set<string>;
  readonly allowIntermediateTarget: boolean;
}): Promise<CraftTransportResult> {
  const normalizedTarget = normalizeCraftName(input.params.itemName);
  if (!input.allowIntermediateTarget && !isPhase1CraftAllowed(normalizedTarget)) {
    return createCraftFailure({
      code: "unsupported_capability",
      message: `Craft target is not enabled in Phase 1: ${input.params.itemName}`,
      worldKey: input.worldKey,
      details: { item_name: input.params.itemName },
    });
  }

  if (input.depth > CRAFT_RECURSION_LIMIT || input.visited.has(normalizedTarget)) {
    return createCraftFailure({
      code: "missing_materials",
      message: "Craft dependency chain cannot be resolved",
      worldKey: input.worldKey,
      details: { item_name: normalizedTarget, depth: input.depth },
    });
  }

  const targetCandidates = resolveCraftTargetCandidates(input.bot.registry, input.params.itemName);

  if (targetCandidates.length === 0) {
    return createCraftFailure({
      code: "recipe_not_found",
      message: `No minecraft-data recipe target found for ${input.params.itemName}`,
      worldKey: input.worldKey,
      details: { item_name: input.params.itemName },
    });
  }

  const craftingTable = await findNearbyCraftingTable(input.bot, input.craftingTableCache);
  let craftPlan = selectCraftPlan({
    bot: input.bot,
    candidates: targetCandidates,
    count: input.params.count,
    craftingTable,
  });

  if (craftPlan.status === "failed" && craftPlan.code === "missing_materials") {
    const prepared = await craftMissingMaterials({
      bot: input.bot,
      candidates: targetCandidates,
      count: input.params.count,
      craftingTable,
      worldKey: input.worldKey,
      ...(input.craftingTableCache === undefined
        ? {}
        : { craftingTableCache: input.craftingTableCache }),
      depth: input.depth,
      visited: input.visited,
      targetName: normalizedTarget,
    });

    if (!prepared.ok) {
      return prepared;
    }

    craftPlan = selectCraftPlan({
      bot: input.bot,
      candidates: targetCandidates,
      count: input.params.count,
      craftingTable,
    });
  }

  if (craftPlan.status === "ready") {
    try {
      await input.bot.craft?.(craftPlan.recipe, craftPlan.craftRuns, craftPlan.craftingTable);
    } catch (error) {
      return createCraftFailure({
        code: "runtime_craft_failed",
        message: getErrorMessage(error),
        worldKey: input.worldKey,
        details: { item_name: craftPlan.itemName, craft_runs: craftPlan.craftRuns },
      });
    }

    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        world_key: input.worldKey,
        completed_count: craftPlan.completedCount,
        item_name: craftPlan.itemName,
      }),
    });
  }

  return createCraftFailure({
    code: craftPlan.code,
    message: craftPlan.message,
    worldKey: input.worldKey,
    ...(craftPlan.details === undefined ? {} : { details: craftPlan.details }),
  });
}

async function craftMissingMaterials(input: {
  readonly bot: MineflayerBotHandle;
  readonly candidates: readonly { readonly itemName: string; readonly itemId: number }[];
  readonly count: number;
  readonly craftingTable: MineflayerBlockHandle | null;
  readonly worldKey: string | null;
  readonly craftingTableCache?: CraftingTablePlacementCache;
  readonly depth: number;
  readonly visited: Set<string>;
  readonly targetName: string;
}): Promise<CraftTransportResult | { readonly ok: true }> {
  const recipe = selectRepresentativeRecipe({
    bot: input.bot,
    candidates: input.candidates,
    count: input.count,
    craftingTable: input.craftingTable,
  });

  if (recipe === null) {
    return { ok: true as const };
  }

  const missingMaterials = createMissingMaterialDetails(input.bot, recipe, input.count);
  const visited = new Set(input.visited);
  visited.add(input.targetName);

  for (const material of missingMaterials) {
    const itemName = typeof material.item_name === "string" ? material.item_name : null;
    const missing = typeof material.missing === "number" ? material.missing : 0;
    if (itemName === null || missing <= 0) {
      continue;
    }

    const result = await executeMineflayerCraftInternal({
      bot: input.bot,
      params: { itemName, count: missing },
      worldKey: input.worldKey,
      ...(input.craftingTableCache === undefined
        ? {}
        : { craftingTableCache: input.craftingTableCache }),
      depth: input.depth + 1,
      visited,
      allowIntermediateTarget: true,
    });

    if (!result.ok) {
      if (isWoodenRepairMaterial(input.bot.registry, itemName)) {
        const genericPlanksResult = await executeMineflayerCraftInternal({
          bot: input.bot,
          params: { itemName: "planks", count: missing },
          worldKey: input.worldKey,
          ...(input.craftingTableCache === undefined
            ? {}
            : { craftingTableCache: input.craftingTableCache }),
          depth: input.depth + 1,
          visited,
          allowIntermediateTarget: true,
        });

        if (genericPlanksResult.ok) {
          continue;
        }
      }

      if (result.error.code === "recipe_not_found") {
        return createCraftFailure({
          code: "missing_materials",
          message: "Inventory does not contain enough recipe ingredients",
          worldKey: input.worldKey,
          details: {
            target_item_name: input.targetName,
            missing_item_name: itemName,
            missing,
          },
        });
      }

      return result;
    }
  }

  return { ok: true as const };
}

function isWoodenRepairMaterial(registry: unknown, itemName: string): boolean {
  const registryFacts = registry as MineflayerRegistryFacts | undefined;
  const repairItems = registryFacts?.itemsByName?.wooden_pickaxe?.repairWith ?? [];

  return repairItems.includes(itemName);
}

function selectRepresentativeRecipe(input: {
  readonly bot: MineflayerBotHandle;
  readonly candidates: readonly { readonly itemName: string; readonly itemId: number }[];
  readonly count: number;
  readonly craftingTable: MineflayerBlockHandle | null;
}): MineflayerRecipeHandle | null {
  for (const candidate of input.candidates) {
    const tableReadyRecipe = input.bot.recipesFor?.(candidate.itemId, null, input.count, true)[0];
    const allRecipe = input.bot.recipesAll?.(candidate.itemId, null, true)[0];
    const currentTableRecipe = input.bot.recipesFor?.(
      candidate.itemId,
      null,
      input.count,
      input.craftingTable,
    )[0];
    const recipe = currentTableRecipe ?? tableReadyRecipe ?? allRecipe;
    if (recipe !== undefined) {
      return recipe;
    }
  }

  return null;
}

function validateCraftingCapabilities(
  bot: MineflayerBotHandle,
  worldKey: string | null,
): CraftTransportResult | null {
  if (bot.inventory === undefined || typeof bot.inventory.items !== "function") {
    return createCraftFailure({
      code: "runtime_craft_failed",
      message: "Mineflayer bot handle does not expose inventory for craft",
      worldKey,
    });
  }

  if (
    typeof bot.recipesFor !== "function" ||
    typeof bot.recipesAll !== "function" ||
    typeof bot.craft !== "function"
  ) {
    return createCraftFailure({
      code: "runtime_craft_failed",
      message: "Mineflayer bot handle does not expose recipe/craft API",
      worldKey,
    });
  }

  return null;
}

function resolveCraftTargetCandidates(
  registry: unknown,
  itemName: string,
): readonly { readonly itemName: string; readonly itemId: number }[] {
  const registryFacts = registry as MineflayerRegistryFacts | undefined;
  const normalized = normalizeCraftName(itemName);

  if (normalized === "planks") {
    const woodenPickaxe = registryFacts?.itemsByName?.wooden_pickaxe;
    const repairItems = woodenPickaxe?.repairWith ?? [];

    return Object.freeze(
      repairItems.flatMap((candidateName) => {
        const item = registryFacts?.itemsByName?.[candidateName];
        return item === undefined ? [] : [{ itemName: candidateName, itemId: item.id }];
      }),
    );
  }

  const item = registryFacts?.itemsByName?.[normalized];

  return item === undefined
    ? Object.freeze([])
    : Object.freeze([{ itemName: normalized, itemId: item.id }]);
}

type CraftPlan =
  | {
      readonly status: "ready";
      readonly itemName: string;
      readonly recipe: MineflayerRecipeHandle;
      readonly craftRuns: number;
      readonly craftingTable?: MineflayerBlockHandle;
      readonly completedCount: number;
    }
  | {
      readonly status: "failed";
      readonly code: ToolchainFailureCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

function selectCraftPlan(input: {
  readonly bot: MineflayerBotHandle;
  readonly candidates: readonly { readonly itemName: string; readonly itemId: number }[];
  readonly count: number;
  readonly craftingTable: MineflayerBlockHandle | null;
}): CraftPlan {
  let sawRecipe = false;
  let sawTableRecipeWithMaterials = false;
  const missingMaterialDetails: Record<string, unknown>[] = [];

  for (const candidate of input.candidates) {
    const recipesWithCurrentTable =
      input.bot.recipesFor?.(candidate.itemId, null, input.count, input.craftingTable) ?? [];
    const readyRecipe = recipesWithCurrentTable[0];

    if (readyRecipe !== undefined) {
      const craftRuns = calculateCraftRuns(readyRecipe, input.count);

      return {
        status: "ready",
        itemName: candidate.itemName,
        recipe: readyRecipe,
        craftRuns,
        ...(readyRecipe.requiresTable === true && input.craftingTable !== null
          ? { craftingTable: input.craftingTable }
          : {}),
        completedCount: craftRuns * Math.max(1, readyRecipe.result.count),
      };
    }

    const allRecipes = input.bot.recipesAll?.(candidate.itemId, null, true) ?? [];
    sawRecipe = sawRecipe || allRecipes.length > 0;
    const tableReadyRecipe = input.bot.recipesFor?.(candidate.itemId, null, input.count, true)[0];

    if (input.craftingTable === null && tableReadyRecipe?.requiresTable === true) {
      sawTableRecipeWithMaterials = true;
    }

    const representativeRecipe = tableReadyRecipe ?? allRecipes[0];
    if (representativeRecipe !== undefined) {
      missingMaterialDetails.push({
        item_name: candidate.itemName,
        missing: createMissingMaterialDetails(input.bot, representativeRecipe, input.count),
      });
    }
  }

  if (!sawRecipe) {
    return {
      status: "failed",
      code: "recipe_not_found",
      message: "No recipe exists for requested craft target",
      details: { candidates: input.candidates.map((candidate) => candidate.itemName) },
    };
  }

  if (sawTableRecipeWithMaterials) {
    return {
      status: "failed",
      code: "missing_crafting_table",
      message: "Craft target requires a nearby crafting table",
      details: { search_radius: CRAFTING_TABLE_SEARCH_RADIUS },
    };
  }

  return {
    status: "failed",
    code: "missing_materials",
    message: "Inventory does not contain enough recipe ingredients",
    details: { candidates: missingMaterialDetails },
  };
}

async function findNearbyCraftingTable(
  bot: MineflayerBotHandle,
  cache: CraftingTablePlacementCache | undefined,
): Promise<MineflayerBlockHandle | null> {
  if (cache?.position !== undefined && cache.position !== null) {
    const cachedBlock = readMineflayerBlockAt(bot, cache.position);
    if (isCraftingTableBlock(bot.registry, cachedBlock)) {
      return cachedBlock;
    }

    cache.position = null;
  }

  if (typeof bot.findBlocks !== "function" || typeof bot.blockAt !== "function") {
    return null;
  }

  const craftingTableFact = (bot.registry as MineflayerRegistryFacts | undefined)?.blocksByName
    ?.crafting_table;

  if (craftingTableFact === undefined) {
    return null;
  }

  const positions = await bot.findBlocks({
    matching: (block) =>
      block.type === craftingTableFact.id || isCraftingTableBlock(bot.registry, block),
    maxDistance: CRAFTING_TABLE_SEARCH_RADIUS,
    count: 1,
  });
  const firstPosition = positions[0];

  return firstPosition === undefined ? null : (bot.blockAt(firstPosition) ?? null);
}

function calculateCraftRuns(recipe: MineflayerRecipeHandle, requestedCount: number): number {
  return Math.max(1, Math.ceil(requestedCount / Math.max(1, recipe.result.count)));
}

function createMissingMaterialDetails(
  bot: MineflayerInventoryPort & { readonly registry?: unknown },
  recipe: MineflayerRecipeHandle,
  requestedCount: number,
): readonly Readonly<Record<string, unknown>>[] {
  const craftRuns = calculateCraftRuns(recipe, requestedCount);
  const inventoryItems = bot.inventory?.items() ?? [];

  return Object.freeze(
    (recipe.delta ?? [])
      .filter((delta) => delta.count < 0)
      .map((delta) => {
        const required = Math.abs(delta.count) * craftRuns;
        const available = countInventoryItemById(inventoryItems, delta.id);

        return Object.freeze({
          item_id: delta.id,
          item_name: readRegistryItemName(bot.registry, delta.id),
          required,
          available,
          missing: Math.max(0, required - available),
        });
      })
      .filter((item) => item.missing > 0),
  );
}

function countInventoryItemById(items: readonly MineflayerItemHandle[], itemId: number): number {
  return items.reduce((sum, item) => sum + (item.type === itemId ? (item.count ?? 0) : 0), 0);
}

function readRegistryItemName(registry: unknown, itemId: number): string | null {
  const item = (registry as MineflayerRegistryFacts | undefined)?.items?.[String(itemId)];

  return item?.name ?? null;
}

function createCraftFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}): CraftTransportResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: input.code,
      message: input.message,
      world_key: input.worldKey,
      ...(input.details === undefined ? {} : { details: Object.freeze({ ...input.details }) }),
    }),
  });
}

function normalizeCraftName(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function isPhase1CraftAllowed(itemName: string): boolean {
  return (PHASE1_CRAFT_ALLOWLIST as readonly string[]).includes(itemName);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
