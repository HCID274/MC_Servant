import type {
  CollectSkillAdapter,
  CraftToolchainAdapter,
  CutTreeSkillAdapter,
  EnsureCondition,
  EnsureConditionEvaluation,
  EnsureConditionStateSnapshot,
  EnsureDependencyParams,
  EquipSkillAdapter,
  MineSkillAdapter,
  PlaceToolchainAdapter,
  SkillExecutionControl,
  ToolchainActionSummary,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainEnsureFacts,
  ToolchainEnsureInventoryItem,
  ToolchainFailure,
  ToolchainFailureCode,
  ToolchainMaterialSource,
} from "../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../core-ports/skills.js";

const DEPENDENCY_COLLECT_RADIUS = 8;
const DEPENDENCY_RETRY_LIMIT = 3;

type EnsureResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** ToolchainEnsure（工具链确保） 背包只读端口。 */
export interface ToolchainEnsureInventoryReader {
  /** 读取当前背包物品快照。 */
  readInventoryItems(): readonly Readonly<{ readonly item_name: string; readonly count: number }>[];
  /** 按运行时事实/测试注入的语义统计原木数量。 */
  countLogs?(
    items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  ): number;
}

/** ToolchainEnsure（工具链确保） 依赖集合；只能组合底层通用能力。 */
export interface ToolchainEnsureDependencies {
  readonly inventory: ToolchainEnsureInventoryReader;
  readonly facts: ToolchainEnsureFacts;
  /** 读取当前世界键；由 runtime（运行时） 既有世界键端口注入。 */
  readonly readCurrentWorldKey?: () => string | null;
  readonly craft: CraftToolchainAdapter["craft"];
  readonly place: PlaceToolchainAdapter["place"];
  readonly equip: EquipSkillAdapter["equip"];
  readonly mine: MineSkillAdapter["mine"];
  readonly collect: CollectSkillAdapter["collect"];
  readonly cutTree?: CutTreeSkillAdapter["cutTree"];
}

/** 通用 ensure（确保） 依赖解析器。 */
export interface ToolchainEnsureExecutor {
  readonly ensureDependency: (
    params: Readonly<EnsureDependencyParams>,
    control: SkillExecutionControl,
  ) => Promise<EnsureResult>;
}

/** 创建工具链 ensure（确保） 解析器；只根据结构化失败补局部依赖，不直接操作 runtime（运行时）。 */
export function createToolchainEnsureExecutor(
  dependencies: ToolchainEnsureDependencies,
): ToolchainEnsureExecutor {
  return Object.freeze({
    async ensureDependency(
      params: Readonly<EnsureDependencyParams>,
      control: SkillExecutionControl = NOOP_SKILL_EXECUTION_CONTROL,
    ) {
      const context: ResolverContext = { dependencies, control };
      return resolveDependency(context, params);
    },
  });
}

interface ResolverContext {
  readonly dependencies: ToolchainEnsureDependencies;
  readonly control: SkillExecutionControl;
}

async function resolveDependency(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
): Promise<EnsureResult> {
  context.control.throwIfAborted();
  const actions: ToolchainActionSummary[] = [];

  if (params.failure.code === "preflight_mine_equipment") {
    return ensureMineEquipmentBeforeAction(context, params, actions);
  }

  if (params.failure.code === "not_equipped") {
    const tool = context.dependencies.facts.resolveRequiredEquipment({
      failure: params.failure,
      inventory: readInventoryItems(context),
    });
    return tool === null
      ? createEnsureFailure({
          code: "not_equipped",
          message: "ensure cannot resolve required equipment from facts",
          worldKey: readCurrentWorldKey(context.dependencies),
          actions,
          details: { failure: params.failure, condition: params.condition },
        })
      : equipItemWithLocalRecovery(context, tool, actions);
  }

  if (params.failure.code === "missing_crafting_table") {
    return placeCraftingTable(context, actions);
  }

  if (params.failure.code === "missing_materials") {
    const recovered = await recoverMissingMaterials(context, params, actions);
    if (recovered !== null) {
      return recovered;
    }
  }

  if (params.failure.code === "condition_not_met") {
    const recovered = await recoverConditionGap(context, params, actions);
    if (recovered !== null) {
      return recovered;
    }
  }

  return createEnsureFailure({
    code: normalizeFailureCode(params.failure.code),
    message: `ensure cannot recover failure: ${params.failure.message}`,
    worldKey: readCurrentWorldKey(context.dependencies),
    actions,
    details: { failure: params.failure, condition: params.condition },
  });
}

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

