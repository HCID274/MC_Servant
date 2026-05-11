import { RESOURCE_REFRESH_RADIUS_STEPS } from "../core-ports/runtime.js";
import {
  type CollectSkillAdapter,
  type MineSkillAdapter,
  type MineSkillExecutionRequest,
  type MineSkillExecutionResult,
  type MineSkillParams,
  type MineSkillTargetCandidate,
  NOOP_SKILL_EXECUTION_CONTROL,
  type SkillExecutionControl,
  createMineSkillExecutionResult,
} from "../core-ports/skills.js";
import type {
  ResourceClusterQueryResult,
  ResourceServiceBoundary,
} from "../world-model/contracts.js";

const MINE_DROP_COLLECT_RADIUS = 16;
const MINE_DROP_RECOVERY_MAX_ATTEMPTS = 8;

interface MineInventoryReader {
  /** 读取当前背包物品快照，用于跨 mine / collect 计算真实掉落物增量。 */
  readInventoryItems(): readonly Readonly<{ readonly item_name: string; readonly count: number }>[];
}

/** 创建接入 ResourceService（资源服务） 与自研 runtime mine-bfs（挖掘寻路） 的 mine（挖掘） 技能执行器。 */
export function createMineSkillExecutor(input: {
  readonly resourceService: ResourceServiceBoundary;
  readonly miner: MineSkillAdapter;
  readonly collector?: CollectSkillAdapter;
  readonly inventory?: MineInventoryReader;
}): (
  params: Readonly<MineSkillParams>,
  control: SkillExecutionControl,
) => Promise<MineSkillExecutionResult> {
  return async (params, control = NOOP_SKILL_EXECUTION_CONTROL) => {
    control.throwIfAborted();
    const blockName = normalizeMinecraftName(params.blockName);
    const diagnostics: string[] = [];

    assertSupportedMineTarget(blockName);

    return executeMineUntilCollected({
      params,
      blockName,
      input,
      diagnostics,
      control,
    });
  };
}

async function executeMineUntilCollected(input: {
  readonly params: Readonly<MineSkillParams>;
  readonly blockName: string;
  readonly input: {
    readonly resourceService: ResourceServiceBoundary;
    readonly miner: MineSkillAdapter;
    readonly collector?: CollectSkillAdapter;
    readonly inventory?: MineInventoryReader;
  };
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
}): Promise<MineSkillExecutionResult> {
  const progress = createMineDropProgressTracker(input.input.inventory);
  let totalMined = 0;
  let totalSteps = 0;
  let worldKey: string | null = null;
  let collectedItemName: string | null = null;
  let collectedCount = 0;
  let attempts = 0;
  let lastError: unknown = null;

  while (collectedCount < input.params.count && attempts < MINE_DROP_RECOVERY_MAX_ATTEMPTS) {
    input.control.throwIfAborted();
    attempts += 1;
    const remaining = input.params.count - collectedCount;
    const request = await createMineRuntimeRequest({
      resourceService: input.input.resourceService,
      blockName: input.blockName,
      count: remaining,
    });

    let minedResult: MineSkillExecutionResult;
    try {
      minedResult = await input.input.miner.mine(request, input.control);
    } catch (error) {
      lastError = error;
      const recovery = await tryRecoverMissingMineDrop({
        error,
        params: input.params,
        collector: input.input.collector,
        progress,
        diagnostics: input.diagnostics,
        control: input.control,
      });
      if (!recovery.recovered) {
        throw createRuntimeMineFailureError(error, input.blockName, input.params.count);
      }
      collectedItemName = recovery.itemName;
      totalSteps += recovery.totalSteps;
      collectedCount = recovery.collectedCount;
      continue;
    }

    input.diagnostics.push(...minedResult.diagnostics);
    worldKey = minedResult.world_key;
    collectedItemName = minedResult.collected_item_name ?? collectedItemName;
    totalMined += minedResult.mined_count;
    totalSteps += minedResult.total_steps;
    collectedCount = progress.recordKnownCollected({
      itemName: minedResult.collected_item_name,
      knownCollected: minedResult.collected_count,
    });

    if (collectedCount >= input.params.count) {
      break;
    }

    lastError = createDropNotObtainedSkillError({
      itemName: minedResult.collected_item_name ?? input.blockName,
      collectedCount,
      requestedCount: input.params.count,
    });
    const recovery = await tryRecoverMissingMineDrop({
      error: lastError,
      params: input.params,
      collector: input.input.collector,
      progress,
      diagnostics: input.diagnostics,
      control: input.control,
    });
    if (!recovery.recovered) {
      throw lastError;
    }
    collectedItemName = recovery.itemName;
    totalSteps += recovery.totalSteps;
    collectedCount = recovery.collectedCount;
  }

  if (collectedCount < input.params.count) {
    throw createDropNotObtainedSkillError({
      itemName: collectedItemName ?? input.blockName,
      collectedCount,
      requestedCount: input.params.count,
      cause: lastError,
    });
  }

  return createMineSkillExecutionResult(input.params, {
    world_key: worldKey,
    collected_item_name: collectedItemName,
    collected_count: collectedCount,
    mined_count: totalMined,
    diagnostics: [...input.diagnostics, "mine_completed_by_inventory_diff"],
    total_steps: totalSteps,
  });
}

