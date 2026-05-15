import type {
  EnsureCondition,
  EnsureConditionEvaluation,
  EnsureConditionStateSnapshot,
  ToolchainEnsureFacts,
  ToolchainEnsureInventoryItem,
} from "../../core-ports/skills.js";
import { normalizeMinecraftName, normalizeOptionalName } from "./failure-attribution.js";
import type { ResolverContext } from "./types.js";

/** 用真实快照和 facts（事实端口） 评估 ensure（确保） 条件。 */
export function evaluateEnsureCondition(input: {
  readonly condition: EnsureCondition;
  readonly baseline: EnsureConditionStateSnapshot;
  readonly current: EnsureConditionStateSnapshot;
  readonly facts: Pick<
    ToolchainEnsureFacts,
    "resolveBlockDropItemNames" | "countInventoryItemsByTag"
  >;
}): EnsureConditionEvaluation {
  const baseline = normalizeConditionSnapshot(input.baseline);
  const current = normalizeConditionSnapshot(input.current);
  const condition = input.condition;

  if (condition.kind === "gained") {
    const itemName = normalizeMinecraftName(condition.itemName);
    const completed = Math.max(
      0,
      countInventoryItem(current.inventory, itemName) -
        countInventoryItem(baseline.inventory, itemName),
    );
    return createConditionEvaluation({
      condition,
      baseline,
      current,
      completed,
      target: condition.count,
      resolvedTargets: [itemName],
    });
  }

  if (condition.kind === "has") {
    const itemName = normalizeMinecraftName(condition.itemName);
    const completed = countInventoryItem(current.inventory, itemName);
    return createConditionEvaluation({
      condition,
      baseline,
      current,
      completed,
      target: condition.count,
      resolvedTargets: [itemName],
    });
  }

  if (condition.kind === "equipped") {
    const itemName = normalizeMinecraftName(condition.itemName);
    const completed = normalizeOptionalName(current.main_hand_item_name) === itemName ? 1 : 0;
    return createConditionEvaluation({
      condition,
      baseline,
      current,
      completed,
      target: 1,
      resolvedTargets: [itemName],
    });
  }

  if (condition.kind === "placed") {
    const blockName = normalizeMinecraftName(condition.blockName);
    const completed = (current.nearby_block_names ?? []).some(
      (candidate) => normalizeMinecraftName(candidate) === blockName,
    )
      ? 1
      : 0;
    return createConditionEvaluation({
      condition,
      baseline,
      current,
      completed,
      target: 1,
      resolvedTargets: [blockName],
    });
  }

  if (condition.kind === "gainedDropOf") {
    const dropNames = input.facts
      .resolveBlockDropItemNames({ blockName: condition.blockName })
      .map(normalizeMinecraftName);
    const targets =
      dropNames.length > 0 ? dropNames : [normalizeMinecraftName(condition.blockName)];
    const completed = Math.max(
      0,
      countInventoryItemsByNames(current.inventory, targets) -
        countInventoryItemsByNames(baseline.inventory, targets),
    );
    return createConditionEvaluation({
      condition,
      baseline,
      current,
      completed,
      target: condition.count,
      resolvedTargets: targets,
    });
  }

  const completed = Math.max(
    0,
    input.facts.countInventoryItemsByTag({
      tagName: condition.tagName,
      inventory: current.inventory,
    }) -
      input.facts.countInventoryItemsByTag({
        tagName: condition.tagName,
        inventory: baseline.inventory,
      }),
  );
  return createConditionEvaluation({
    condition,
    baseline,
    current,
    completed,
    target: condition.count,
    resolvedTargets: [normalizeMinecraftName(condition.tagName)],
  });
}

export function readInventoryItems(
  context: ResolverContext,
): readonly ToolchainEnsureInventoryItem[] {
  return context.dependencies.inventory.readInventoryItems().map((item) =>
    Object.freeze({
      item_name: normalizeMinecraftName(item.item_name),
      count: item.count,
    }),
  );
}

export function countInventoryItem(
  items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  itemName: string,
): number {
  const expected = normalizeMinecraftName(itemName);
  return items.reduce(
    (sum, item) => (normalizeMinecraftName(item.item_name) === expected ? sum + item.count : sum),
    0,
  );
}

function normalizeConditionSnapshot(
  snapshot: EnsureConditionStateSnapshot,
): EnsureConditionStateSnapshot {
  return Object.freeze({
    world_key: snapshot.world_key ?? null,
    inventory: Object.freeze(
      snapshot.inventory.map((item) =>
        Object.freeze({
          item_name: normalizeMinecraftName(item.item_name),
          count: Math.max(0, Math.trunc(item.count)),
        }),
      ),
    ),
    ...(snapshot.main_hand_item_name === undefined
      ? {}
      : { main_hand_item_name: normalizeOptionalName(snapshot.main_hand_item_name) }),
    ...(snapshot.nearby_block_names === undefined
      ? {}
      : {
          nearby_block_names: Object.freeze(
            snapshot.nearby_block_names.map(normalizeMinecraftName),
          ),
        }),
  });
}

function countInventoryItemsByNames(
  items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  itemNames: readonly string[],
): number {
  const targets = new Set(itemNames.map(normalizeMinecraftName));
  return items.reduce(
    (sum, item) => (targets.has(normalizeMinecraftName(item.item_name)) ? sum + item.count : sum),
    0,
  );
}

function createConditionEvaluation(input: {
  readonly condition: EnsureCondition;
  readonly baseline: EnsureConditionStateSnapshot;
  readonly current: EnsureConditionStateSnapshot;
  readonly completed: number;
  readonly target: number;
  readonly resolvedTargets: readonly string[];
}): EnsureConditionEvaluation {
  const completed = Math.max(0, Math.trunc(input.completed));
  const target = Math.max(1, Math.trunc(input.target));
  return Object.freeze({
    ok: completed >= target,
    condition: input.condition,
    completed_count: completed,
    target_count: target,
    missing_count: Math.max(0, target - completed),
    resolved_targets: Object.freeze(input.resolvedTargets.map(normalizeMinecraftName)),
    baseline: input.baseline,
    current: input.current,
  });
}