async function ensureMineEquipmentBeforeAction(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  if (params.condition.kind !== "gainedDropOf") {
    return createEnsureSuccess({
      completedCount: 0,
      targetCount: 0,
      actions,
      worldKey: readCurrentWorldKey(context.dependencies),
    });
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

  return tool === null
    ? createEnsureSuccess({
        blockName,
        completedCount: 0,
        targetCount: 0,
        actions,
        worldKey: readCurrentWorldKey(context.dependencies),
      })
    : equipItemWithLocalRecovery(context, tool, actions);
}

async function recoverConditionGap(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult | null> {
  const missing = readPositiveInteger(params.failure.details?.missing_count) ?? 1;

  if (params.condition.kind === "gained" || params.condition.kind === "has") {
    const itemName = normalizeMinecraftName(params.condition.itemName);
    const current = countInventoryItem(readInventoryItems(context), itemName);
    const targetCount =
      params.condition.kind === "has" ? params.condition.count : current + missing;
    return provideMaterial(context, itemName, targetCount, actions);
  }

  if (params.condition.kind === "gainedDropOf") {
    const blockName = normalizeMinecraftName(params.condition.blockName);
    return provideBlockDropByMining(context, blockName, missing, actions);
  }

  if (params.condition.kind === "equipped") {
    return equipItemWithLocalRecovery(
      context,
      normalizeMinecraftName(params.condition.itemName),
      actions,
    );
  }

  if (params.condition.kind === "placed") {
    const blockName = normalizeMinecraftName(params.condition.blockName);
    const placed = await callToolchain({
      action: "place",
      target: blockName,
      requestedCount: 1,
      actions,
      run: () => context.dependencies.place({ blockName }, context.control),
    });
    return placed.ok ? placed.result : placed.failure;
  }

  return null;
}

async function recoverMissingMaterials(
  context: ResolverContext,
  params: Readonly<EnsureDependencyParams>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult | null> {
  const missingItems = readMissingMaterialRequests(params.failure.details);
  if (missingItems.length === 0) {
    return null;
  }

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

    if (crafted.result.error.code === "missing_crafting_table") {
      const table = await placeCraftingTable(context, actions);
      if (!table.ok) {
        return { ok: false as const, failure: table };
      }
      continue;
    }

    if (crafted.result.error.code === "missing_materials") {
      const recovered = await recoverMissingMaterialsFromDetails(
        context,
        crafted.result.error.details,
        actions,
      );
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

async function placeCraftingTable(
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

async function recoverMissingMaterialsFromDetails(
  context: ResolverContext,
  details: Readonly<Record<string, unknown>> | undefined,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  const missingItems = readMissingMaterialRequests(details);
  if (missingItems.length === 0) {
    return createEnsureFailure({
      code: "missing_materials",
      message: "missing_materials did not include recoverable material details",
      worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
      actions,
      ...(details === undefined ? {} : { details }),
    });
  }

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

async function recoverMissingItem(
  context: ResolverContext,
  missingItem: Readonly<{ readonly itemName: string; readonly missing: number }>,
  actions: ToolchainActionSummary[],
): Promise<EnsureResult> {
  if (context.dependencies.facts.canCraft({ itemName: missingItem.itemName })) {
    const crafted = await craftWithLocalRecovery(context, missingItem.itemName, actions);
    if (!crafted.ok) {
      return crafted.failure;
    }

    return createEnsureSuccess({
      itemName: missingItem.itemName,
      completedCount: countInventoryItem(readInventoryItems(context), missingItem.itemName),
      targetCount: countInventoryItem(readInventoryItems(context), missingItem.itemName),
      actions,
      worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(context.dependencies),
    });
  }

  const targetCount =
    countInventoryItem(readInventoryItems(context), missingItem.itemName) + missingItem.missing;
  return provideMaterial(context, missingItem.itemName, targetCount, actions);
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

  const source = context.dependencies.facts.resolveMaterialSource({ itemName });
  if (source === null) {
    return createEnsureFailure({
      code: "missing_materials",
      message: `ensure cannot resolve material source from facts: ${itemName}`,
      worldKey: readCurrentWorldKey(context.dependencies),
      actions,
      details: { item_name: itemName, target_count: targetCount, completed_count: before },
    });
  }

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
        completedCount: readSkillCompletedCount(mined.result),
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
  | { readonly ok: true; readonly result: TResult }
  | { readonly ok: false; readonly failure: EnsureResult }
> {
  try {
    const result = await input.run();
    const worldKey = readSkillWorldKey(result);
    input.actions.push(
      createActionSummary({
        action: input.action,
        target: input.target,
        requestedCount: input.requestedCount,
        completedCount: readSkillCompletedCount(result),
        status: "completed",
        ...(worldKey === undefined ? {} : { worldKey }),
      }),
    );

    return { ok: true as const, result };
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

function createEnsureSuccess(input: {
  readonly itemName?: string;
  readonly blockName?: string;
  readonly completedCount: number;
  readonly targetCount?: number;
  readonly actions: readonly ToolchainActionSummary[];
  readonly worldKey?: string | null;
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}): EnsureResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      world_key: input.worldKey ?? null,
      completed_count: input.completedCount,
      ...(input.targetCount === undefined ? {} : { target_count: input.targetCount }),
      ...(input.itemName === undefined ? {} : { item_name: input.itemName }),
      ...(input.blockName === undefined ? {} : { block_name: input.blockName }),
      ...(input.position === undefined ? {} : { position: input.position }),
      actions: freezeActions(input.actions),
    }),
  });
}

function createEnsureFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly actions: readonly ToolchainActionSummary[];
  readonly details?: Readonly<Record<string, unknown>>;
}): EnsureResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: input.code,
      message: input.message,
      world_key: input.worldKey,
      failure_stage: "ensure",
      details: Object.freeze({
        ...(input.details ?? {}),
        actions: freezeActions(input.actions),
      }),
    }),
  });
}