async function createMineRuntimeRequest(input: {
  readonly resourceService: ResourceServiceBoundary;
  readonly blockName: string;
  readonly count: number;
}): Promise<Readonly<MineSkillExecutionRequest>> {
  const oreTargets = isOreMineTarget(input.blockName)
    ? await selectOreResourceTargets(input.resourceService, input.blockName, input.count)
    : undefined;

  return Object.freeze({
    blockName: input.blockName,
    count: input.count,
    worldKey: input.resourceService.query(input.blockName).world_key,
    ...(oreTargets === undefined ? {} : { targets: oreTargets }),
  });
}

async function tryRecoverMissingMineDrop(input: {
  readonly error: unknown;
  readonly params: Readonly<MineSkillParams>;
  readonly collector: CollectSkillAdapter | undefined;
  readonly progress: MineDropProgressTracker;
  readonly diagnostics: string[];
  readonly control: SkillExecutionControl;
}): Promise<
  Readonly<{
    readonly recovered: boolean;
    readonly collectedCount: number;
    readonly itemName: string;
    readonly totalSteps: number;
  }>
> {
  const recovery = readMineDropRecovery(input.error);
  if (recovery === null || input.collector === undefined) {
    return Object.freeze({
      recovered: false,
      collectedCount: input.progress.collectedCount,
      itemName: "",
      totalSteps: 0,
    });
  }

  const before = input.progress.recordKnownCollected({
    itemName: recovery.expectedDropName,
    knownCollected: recovery.collectedCount,
  });
  input.diagnostics.push(
    `mine_drop_collect_recovery_start:${recovery.expectedDropName}:${before}/${input.params.count}`,
  );

  try {
    input.control.throwIfAborted();
    const collectResult = await input.collector.collect(
      {
        itemName: recovery.expectedDropName,
        radius: MINE_DROP_COLLECT_RADIUS,
        ...(recovery.currentPosition === undefined ? {} : { center: recovery.currentPosition }),
      },
      input.control,
    );
    const collectSteps = collectResult.total_steps;
    input.diagnostics.push(
      `mine_drop_collect_recovery_result:${collectResult.collected
        .map((item) => `${item.name}:${item.count}`)
        .join("|")}`,
    );
    const after = input.progress.readCollected(recovery.expectedDropName);
    if (after <= before) {
      input.diagnostics.push(`mine_drop_collect_recovery_no_gain:${recovery.expectedDropName}`);
      return Object.freeze({
        recovered: false,
        collectedCount: before,
        itemName: recovery.expectedDropName,
        totalSteps: collectSteps,
      });
    }

    input.diagnostics.push(`mine_drop_collect_recovery_gain:${recovery.expectedDropName}:${after}`);
    return Object.freeze({
      recovered: true,
      collectedCount: after,
      itemName: recovery.expectedDropName,
      totalSteps: collectSteps,
    });
  } catch (error) {
    input.diagnostics.push(`mine_drop_collect_recovery_failed:${formatUnknownError(error)}`);
    return Object.freeze({
      recovered: false,
      collectedCount: before,
      itemName: recovery.expectedDropName,
      totalSteps: 0,
    });
  }
}

async function selectOreResourceTargets(
  resourceService: ResourceServiceBoundary,
  blockName: string,
  requiredCount: number,
): Promise<readonly MineSkillTargetCandidate[]> {
  const cached = resourceService.query(blockName);
  const cachedTargets = createOreTargetsFromQuery(cached, blockName, requiredCount);
  if (cachedTargets.length >= requiredCount) {
    return cachedTargets;
  }

  for (const radius of RESOURCE_REFRESH_RADIUS_STEPS) {
    const refresh = await resourceService.refresh(blockName, radius);
    if (refresh.status === "runtime_unavailable" || refresh.status === "unsupported_resource_key") {
      throw new Error(`${refresh.status}:${refresh.diagnostics.join(",")}`);
    }

    const refreshed = resourceService.query(blockName);
    const refreshedTargets = createOreTargetsFromQuery(refreshed, blockName, requiredCount);
    if (refreshedTargets.length >= requiredCount) {
      return refreshedTargets;
    }
  }

  throw new Error(`resource_not_found:${blockName}`);
}

