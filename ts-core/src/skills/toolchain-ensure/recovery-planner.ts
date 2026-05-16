import type {
  EnsureCondition,
  EnsureDependencyParams,
  ToolchainFailureCode,
  ToolchainMaterialRequirement,
  ToolchainMaterialSource,
} from "../../core-ports/skills.js";
import { countInventoryItem, readInventoryItems } from "./condition-checker.js";
import {
  normalizeFailureCode,
  normalizeMinecraftName,
  readPositiveInteger,
  readString,
} from "./failure-attribution.js";
import type { ResolverContext } from "./types.js";

export type MissingItemRequest = Readonly<{ readonly itemName: string; readonly missing: number }>;

export type RecoveryPlan =
  | Readonly<{
      readonly kind: "mine_equipment_preflight";
      readonly blockName?: string;
      readonly requiredTool: string | null;
    }>
  | Readonly<{ readonly kind: "equip_item"; readonly itemName: string }>
  | Readonly<{ readonly kind: "ensure_crafting_table" }>
  | Readonly<{
      readonly kind: "recover_missing_materials";
      readonly missingItems: readonly MissingItemRequest[];
    }>
  | ConditionGapRecoveryPlan
  | Readonly<{
      readonly kind: "unrecoverable";
      readonly code: ToolchainFailureCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    }>;

export type ConditionGapRecoveryPlan =
  | Readonly<{
      readonly kind: "provide_item";
      readonly itemName: string;
      readonly targetCount: number;
    }>
  | Readonly<{
      readonly kind: "mine_block_drop";
      readonly blockName: string;
      readonly missingCount: number;
    }>
  | Readonly<{ readonly kind: "equip_item"; readonly itemName: string }>
  | Readonly<{ readonly kind: "place_block"; readonly blockName: string }>;

export type MissingItemRecoveryPlan =
  | Readonly<{ readonly kind: "craft_item"; readonly itemName: string }>
  | Readonly<{
      readonly kind: "provide_material_requirement";
      readonly requirement: ToolchainMaterialRequirement;
    }>
  | Readonly<{
      readonly kind: "provide_material_source";
      readonly source: ToolchainMaterialSource;
      readonly targetCount: number;
    }>
  | Readonly<{
      readonly kind: "missing_materials_unresolved";
      readonly itemName: string;
      readonly completedCount: number;
      readonly targetCount: number;
    }>;

export type CraftFailureRecoveryPlan =
  | Readonly<{ readonly kind: "ensure_crafting_table" }>
  | Readonly<{
      readonly kind: "recover_missing_materials";
      readonly missingItems: readonly MissingItemRequest[];
    }>
  | Readonly<{ readonly kind: "propagate_failure" }>;

export function planRecovery(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
): RecoveryPlan {
  if (params.failure.code === "preflight_mine_equipment") {
    return planMineEquipmentPreflight(context, params);
  }

  if (params.failure.code === "not_equipped") {
    const tool = context.dependencies.facts.resolveRequiredEquipment({
      failure: params.failure,
      inventory: readInventoryItems(context),
    });
    return tool === null
      ? {
          kind: "unrecoverable",
          code: "not_equipped",
          message: "ensure cannot resolve required equipment from facts",
          details: { failure: params.failure, condition: params.condition },
        }
      : { kind: "equip_item", itemName: tool };
  }

  if (
    params.failure.code === "missing_crafting_table" ||
    params.failure.code === "missing_crafting_table_item"
  ) {
    return { kind: "ensure_crafting_table" };
  }

  if (params.failure.code === "missing_materials") {
    const missingItems = readMissingMaterialRequests(params.failure.details);
    if (missingItems.length > 0) {
      return { kind: "recover_missing_materials", missingItems };
    }
  }

  if (params.failure.code === "condition_not_met") {
    const conditionGapPlan = planConditionGapRecovery(
      context,
      params.condition,
      params.failure.details,
    );
    if (conditionGapPlan !== null) {
      return conditionGapPlan;
    }
  }

  return {
    kind: "unrecoverable",
    code: normalizeFailureCode(params.failure.code),
    message: `ensure cannot recover failure: ${params.failure.message}`,
    details: { failure: params.failure, condition: params.condition },
  };
}