function createEnsureFailureFromToolchain(
  failure: ToolchainFailure,
  actions: readonly ToolchainActionSummary[],
): EnsureResult {
  return createEnsureFailure({
    code: failure.code,
    message: failure.message,
    worldKey: failure.world_key,
    actions,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  });
}

function createActionSummary(input: {
  readonly action: ToolchainActionSummary["action"];
  readonly target: string;
  readonly requestedCount: number;
  readonly completedCount: number;
  readonly status: ToolchainActionSummary["status"];
  readonly worldKey?: string | null;
  readonly reason?: string;
}): ToolchainActionSummary {
  return Object.freeze({
    action: input.action,
    target: input.target,
    requested_count: input.requestedCount,
    completed_count: input.completedCount,
    status: input.status,
    ...(input.worldKey === undefined ? {} : { world_key: input.worldKey }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

function freezeActions(
  actions: readonly ToolchainActionSummary[],
): readonly ToolchainActionSummary[] {
  return Object.freeze(actions.map((action) => Object.freeze({ ...action })));
}

function countLogs(reader: ToolchainEnsureInventoryReader): number {
  const items = reader.readInventoryItems();
  return reader.countLogs?.(items) ?? 0;
}

function readInventoryItems(context: ResolverContext): readonly ToolchainEnsureInventoryItem[] {
  return context.dependencies.inventory.readInventoryItems().map((item) =>
    Object.freeze({
      item_name: normalizeMinecraftName(item.item_name),
      count: item.count,
    }),
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

function countInventoryItem(
  items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  itemName: string,
): number {
  const expected = normalizeMinecraftName(itemName);
  return items.reduce(
    (sum, item) => (normalizeMinecraftName(item.item_name) === expected ? sum + item.count : sum),
    0,
  );
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

function readMissingMaterialRequests(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly Readonly<{ readonly itemName: string; readonly missing: number }>[] {
  if (details === undefined) {
    return Object.freeze([]);
  }

  const collected = new Map<string, number>();
  collectMissingMaterialRequests(details, collected);

  return Object.freeze(
    [...collected.entries()].map(([itemName, missing]) => Object.freeze({ itemName, missing })),
  );
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

function readSkillCompletedCount(result: {
  readonly total_steps: number;
  readonly collected_count?: unknown;
  readonly mined_count?: unknown;
}): number {
  if (typeof result.collected_count === "number") {
    return result.collected_count;
  }
  if (typeof result.mined_count === "number") {
    return result.mined_count;
  }

  return result.total_steps > 0 ? 1 : 0;
}

function readWorldKeyFromActions(actions: readonly ToolchainActionSummary[]): string | null {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const worldKey = actions[index]?.world_key;
    if (worldKey !== undefined && worldKey !== null) {
      return worldKey;
    }
  }

  return null;
}

function readCurrentWorldKey(dependencies: ToolchainEnsureDependencies): string | null {
  return dependencies.readCurrentWorldKey?.() ?? null;
}

function readSkillWorldKey(result: Record<string, unknown>): string | undefined {
  return typeof result.world_key === "string" ? result.world_key : undefined;
}

function classifySkillFailure(message: string): ToolchainFailureCode {
  if (message.includes("not_equipped")) {
    return "not_equipped";
  }
  if (message.includes("resource_not_found")) {
    return "resource_not_found";
  }
  if (message.includes("unsafe_path")) {
    return "unsafe_path";
  }
  if (message.includes("drop_not_obtained")) {
    return "drop_not_obtained";
  }
  if (message.includes("runtime_mine_failed")) {
    return "runtime_mine_failed";
  }

  return "unsupported_capability";
}

function normalizeFailureCode(code: string): ToolchainFailureCode {
  switch (code) {
    case "missing_materials":
    case "missing_crafting_table":
    case "crafting_table_unavailable":
    case "recipe_not_found":
    case "runtime_craft_failed":
    case "runtime_mine_failed":
    case "drop_not_obtained":
    case "missing_crafting_table_item":
    case "no_placeable_position":
    case "place_failed":
    case "cached_position_invalid":
    case "cannot_place":
    case "missing_item":
    case "runtime_equip_failed":
    case "not_equipped":
    case "resource_not_found":
    case "unsafe_path":
    case "unreachable_target":
    case "inventory_full":
    case "world_mismatch":
    case "condition_not_met":
    case "unsupported_capability":
      return code;
    default:
      return "unsupported_capability";
  }
}

function normalizeMinecraftName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("minecraft:", "")
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function normalizeOptionalName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? normalizeMinecraftName(value)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
