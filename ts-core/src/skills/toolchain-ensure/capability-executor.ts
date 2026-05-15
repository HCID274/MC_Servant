import type { ToolchainActionSummary, ToolchainMaterialSource } from "../../core-ports/skills.js";
import { countInventoryItem, readInventoryItems } from "./condition-checker.js";
import {
  classifySkillFailure,
  createActionSummary,
  createEnsureFailure,
  createEnsureFailureFromToolchain,
  createEnsureSuccess,
  getErrorMessage,
  readCurrentWorldKey,
  readSkillWorldKey,
  readWorldKeyFromActions,
} from "./failure-attribution.js";
import {
  type RecoveryPlan,
  planCraftFailureRecovery,
  planMissingItemRecovery,
} from "./recovery-planner.js";
import {
  DEPENDENCY_COLLECT_RADIUS,
  DEPENDENCY_RETRY_LIMIT,
  type EnsureResult,
  type ResolverContext,
} from "./types.js";

export async function executeRecoveryPlan(
  context: ResolverContext,
  plan: RecoveryPlan,
  _params: Readonly<import("../../core-ports/skills.js").EnsureDependencyParams>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  switch (plan.kind) {
    case "mine_equipment_preflight":
      return plan.requiredTool === null
        ? createEnsureSuccess({
            completedCount: 0,
            targetCount: 0,
            actions,
            worldKey: readCurrentWorldKey(context.dependencies),
            ...(plan.blockName === undefined ? {} : { blockName: plan.blockName }),
          })
        : equipItemWithLocalRecovery(context, plan.requiredTool, actions);
    case "equip_item":
      return equipItemWithLocalRecovery(context, plan.itemName, actions);
    case "ensure_crafting_table":
      return ensureCraftingTablePlaced(context, actions);
    case "recover_missing_materials":
      return recoverMissingMaterials(context, plan.missingItems, actions);
    case "provide_item":
      return provideMaterial(context, plan.itemName, plan.targetCount, actions);
    case "mine_block_drop":
      return provideBlockDropByMining(context, plan.blockName, plan.missingCount, actions);
    case "place_block": {
      const placed = await callToolchain({
        action: "place",
        target: plan.blockName,
        requestedCount: 1,
        actions,
        run: () => context.dependencies.place({ blockName: plan.blockName }, context.control),
      });
      return placed.ok ? placed.result : placed.failure;
    }
    case "unrecoverable":
      return createEnsureFailure({
        code: plan.code,
        message: plan.message,
        worldKey: readCurrentWorldKey(context.dependencies),
        actions,
        details: plan.details,
      });
  }
}

async function recoverMissingMaterials(
  context: ResolverContext,
  missingItems: readonly Readonly<{ readonly itemName: string; readonly missing: number }>[],
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  for (const missingItem of missingItems) {
    const recovered = await recoverMissingItem(context, missingItem, actions);
    if (!recovered.ok) {
      return recovered;
    }
  }

  return createEnsureSuccess({
    completedCount: missingItems.length,
    actions,
    worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
  });
}

async function equipItemWithLocalRecovery(
  context: ResolverContext,
  itemName: string,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  if (countInventoryItem(context.dependencies.inventory.readInventoryItems(), itemName) <= 0) {
    const crafted = await craftWithLocalRecovery(context, itemName, actions);
    if (!crafted.ok) {
      return crafted.failure;
    }
  }

  const equipped = await callSkill({
    action: "equip",
    target: itemName,
    requestedCount: 1,
    actions,
    run: () => context.dependencies.equip({ itemName, destination: "hand" }, context.control),
  });

  return equipped.ok
    ? createEnsureSuccess({
        itemName,
        completedCount: 1,
        targetCount: 1,
        actions,
        worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
      })
    : equipped.failure;
}