export function planMissingItemRecovery(
  context: ResolverContext,
  missingItem: MissingItemRequest,
): MissingItemRecoveryPlan {
  if (context.dependencies.facts.canCraft({ itemName: missingItem.itemName })) {
    return { kind: "craft_item", itemName: missingItem.itemName };
  }

  const currentCount = countInventoryItem(readInventoryItems(context), missingItem.itemName);
  const targetCount = currentCount + missingItem.missing;
  const requirement = context.dependencies.facts.resolveMaterialRequirement({
    itemName: missingItem.itemName,
    missing: missingItem.missing,
    inventory: readInventoryItems(context),
  });
  if (requirement !== null) {
    return { kind: "provide_material_requirement", requirement };
  }

  const source = context.dependencies.facts.resolveMaterialSource({
    itemName: missingItem.itemName,
  });
  return source === null
    ? {
        kind: "missing_materials_unresolved",
        itemName: missingItem.itemName,
        completedCount: currentCount,
        targetCount,
      }
    : { kind: "provide_material_source", source, targetCount };
}

export function planCraftFailureRecovery(
  failureCode: string,
  details: Readonly<Record<string, unknown>> | undefined,
): CraftFailureRecoveryPlan {
  if (failureCode === "missing_crafting_table") {
    return { kind: "ensure_crafting_table" };
  }

  if (failureCode === "missing_materials") {
    const missingItems = readMissingMaterialRequests(details);
    return missingItems.length === 0
      ? { kind: "propagate_failure" }
      : { kind: "recover_missing_materials", missingItems };
  }

  return { kind: "propagate_failure" };
}

export function readMissingMaterialRequests(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly MissingItemRequest[] {
  if (details === undefined) {
    return Object.freeze([]);
  }

  const collected = new Map<string, number>();
  collectMissingMaterialRequests(details, collected);

  return Object.freeze(
    [...collected.entries()].map(([itemName, missing]) => Object.freeze({ itemName, missing })),
  );
}

function planMineEquipmentPreflight(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
): RecoveryPlan {
  if (params.condition.kind !== "gainedDropOf") {
    return { kind: "mine_equipment_preflight", requiredTool: null };
  }

  const blockName = normalizeMinecraftName(params.condition.blockName);
  const count =
    readPositiveInteger(params.failure.params.count) ??
    readPositiveInteger(params.condition.count) ??
    1;
  const tool = context.dependencies.facts.resolveRequiredEquipment({
    failure: {
      action: "mine",
      params: { blockName, count },
      code: "not_equipped",
      message: "ensure preflight mine equipment",
    },
    inventory: readInventoryItems(context),
  });

  return { kind: "mine_equipment_preflight", blockName, requiredTool: tool };
}

function planConditionGapRecovery(
  context: ResolverContext,
  condition: EnsureCondition,
  details: Readonly<Record<string, unknown>> | undefined,
): ConditionGapRecoveryPlan | null {
  const missing = readPositiveInteger(details?.missing_count) ?? 1;

  if (condition.kind === "gained" || condition.kind === "has") {
    const itemName = normalizeMinecraftName(condition.itemName);
    const current = countInventoryItem(readInventoryItems(context), itemName);
    const targetCount = condition.kind === "has" ? condition.count : current + missing;
    return { kind: "provide_item", itemName, targetCount };
  }

  if (condition.kind === "gainedDropOf") {
    return {
      kind: "mine_block_drop",
      blockName: normalizeMinecraftName(condition.blockName),
      missingCount: missing,
    };
  }

  if (condition.kind === "equipped") {
    return { kind: "equip_item", itemName: normalizeMinecraftName(condition.itemName) };
  }

  if (condition.kind === "placed") {
    return { kind: "place_block", blockName: normalizeMinecraftName(condition.blockName) };
  }

  return null;
}

function collectMissingMaterialRequests(value: unknown, output: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMissingMaterialRequests(item, output);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const direct = readString(record.missing_item_name) ?? readString(record.item_name);
  if (direct !== null && typeof record.missing === "number" && record.missing > 0) {
    const itemName = normalizeMinecraftName(direct);
    output.set(itemName, (output.get(itemName) ?? 0) + Math.ceil(record.missing));
    return;
  }

  for (const nested of Object.values(record)) {
    collectMissingMaterialRequests(nested, output);
  }
}