function createOreTargetsFromQuery(
  query: ResourceClusterQueryResult,
  blockName: string,
  requiredCount: number,
): readonly MineSkillTargetCandidate[] {
  const targets: MineSkillTargetCandidate[] = [];
  const seen = new Set<string>();

  for (const cluster of query.clusters) {
    if (normalizeMinecraftName(cluster.block_name) !== blockName) {
      continue;
    }

    const orderedCandidates =
      cluster.recommended_candidate === null
        ? cluster.candidates
        : [cluster.recommended_candidate, ...cluster.candidates];

    for (const candidate of orderedCandidates) {
      if (
        normalizeMinecraftName(candidate.block_name) !== blockName ||
        !candidate.is_diggable ||
        !candidate.is_reachable
      ) {
        continue;
      }

      const key = `${candidate.position.x}:${candidate.position.y}:${candidate.position.z}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      targets.push({
        block_name: candidate.block_name,
        position: {
          x: candidate.position.x,
          y: candidate.position.y,
          z: candidate.position.z,
        },
      });

      if (targets.length >= requiredCount) {
        return Object.freeze(targets);
      }
    }
  }

  return Object.freeze(targets);
}

function assertSupportedMineTarget(blockName: string): void {
  switch (blockName) {
    case "stone":
    case "dirt":
    case "sand":
    case "gravel":
    case "iron_ore":
    case "deepslate_iron_ore":
      return;
    default:
      throw new Error(`unsupported_capability:mine:${blockName}`);
  }
}

function isOreMineTarget(blockName: string): boolean {
  return blockName === "iron_ore" || blockName === "deepslate_iron_ore";
}

function normalizeMinecraftName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("minecraft:") ? trimmed.slice("minecraft:".length) : trimmed;
}

interface MineDropProgressTracker {
  readonly collectedCount: number;
  recordKnownCollected(input: {
    readonly itemName: string | null | undefined;
    readonly knownCollected: number;
  }): number;
  readCollected(itemName: string): number;
}

interface MineDropRecoveryInfo {
  readonly expectedDropName: string;
  readonly collectedCount: number;
  readonly currentPosition?: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
}

function createMineDropProgressTracker(
  inventory: MineInventoryReader | undefined,
): MineDropProgressTracker {
  let itemName: string | null = null;
  let baseline: number | null = null;
  let collectedCount = 0;

  return {
    get collectedCount(): number {
      return collectedCount;
    },
    recordKnownCollected(input): number {
      if (input.itemName === null || input.itemName === undefined) {
        collectedCount = Math.max(collectedCount, input.knownCollected);
        return collectedCount;
      }

      itemName = input.itemName;
      if (inventory === undefined) {
        collectedCount = Math.max(collectedCount, input.knownCollected);
        return collectedCount;
      }

      const current = countInventoryItem(inventory.readInventoryItems(), itemName);
      if (baseline === null) {
        baseline = Math.max(0, current - input.knownCollected);
      }
      collectedCount = Math.max(collectedCount, current - baseline, input.knownCollected);
      return collectedCount;
    },
    readCollected(nextItemName): number {
      itemName = nextItemName;
      if (inventory === undefined) {
        return collectedCount;
      }

      const current = countInventoryItem(inventory.readInventoryItems(), itemName);
      if (baseline === null) {
        baseline = current - collectedCount;
      }
      collectedCount = Math.max(collectedCount, current - baseline);
      return collectedCount;
    },
  };
}

function readMineDropRecovery(error: unknown): MineDropRecoveryInfo | null {
  const details = readErrorDetails(error);
  const expectedDropName = readString(details.expected_drop_name);
  if (expectedDropName === null) {
    return null;
  }

  const collectedCount = readNumber(details.collected_count) ?? 0;
  const currentPosition = readPosition(details.current_position);
  if (!formatUnknownError(error).includes("drop_not_obtained")) {
    return null;
  }

  return Object.freeze({
    expectedDropName,
    collectedCount,
    ...(currentPosition === undefined ? {} : { currentPosition }),
  });
}

function createDropNotObtainedSkillError(input: {
  readonly itemName: string;
  readonly collectedCount: number;
  readonly requestedCount: number;
  readonly cause?: unknown;
}): Error {
  const message = `drop_not_obtained:${input.itemName}:${input.collectedCount}/${input.requestedCount}:mine completed without enough inventory diff`;
  return Object.assign(new Error(message), {
    error_code: "drop_not_obtained",
    details: {
      expected_drop_name: input.itemName,
      collected_count: input.collectedCount,
      requested_count: input.requestedCount,
      ...(input.cause === undefined ? {} : { cause: formatUnknownError(input.cause) }),
    },
  });
}

function countInventoryItem(
  items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  itemName: string,
): number {
  const target = normalizeMinecraftName(itemName);
  return items.reduce(
    (sum, item) => (normalizeMinecraftName(item.item_name) === target ? sum + item.count : sum),
    0,
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPosition(
  value: unknown,
): Readonly<{ readonly x: number; readonly y: number; readonly z: number }> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as {
    readonly x?: unknown;
    readonly y?: unknown;
    readonly z?: unknown;
  };
  const x = readNumber(candidate.x);
  const y = readNumber(candidate.y);
  const z = readNumber(candidate.z);
  if (x === null || y === null || z === null) {
    return undefined;
  }

  return Object.freeze({ x, y, z });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRuntimeMineFailureError(error: unknown, blockName: string, count: number): Error {
  return Object.assign(new Error(`runtime_mine_failed:${formatUnknownError(error)}`), {
    error_code: "runtime_mine_failed",
    details: {
      ...readErrorDetails(error),
      failure_stage: "mine",
      block_name: blockName,
      requested_count: count,
    },
  });
}

function readErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const details = (error as { readonly details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return {};
  }

  return details as Readonly<Record<string, unknown>>;
}