async function craftWithLocalRecovery(
  context: ResolverContext,
  target: string,
  actions: ToolchainActionSummary[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: EnsureResult }> {
  for (let attempt = 0; attempt < DEPENDENCY_RETRY_LIMIT; attempt += 1) {
    const crafted = await callToolchain({
      action: "craft",
      target,
      requestedCount: 1,
      actions,
      run: () => context.dependencies.craft({ itemName: target, count: 1 }, context.control),
    });
    if (crafted.ok) {
      return { ok: true as const };
    }

    const failurePlan = planCraftFailureRecovery(
      crafted.result.error.code,
      crafted.result.error.details,
    );
    if (failurePlan.kind === "ensure_crafting_table") {
      const table = await ensureCraftingTablePlaced(context, actions);
      if (!table.ok) {
        return { ok: false as const, failure: table };
      }
      continue;
    }

    if (failurePlan.kind === "recover_missing_materials") {
      const recovered = await recoverMissingMaterials(context, failurePlan.missingItems, actions);
      if (!recovered.ok) {
        return { ok: false as const, failure: recovered };
      }
      continue;
    }

    return { ok: false as const, failure: crafted.failure };
  }

  return {
    ok: false as const,
    failure: createEnsureFailure({
      code: "missing_materials",
      message: `ensure dependency retry limit reached for ${target}`,
      worldKey: readWorldKeyFromActions(actions),
      actions,
      details: { item_name: target, retry_limit: DEPENDENCY_RETRY_LIMIT },
    }),
  };
}

async function ensureCraftingTablePlaced(
  context: ResolverContext,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const blockName = context.dependencies.facts.resolveCraftingTableBlockName();
  if (blockName === null) {
    return createEnsureFailure({
      code: "missing_crafting_table",
      message: "ensure cannot resolve crafting table block from facts",
      worldKey: readCurrentWorldKey(context.dependencies),
      actions,
    });
  }

  if (countInventoryItem(readInventoryItems(context), blockName) <= 0) {
    const crafted = await callToolchain({
      action: "craft",
      target: blockName,
      requestedCount: 1,
      actions,
      run: () => context.dependencies.craft({ itemName: blockName, count: 1 }, context.control),
    });

    if (!crafted.ok) {
      if (crafted.result.error.code === "missing_crafting_table") {
        return createEnsureFailure({
          code: "crafting_table_required",
          message: "crafting table item cannot be crafted because a crafting table is required",
          worldKey: crafted.result.error.world_key,
          actions,
          details: {
            target_item_name: blockName,
            failure: crafted.result.error,
          },
        });
      }

      return crafted.failure;
    }
  }

  const placed = await callToolchain({
    action: "place",
    target: blockName,
    requestedCount: 1,
    actions,
    run: () => context.dependencies.place({ blockName }, context.control),
  });

  return placed.ok
    ? createEnsureSuccess({
        blockName,
        completedCount: 1,
        targetCount: 1,
        actions,
        worldKey: placed.result.data.world_key,
        ...(placed.result.data.position === undefined
          ? {}
          : { position: placed.result.data.position }),
      })
    : placed.failure;
}

async function recoverMissingItem(
  context: ResolverContext,
  missingItem: Readonly<{ readonly itemName: string; readonly missing: number }>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const plan = planMissingItemRecovery(context, missingItem);
  if (plan.kind === "craft_item") {
    const crafted = await craftWithLocalRecovery(context, plan.itemName, actions);
    if (!crafted.ok) {
      return crafted.failure;
    }

    const completedCount = countInventoryItem(readInventoryItems(context), plan.itemName);
    return createEnsureSuccess({
      itemName: plan.itemName,
      completedCount,
      targetCount: completedCount,
      actions,
      worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
    });
  }

  if (plan.kind === "missing_materials_unresolved") {
    return createEnsureFailure({
      code: "missing_materials",
      message: `ensure cannot resolve material source from facts: ${plan.itemName}`,
      worldKey: readCurrentWorldKey(context.dependencies),
      actions,
      details: {
        item_name: plan.itemName,
        target_count: plan.targetCount,
        completed_count: plan.completedCount,
      },
    });
  }

  return provideMaterialFromSource(context, plan.source, plan.targetCount, actions);
}

async function provideMaterial(
  context: ResolverContext,
  itemName: string,
  targetCount: number,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const before = countInventoryItem(readInventoryItems(context), itemName);
  if (before >= targetCount) {
    return createEnsureSuccess({
      itemName,
      completedCount: before,
      targetCount,
      actions,
      worldKey: readCurrentWorldKey(context.dependencies),
    });
  }

  const plan = planMissingItemRecovery(context, { itemName, missing: targetCount - before });
  if (plan.kind === "missing_materials_unresolved") {
    return createEnsureFailure({
      code: "missing_materials",
      message: `ensure cannot resolve material source from facts: ${itemName}`,
      worldKey: readCurrentWorldKey(context.dependencies),
      actions,
      details: { item_name: itemName, target_count: targetCount, completed_count: before },
    });
  }

  if (plan.kind === "craft_item") {
    const crafted = await craftWithLocalRecovery(context, itemName, actions);
    return crafted.ok
      ? createEnsureSuccess({
          itemName,
          completedCount: countInventoryItem(readInventoryItems(context), itemName),
          targetCount,
          actions,
          worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
        })
      : crafted.failure;
  }

  return provideMaterialFromSource(context, plan.source, targetCount, actions);
}

async function provideMaterialFromSource(
  context: ResolverContext,
  source: ToolchainMaterialSource,
  targetCount: number,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  return source.action === "mine"
    ? provideMaterialByMining(context, source, targetCount, actions)
    : provideMaterialByCutTree(context, source, targetCount, actions);
}

async function provideMaterialByMining(
  context: ResolverContext,
  source: Extract<ToolchainMaterialSource, { readonly action: "mine" }>,
  targetCount: number,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const before = countInventoryItem(readInventoryItems(context), source.itemName);
  const missing = targetCount - before;
  const requiredEquipment = context.dependencies.facts.resolveRequiredEquipment({
    failure: {
      action: "mine",
      params: { blockName: source.blockName, count: Math.max(1, missing) },
      code: "not_equipped",
      message: "not_equipped",
    },
    inventory: readInventoryItems(context),
  });
  if (requiredEquipment !== null) {
    const equipped = await equipItemWithLocalRecovery(context, requiredEquipment, actions);
    if (!equipped.ok) {
      return equipped;
    }
  }

  const mined = await callSkill({
    action: "mine",
    target: source.blockName,
    requestedCount: missing,
    actions,
    run: () =>
      context.dependencies.mine({ blockName: source.blockName, count: missing }, context.control),
  });
  if (!mined.ok) {
    return mined.failure;
  }

  const after = countInventoryItem(readInventoryItems(context), source.itemName);
  return after >= targetCount
    ? createEnsureSuccess({
        itemName: source.itemName,
        completedCount: after,
        targetCount,
        actions,
        worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
      })
    : createEnsureFailure({
        code: "drop_not_obtained",
        message: `ensure dependency did not reach material target: ${source.itemName}`,
        worldKey: readWorldKeyFromActions(actions),
        actions,
        details: {
          item_name: source.itemName,
          source_block_name: source.blockName,
          target_count: targetCount,
          completed_count: after,
        },
      });
}

async function provideBlockDropByMining(
  context: ResolverContext,
  blockName: string,
  missingCount: number,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const requiredEquipment = context.dependencies.facts.resolveRequiredEquipment({
    failure: {
      action: "mine",
      params: { blockName, count: Math.max(1, missingCount) },
      code: "not_equipped",
      message: "not_equipped",
    },
    inventory: readInventoryItems(context),
  });
  if (requiredEquipment !== null) {
    const equipped = await equipItemWithLocalRecovery(context, requiredEquipment, actions);
    if (!equipped.ok) {
      return equipped;
    }
  }

  const mined = await callSkill({
    action: "mine",
    target: blockName,
    requestedCount: Math.max(1, missingCount),
    actions,
    run: () =>
      context.dependencies.mine({ blockName, count: Math.max(1, missingCount) }, context.control),
  });

  return mined.ok
    ? createEnsureSuccess({
        blockName,
        completedCount: mined.completedCount,
        targetCount: Math.max(1, missingCount),
        actions,
        worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
      })
    : mined.failure;
}

async function provideMaterialByCutTree(
  context: ResolverContext,
  source: Extract<ToolchainMaterialSource, { readonly action: "cutTree" }>,
  targetCount: number,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const before = countInventoryItem(readInventoryItems(context), source.itemName);
  if (context.dependencies.cutTree === undefined) {
    return createEnsureFailure({
      code: "unsupported_capability",
      message: "cutTree dependency is not configured for material recovery",
      worldKey: readCurrentWorldKey(context.dependencies),
      actions,
      details: { item_name: source.itemName, target_count: targetCount, completed_count: before },
    });
  }

  const missing = targetCount - before;
  const cut = await callSkill({
    action: "cutTree",
    target: source.blockName ?? source.itemName,
    requestedCount: missing,
    actions,
    run: () =>
      context.dependencies.cutTree?.({ count: missing }, context.control) ?? Promise.reject(),
  });
  if (!cut.ok) {
    return cut.failure;
  }

  const collected = await callSkill({
    action: "collect",
    target: source.itemName,
    requestedCount: missing,
    actions,
    run: () => context.dependencies.collect({ radius: DEPENDENCY_COLLECT_RADIUS }, context.control),
  });
  if (!collected.ok) {
    return collected.failure;
  }

  const after = countInventoryItem(readInventoryItems(context), source.itemName);
  return after >= targetCount
    ? createEnsureSuccess({
        itemName: source.itemName,
        completedCount: after,
        targetCount,
        actions,
        worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
      })
    : createEnsureFailure({
        code: "resource_not_found",
        message: `ensure dependency did not reach material target: ${source.itemName}`,
        worldKey: readWorldKeyFromActions(actions),
        actions,
        details: { item_name: source.itemName, target_count: targetCount, completed_count: after },
      });
}

async function callToolchain(input: {
  readonly action: "craft" | "place";
  readonly target: string;
  readonly requestedCount: number;
  readonly actions: ToolchainActionSummary[];
  readonly run: () => Promise<EnsureResult>;
}): Promise<
  | { readonly ok: true; readonly result: EnsureResult & { readonly ok: true } }
  | {
      readonly ok: false;
      readonly result: EnsureResult & { readonly ok: false };
      readonly failure: EnsureResult;
    }
> {
  const result = await input.run();
  input.actions.push(
    createActionSummary({
      action: input.action,
      target: input.target,
      requestedCount: input.requestedCount,
      completedCount: result.ok ? result.data.completed_count : 0,
      status: result.ok ? "completed" : "failed",
      worldKey: result.ok ? result.data.world_key : result.error.world_key,
      ...(result.ok ? {} : { reason: result.error.code }),
    }),
  );

  return result.ok
    ? { ok: true as const, result }
    : {
        ok: false as const,
        result,
        failure: createEnsureFailureFromToolchain(result.error, input.actions),
      };
}

async function callSkill<TResult extends { readonly total_steps: number }>(input: {
  readonly action: "cutTree" | "collect" | "equip" | "mine";
  readonly target: string;
  readonly requestedCount: number;
  readonly actions: ToolchainActionSummary[];
  readonly run: () => Promise<TResult>;
}): Promise<
  | { readonly ok: true; readonly result: TResult; readonly completedCount: number }
  | { readonly ok: false; readonly failure: EnsureResult }
> {
  try {
    const result = await input.run();
    const worldKey = readSkillWorldKey(result);
    const proof = readSkillCompletionProof({
      action: input.action,
      target: input.target,
      requestedCount: input.requestedCount,
      result,
    });
    if (!proof.ok) {
      input.actions.push(
        createActionSummary({
          action: input.action,
          target: input.target,
          requestedCount: input.requestedCount,
          completedCount: 0,
          status: "failed",
          ...(worldKey === undefined ? {} : { worldKey }),
          reason: "unknown_completion",
        }),
      );

      return {
        ok: false as const,
        failure: createEnsureFailure({
          code: "unknown_completion",
          message: `${input.action} completed without required completion proof`,
          worldKey: worldKey ?? readWorldKeyFromActions(input.actions),
          actions: input.actions,
          details: proof.details,
        }),
      };
    }

    input.actions.push(
      createActionSummary({
        action: input.action,
        target: input.target,
        requestedCount: input.requestedCount,
        completedCount: proof.completedCount,
        status: "completed",
        ...(worldKey === undefined ? {} : { worldKey }),
      }),
    );

    return { ok: true as const, result, completedCount: proof.completedCount };
  } catch (error) {
    input.actions.push(
      createActionSummary({
        action: input.action,
        target: input.target,
        requestedCount: input.requestedCount,
        completedCount: 0,
        status: "failed",
        reason: classifySkillFailure(getErrorMessage(error)),
      }),
    );

    return {
      ok: false as const,
      failure: createEnsureFailure({
        code: classifySkillFailure(getErrorMessage(error)),
        message: getErrorMessage(error),
        worldKey: readWorldKeyFromActions(input.actions),
        actions: input.actions,
      }),
    };
  }
}

function readSkillCompletionProof(input: {
  readonly action: "cutTree" | "collect" | "equip" | "mine";
  readonly target: string;
  readonly requestedCount: number;
  readonly result: Readonly<Record<string, unknown>>;
}):
  | { readonly ok: true; readonly completedCount: number }
  | { readonly ok: false; readonly details: Readonly<Record<string, unknown>> } {
  if (input.action === "equip") {
    return input.result.status === "equipped"
      ? { ok: true as const, completedCount: 1 }
      : createUnknownCompletionProof(input, ["status:equipped"]);
  }

  if (input.action === "mine") {
    const collectedCount = readNonNegativeNumber(input.result.collected_count);
    const minedCount = readNonNegativeNumber(input.result.mined_count);
    return collectedCount !== null
      ? { ok: true as const, completedCount: collectedCount }
      : minedCount !== null
        ? { ok: true as const, completedCount: minedCount }
        : createUnknownCompletionProof(input, ["collected_count", "mined_count"]);
  }

  if (input.action === "cutTree") {
    const collectedCount = readNonNegativeNumber(input.result.collected_count);
    return collectedCount !== null
      ? { ok: true as const, completedCount: collectedCount }
      : createUnknownCompletionProof(input, ["collected_count"]);
  }

  const collected = input.result.collected;
  if (Array.isArray(collected)) {
    return {
      ok: true as const,
      completedCount: collected.reduce((sum, item) => sum + readCollectedItemCount(item), 0),
    };
  }

  return createUnknownCompletionProof(input, ["collected"]);
}

function createUnknownCompletionProof(
  input: {
    readonly action: "cutTree" | "collect" | "equip" | "mine";
    readonly target: string;
    readonly requestedCount: number;
    readonly result: Readonly<Record<string, unknown>>;
  },
  missingFields: readonly string[],
): {
  readonly ok: false;
  readonly details: Readonly<Record<string, unknown>>;
} {
  return {
    ok: false as const,
    details: Object.freeze({
      action: input.action,
      target: input.target,
      requested_count: input.requestedCount,
      missing_fields: Object.freeze([...missingFields]),
      result_summary: summarizeSkillResult(input.result),
    }),
  };
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readCollectedItemCount(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  const count = (value as Readonly<Record<string, unknown>>).count;
  return readNonNegativeNumber(count) ?? 0;
}

function summarizeSkillResult(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(typeof result.skill === "string" ? { skill: result.skill } : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.world_key === "string" ? { world_key: result.world_key } : {}),
    ...(typeof result.total_steps === "number" ? { total_steps: result.total_steps } : {}),
    ...(typeof result.collected_count === "number"
      ? { collected_count: result.collected_count }
      : {}),
    ...(typeof result.mined_count === "number" ? { mined_count: result.mined_count } : {}),
    ...(Array.isArray(result.collected) ? { collected_count_items: result.collected.length } : {}),
  });
}
