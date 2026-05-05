import type {
  CollectSkillAdapter,
  CraftToolchainAdapter,
  CutTreeSkillAdapter,
  EmptyEnsureCapabilityParams,
  EnsureCobblestoneCapabilityParams,
  EnsureLogsCapabilityParams,
  EquipSkillAdapter,
  MineSkillAdapter,
  PlaceToolchainAdapter,
  ToolchainActionSummary,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailure,
  ToolchainFailureCode,
} from "../core-ports/skills.js";

const ENSURE_COLLECT_RADIUS = 8;
const ENSURE_RETRY_LIMIT = 3;

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
  /** 读取当前世界键；由 runtime（运行时） 既有世界键端口注入。 */
  readonly readCurrentWorldKey?: () => string | null;
  readonly craft: CraftToolchainAdapter["craft"];
  readonly place: PlaceToolchainAdapter["place"];
  readonly equip: EquipSkillAdapter["equip"];
  readonly mine: MineSkillAdapter["mine"];
  readonly collect: CollectSkillAdapter["collect"];
  readonly cutTree?: CutTreeSkillAdapter["cutTree"];
}

/** 可复用 ensure（确保） 函数组。 */
export interface ToolchainEnsureExecutor {
  readonly ensureLogs: (params: Readonly<EnsureLogsCapabilityParams>) => Promise<EnsureResult>;
  readonly ensureCraftingTablePlaced: (
    params?: Readonly<EmptyEnsureCapabilityParams>,
  ) => Promise<EnsureResult>;
  readonly ensureWoodenPickaxeEquipped: (
    params?: Readonly<EmptyEnsureCapabilityParams>,
  ) => Promise<EnsureResult>;
  readonly ensureCobblestone: (
    params: Readonly<EnsureCobblestoneCapabilityParams>,
  ) => Promise<EnsureResult>;
  readonly ensureStonePickaxeEquipped: (
    params?: Readonly<EmptyEnsureCapabilityParams>,
  ) => Promise<EnsureResult>;
}

