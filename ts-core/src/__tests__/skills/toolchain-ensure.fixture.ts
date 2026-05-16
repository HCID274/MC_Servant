import type { ToolchainCapabilityResult, ToolchainEnsureFacts } from "../../index.js";

export function addInventory(
  inventory: { item_name: string; count: number }[],
  itemName: string,
  count: number,
): void {
  const existing = inventory.find((item) => item.item_name === itemName);
  if (existing === undefined) {
    inventory.push({ item_name: itemName, count });
    return;
  }

  existing.count += count;
}

export function countInventory(
  inventory: readonly { readonly item_name: string; readonly count: number }[],
  itemName: string,
): number {
  return inventory.reduce((sum, item) => sum + (item.item_name === itemName ? item.count : 0), 0);
}

export function createConditionState(
  inventory: readonly { readonly item_name: string; readonly count: number }[],
) {
  return Object.freeze({
    world_key: "minecraft:overworld",
    inventory: Object.freeze(inventory.map((item) => Object.freeze({ ...item }))),
    main_hand_item_name: null,
    nearby_block_names: Object.freeze(["crafting_table"]),
  });
}

export function createFakeEnsureFacts(): ToolchainEnsureFacts {
  return Object.freeze({
    resolveRequiredEquipment({ failure, inventory }) {
      const blockName =
        typeof failure.params.blockName === "string" ? failure.params.blockName : "";
      if (blockName === "iron_ore") {
        return "stone_pickaxe";
      }
      if (blockName === "stone") {
        return inventory.some((item) => item.item_name === "stone_pickaxe" && item.count > 0)
          ? "stone_pickaxe"
          : "wooden_pickaxe";
      }
      return null;
    },
    resolveMaterialSource({ itemName }) {
      if (itemName === "cobblestone") {
        return { action: "mine", itemName: "cobblestone", blockName: "stone" };
      }
      if (itemName === "oak_log") {
        return { action: "cutTree", itemName: "oak_log", blockName: "oak_log" };
      }
      return null;
    },
    resolveMaterialRequirement({ itemName, missing, inventory }) {
      const source =
        itemName === "cobblestone"
          ? ({ action: "mine", itemName: "cobblestone", blockName: "stone" } as const)
          : itemName === "oak_log"
            ? ({ action: "cutTree", itemName: "oak_log", blockName: "oak_log" } as const)
            : null;
      if (source === null) {
        return null;
      }
      const acceptableItems =
        source.action === "cutTree" ? ["oak_log", "cherry_log", "birch_log"] : [itemName];
      const completedCount = inventory
        .filter((item) => acceptableItems.includes(item.item_name))
        .reduce((sum, item) => sum + item.count, 0);
      return {
        itemName,
        targetCount:
          source.action === "cutTree"
            ? Math.max(1, missing)
            : completedCount + Math.max(1, missing),
        acceptableItems,
        source,
      };
    },
    evaluateMaterialRequirement({ requirement, inventory }) {
      const matchedItems = inventory.filter((item) =>
        requirement.acceptableItems.includes(item.item_name),
      );
      const completedCount = matchedItems.reduce((sum, item) => sum + item.count, 0);
      return {
        ok: completedCount >= requirement.targetCount,
        completedCount,
        targetCount: requirement.targetCount,
        matchedItems,
      };
    },
    canCraft({ itemName }) {
      return ["oak_planks", "stick", "crafting_table", "wooden_pickaxe", "stone_pickaxe"].includes(
        itemName,
      );
    },
    resolveCraftingTableBlockName() {
      return "crafting_table";
    },
    resolveBlockDropItemNames({ blockName }) {
      return blockName === "stone" ? ["cobblestone"] : [blockName];
    },
    countInventoryItemsByTag({ tagName, inventory }) {
      if (tagName !== "logs") {
        return 0;
      }
      return inventory
        .filter((item) => item.item_name.endsWith("_log"))
        .reduce((sum, item) => sum + item.count, 0);
    },
  });
}

export function createMissingMaterialsFailure(
  targetItemName: string,
  missingItemName: string,
  missing: number,
): ToolchainCapabilityResult<{ readonly world_key: string | null }> {
  return {
    ok: false,
    error: {
      code: "missing_materials",
      message: "Inventory does not contain enough recipe ingredients",
      world_key: "minecraft:overworld",
      details: {
        target_item_name: targetItemName,
        missing_item_name: missingItemName,
        missing,
        candidates: [
          {
            item_name: targetItemName,
            missing: [
              {
                item_name: missingItemName,
                missing,
              },
            ],
          },
        ],
      },
    },
  };
}