/** 创建工具链 ensure（确保） 编排器；不直接操作 runtime（运行时）。 */
export function createToolchainEnsureExecutor(
  dependencies: ToolchainEnsureDependencies,
): ToolchainEnsureExecutor {
  const executor: ToolchainEnsureExecutor = Object.freeze({
    async ensureLogs(params: Readonly<EnsureLogsCapabilityParams>) {
      const actions: ToolchainActionSummary[] = [];
      const before = countLogs(dependencies.inventory);
      if (before >= params.count) {
        return createEnsureSuccess({
          itemName: "logs",
          completedCount: before,
          targetCount: params.count,
          actions,
          worldKey: readCurrentWorldKey(dependencies),
        });
      }

      const missing = params.count - before;
      if (dependencies.cutTree === undefined) {
        return createEnsureFailure({
          code: "unsupported_capability",
          message: "cutTree execution dependency is not configured for ensureLogs",
          worldKey: null,
          actions,
          details: { target_count: params.count, completed_count: before },
        });
      }

      const cutTreeResult = await callSkill({
        action: "cutTree",
        target: "logs",
        requestedCount: missing,
        actions,
        run: () => dependencies.cutTree?.({ count: missing }) ?? Promise.reject(),
      });
      if (!cutTreeResult.ok) {
        return cutTreeResult.failure;
      }

      const collectResult = await callSkill({
        action: "collect",
        target: "logs",
        requestedCount: missing,
        actions,
        run: () => dependencies.collect({ radius: ENSURE_COLLECT_RADIUS }),
      });
      if (!collectResult.ok) {
        return collectResult.failure;
      }

      const after = Math.max(
        countLogs(dependencies.inventory),
        before + cutTreeResult.result.collected_count,
      );
      return after >= params.count
        ? createEnsureSuccess({
            itemName: "logs",
            completedCount: after,
            targetCount: params.count,
            actions,
            worldKey: readWorldKeyFromActions(actions) ?? readCurrentWorldKey(dependencies),
          })
        : createEnsureFailure({
            code: "resource_not_found",
            message: "ensureLogs did not reach target inventory count",
            worldKey: readWorldKeyFromActions(actions),
            actions,
            details: { target_count: params.count, completed_count: after },
          });
    },

    async ensureCraftingTablePlaced() {
      const actions: ToolchainActionSummary[] = [];
      const placed = await callToolchain({
        action: "place",
        target: "crafting_table",
        requestedCount: 1,
        actions,
        run: () => dependencies.place({ blockName: "crafting_table" }),
      });

      return placed.ok
        ? createEnsureSuccess({
            blockName: "crafting_table",
            completedCount: 1,
            targetCount: 1,
            actions,
            worldKey: placed.result.data.world_key,
            position: placed.result.data.position,
          })
        : placed.failure;
    },

    async ensureWoodenPickaxeEquipped() {
      const actions: ToolchainActionSummary[] = [];
      const existing = countInventoryItem(
        dependencies.inventory.readInventoryItems(),
        "wooden_pickaxe",
      );
      if (existing <= 0) {
        const crafted = await craftWithRecovery({
          target: "wooden_pickaxe",
          actions,
          executor,
          dependencies,
        });
        if (!crafted.ok) {
          return crafted.failure;
        }
      }

      const equipped = await callSkill({
        action: "equip",
        target: "wooden_pickaxe",
        requestedCount: 1,
        actions,
        run: () => dependencies.equip({ itemName: "wooden_pickaxe", destination: "hand" }),
      });

      return equipped.ok
        ? createEnsureSuccess({
            itemName: "wooden_pickaxe",
            completedCount: 1,
            targetCount: 1,
            actions,
          })
        : equipped.failure;
    },

    async ensureCobblestone(params: Readonly<EnsureCobblestoneCapabilityParams>) {
      const actions: ToolchainActionSummary[] = [];
      const before = countInventoryItem(dependencies.inventory.readInventoryItems(), "cobblestone");
      if (before >= params.count) {
        return createEnsureSuccess({
          itemName: "cobblestone",
          completedCount: before,
          targetCount: params.count,
          actions,
          worldKey: readCurrentWorldKey(dependencies),
        });
      }

      const pickaxe = await executor.ensureWoodenPickaxeEquipped();
      actions.push(
        ...(pickaxe.ok
          ? (pickaxe.data.actions ?? [])
          : ((pickaxe.error.details?.actions as ToolchainActionSummary[] | undefined) ?? [])),
      );
      if (!pickaxe.ok) {
        return pickaxe;
      }

      const missing = params.count - before;
      const mined = await callSkill({
        action: "mine",
        target: "stone",
        requestedCount: missing,
        actions,
        run: () => dependencies.mine({ blockName: "stone", count: missing }),
      });
      if (!mined.ok) {
        return mined.failure;
      }

      const after = countInventoryItem(dependencies.inventory.readInventoryItems(), "cobblestone");
      return after >= params.count
        ? createEnsureSuccess({
            itemName: "cobblestone",
            completedCount: after,
            targetCount: params.count,
            actions,
          })
        : createEnsureFailure({
            code: "drop_not_obtained",
            message: "ensureCobblestone did not reach target inventory count",
            worldKey: readWorldKeyFromActions(actions),
            actions,
            details: { target_count: params.count, completed_count: after },
          });
    },

    async ensureStonePickaxeEquipped() {
      const actions: ToolchainActionSummary[] = [];
      const existing = countInventoryItem(
        dependencies.inventory.readInventoryItems(),
        "stone_pickaxe",
      );
      if (existing <= 0) {
        const table = await executor.ensureCraftingTablePlaced();
        actions.push(
          ...(table.ok
            ? (table.data.actions ?? [])
            : ((table.error.details?.actions as ToolchainActionSummary[] | undefined) ?? [])),
        );
        if (!table.ok) {
          return table;
        }

        const wooden = await executor.ensureWoodenPickaxeEquipped();
        actions.push(
          ...(wooden.ok
            ? (wooden.data.actions ?? [])
            : ((wooden.error.details?.actions as ToolchainActionSummary[] | undefined) ?? [])),
        );
        if (!wooden.ok) {
          return wooden;
        }

        const crafted = await craftWithRecovery({
          target: "stone_pickaxe",
          actions,
          executor,
          dependencies,
        });
        if (!crafted.ok) {
          return crafted.failure;
        }
      }

      const equipped = await callSkill({
        action: "equip",
        target: "stone_pickaxe",
        requestedCount: 1,
        actions,
        run: () => dependencies.equip({ itemName: "stone_pickaxe", destination: "hand" }),
      });

      return equipped.ok
        ? createEnsureSuccess({
            itemName: "stone_pickaxe",
            completedCount: 1,
            targetCount: 1,
            actions,
          })
        : equipped.failure;
    },
  });

  return executor;
}

async function craftWithRecovery(input: {
  readonly target: string;
  readonly actions: ToolchainActionSummary[];
  readonly executor: ToolchainEnsureExecutor;
  readonly dependencies: ToolchainEnsureDependencies;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: EnsureResult }> {
  for (let attempt = 0; attempt < ENSURE_RETRY_LIMIT; attempt += 1) {
    const crafted = await callToolchain({
      action: "craft",
      target: input.target,
      requestedCount: 1,
      actions: input.actions,
      run: () => input.dependencies.craft({ itemName: input.target, count: 1 }),
    });
    if (crafted.ok) {
      return { ok: true as const };
    }

    if (crafted.result.error.code === "missing_crafting_table") {
      const table = await input.executor.ensureCraftingTablePlaced();
      input.actions.push(...readResultActions(table));
      if (!table.ok) {
        return { ok: false as const, failure: table };
      }
      continue;
    }

    const missingCobblestone = readMissingCount(crafted.result.error.details, "cobblestone");
    if (missingCobblestone > 0) {
      const cobblestoneTarget =
        countInventoryItem(input.dependencies.inventory.readInventoryItems(), "cobblestone") +
        missingCobblestone;
      const cobble = await input.executor.ensureCobblestone({ count: cobblestoneTarget });
      input.actions.push(...readResultActions(cobble));
      if (!cobble.ok) {
        return { ok: false as const, failure: cobble };
      }
      continue;
    }

    if (crafted.result.error.code === "missing_materials") {
      const logTarget = countLogs(input.dependencies.inventory) + 1;
      const logs = await input.executor.ensureLogs({ count: logTarget });
      input.actions.push(...readResultActions(logs));
      if (!logs.ok) {
        return { ok: false as const, failure: logs };
      }
      continue;
    }

    return { ok: false as const, failure: crafted.failure };
  }

  return {
    ok: false as const,
    failure: createEnsureFailure({
      code: "missing_materials",
      message: `ensure craft retry limit reached for ${input.target}`,
      worldKey: readWorldKeyFromActions(input.actions),
      actions: input.actions,
      details: { item_name: input.target, retry_limit: ENSURE_RETRY_LIMIT },
    }),
  };
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
      worldKey === undefined
        ? createActionSummary({
            action: input.action,
            target: input.target,
            requestedCount: input.requestedCount,
            completedCount: readSkillCompletedCount(result),
            status: "completed",
          })
        : createActionSummary({
            action: input.action,
            target: input.target,
            requestedCount: input.requestedCount,
            completedCount: readSkillCompletedCount(result),
            status: "completed",
            worldKey,
          }),
    );
    return { ok: true as const, result };
  } catch (error) {
    const message = getErrorMessage(error);
    const code = classifySkillFailure(message);
    input.actions.push(
      createActionSummary({
        action: input.action,
        target: input.target,
        requestedCount: input.requestedCount,
        completedCount: 0,
        status: "failed",
        worldKey: readWorldKeyFromActions(input.actions),
        reason: code,
      }),
    );
    return {
      ok: false as const,
      failure: createEnsureFailure({
        code,
        message,
        worldKey: readWorldKeyFromActions(input.actions),
        actions: input.actions,
        details: { action: input.action, target: input.target },
      }),
    };
  }
}

function createEnsureSuccess(input: {
  readonly itemName?: string;
  readonly blockName?: string;
  readonly completedCount: number;
  readonly targetCount: number;
  readonly actions: readonly ToolchainActionSummary[];
  readonly worldKey?: string | null;
  readonly position?: ToolchainCapabilityData["position"];
}): EnsureResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      world_key: input.worldKey ?? readWorldKeyFromActions(input.actions),
      completed_count: input.completedCount,
      target_count: input.targetCount,
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

function readResultActions(result: EnsureResult): readonly ToolchainActionSummary[] {
  if (result.ok) {
    return result.data.actions ?? [];
  }

  const actions = result.error.details?.actions;
  return Array.isArray(actions) ? (actions as readonly ToolchainActionSummary[]) : [];
}

function countLogs(reader: ToolchainEnsureInventoryReader): number {
  const items = reader.readInventoryItems();
  if (reader.countLogs !== undefined) {
    return reader.countLogs(items);
  }

  return 0;
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

function readMissingCount(
  details: Readonly<Record<string, unknown>> | undefined,
  itemName: string,
): number {
  if (details === undefined) {
    return 0;
  }

  return readMissingCountFromUnknown(details, itemName);
}

function readMissingCountFromUnknown(value: unknown, itemName: string): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + readMissingCountFromUnknown(item, itemName), 0);
  }

  if (typeof value !== "object" || value === null) {
    return 0;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const ownMissing =
    record.item_name === itemName && typeof record.missing === "number"
      ? Math.max(0, Math.ceil(record.missing))
      : 0;

  return Object.values(record).reduce<number>(
    (sum, nested) => sum + readMissingCountFromUnknown(nested, itemName),
    ownMissing,
  );
}

function readSkillCompletedCount(
  result: { readonly total_steps: number } & Record<string, unknown>,
): number {
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

function normalizeMinecraftName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("minecraft:", "")
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
