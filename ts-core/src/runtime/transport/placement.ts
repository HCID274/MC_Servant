import { Vec3 } from "vec3";

import type {
  PlaceCapabilityParams,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailureCode,
} from "../../core-ports/skills.js";
import { executeMineflayerCraft } from "./craft.js";
import { type CraftingTablePlacementCache, isCraftingTableBlock } from "./crafting-table.js";
import { resolveGoalNearConstructor } from "./pathfinder-goals.js";
import type {
  MineflayerBlockHandle,
  MineflayerBotHandle,
  MineflayerItemHandle,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerRegistryFacts,
  MineflayerVec3Like,
} from "./types.js";
import { readMineflayerBlockAt } from "./world-reader.js";

const PLACEMENT_SEARCH_RADIUS = 3;
const PLACEMENT_CANDIDATE_LIMIT = 3;
const PLACE_FACE_UP = Object.freeze({ x: 0, y: 1, z: 0 });

type PlacementTransportResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** 执行最小 place（放置） 能力；当前只允许工具链放置 crafting table（工作台）。 */
export async function executeMineflayerPlaceCraftingTable(input: {
  readonly bot: MineflayerBotHandle;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<PlaceCapabilityParams>;
  readonly worldKey: string | null;
  readonly cache: CraftingTablePlacementCache;
}): Promise<PlacementTransportResult> {
  const normalized = normalizePlacementName(input.params.blockName);

  if (normalized !== "crafting_table") {
    return createPlacementFailure({
      code: "unsupported_capability",
      message: `place target is not enabled in Phase 1: ${input.params.blockName}`,
      worldKey: input.worldKey,
      details: { block_name: input.params.blockName },
    });
  }

  const cachedResult = readCachedCraftingTable(input.bot, input.cache, input.params.near);
  if (cachedResult.status === "valid") {
    return createPlacementSuccess(input.worldKey, cachedResult.position);
  }
  if (cachedResult.status === "invalid") {
    return createPlacementFailure({
      code: "cached_position_invalid",
      message: "Cached crafting table position no longer contains a crafting table",
      worldKey: input.worldKey,
      details: { position: cachedResult.position },
    });
  }

  const craftingTableItem = await ensureCraftingTableItem(input);
  if (craftingTableItem.status === "failed") {
    return craftingTableItem.result;
  }
  if (craftingTableItem.item === null) {
    return createPlacementFailure({
      code: "missing_crafting_table_item",
      message: "Crafting table item is still unavailable after craft attempt",
      worldKey: input.worldKey,
    });
  }

  const candidates = findCraftingTablePlacementCandidates(input.bot, input.params.near);
  if (candidates.length === 0) {
    return createPlacementFailure({
      code: "no_placeable_position",
      message: "No nearby safe clickable position for crafting table placement",
      worldKey: input.worldKey,
      details: {
        search_radius: PLACEMENT_SEARCH_RADIUS,
        candidate_limit: PLACEMENT_CANDIDATE_LIMIT,
      },
    });
  }

  const GoalNear = resolveGoalNearConstructor(input.pathfinderModule);
  await input.bot.equip?.(craftingTableItem.item, "hand");
  const failures: Readonly<Record<string, unknown>>[] = [];
  for (const candidate of candidates) {
    const placement = await tryPlaceCraftingTableAtCandidate(input, candidate, GoalNear);
    if (placement.ok) {
      input.cache.position = candidate.target;
      return createPlacementSuccess(input.worldKey, candidate.target);
    }

    failures.push(placement.failure);
  }

  return createPlacementFailure({
    code: "place_failed",
    message: "All crafting table placement candidates failed",
    worldKey: input.worldKey,
    details: { attempts: failures },
  });
}

async function tryPlaceCraftingTableAtCandidate(
  input: {
    readonly bot: MineflayerBotHandle;
    readonly pathfinder: MineflayerPathfinderApi;
  },
  candidate: PlacementCandidate,
  GoalNear: new (x: number, y: number, z: number, range: number) => unknown,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: Readonly<Record<string, unknown>> }
> {
  try {
    await input.pathfinder.goto(
      new GoalNear(candidate.target.x, candidate.target.y, candidate.target.z, 2),
    );
    const currentTargetBlock = readMineflayerBlockAt(input.bot, candidate.target);
    if (!isEmptyBlock(currentTargetBlock)) {
      return {
        ok: false,
        failure: {
          position: candidate.target,
          reason: "target_occupied",
          block_name: currentTargetBlock?.name ?? null,
        },
      };
    }

    const supportBlock = readMineflayerBlockAt(input.bot, candidate.supportPosition);
    if (supportBlock === null || isEmptyBlock(supportBlock)) {
      return {
        ok: false,
        failure: {
          position: candidate.target,
          reason: "support_missing",
        },
      };
    }
    if (typeof input.bot.canSeeBlock === "function" && !input.bot.canSeeBlock(supportBlock)) {
      return {
        ok: false,
        failure: {
          position: candidate.target,
          reason: "support_not_visible",
        },
      };
    }

    await input.bot.lookAt?.(createBlockCenter(candidate.target), true);
    await input.bot.placeBlock?.(
      supportBlock,
      new Vec3(PLACE_FACE_UP.x, PLACE_FACE_UP.y, PLACE_FACE_UP.z),
    );
  } catch (error) {
    return {
      ok: false,
      failure: {
        position: candidate.target,
        reason: "place_exception",
        message: getErrorMessage(error),
      },
    };
  }

  const placedBlock = readMineflayerBlockAt(input.bot, candidate.target);
  if (!isCraftingTableBlock(input.bot.registry, placedBlock)) {
    return {
      ok: false,
      failure: {
        position: candidate.target,
        reason: "verification_failed",
        block_name: placedBlock?.name ?? null,
      },
    };
  }

  return { ok: true };
}

type CachedCraftingTableResult =
  | { readonly status: "empty" }
  | { readonly status: "valid"; readonly position: MineflayerVec3Like }
  | { readonly status: "invalid"; readonly position: MineflayerVec3Like };

function readCachedCraftingTable(
  bot: MineflayerBotHandle,
  cache: CraftingTablePlacementCache,
  near: PlaceCapabilityParams["near"],
): CachedCraftingTableResult {
  if (cache.position === null) {
    return { status: "empty" };
  }

  const cachedBlock = readMineflayerBlockAt(bot, cache.position);
  if (isCraftingTableBlock(bot.registry, cachedBlock)) {
    if (
      near !== undefined &&
      calculateDistanceSquared(cache.position, near) > PLACEMENT_SEARCH_RADIUS ** 2
    ) {
      return { status: "empty" };
    }

    return { status: "valid", position: cache.position };
  }

  const invalidPosition = cache.position;
  cache.position = null;
  return { status: "invalid", position: invalidPosition };
}

interface PlacementCandidate {
  readonly target: MineflayerVec3Like;
  readonly supportPosition: MineflayerVec3Like;
}

function findCraftingTablePlacementCandidates(
  bot: MineflayerBotHandle,
  near: PlaceCapabilityParams["near"],
): readonly PlacementCandidate[] {
  const origin = near ?? bot.entity?.position;
  if (origin === undefined) {
    return [];
  }

  const candidates: PlacementCandidate[] = [];
  for (const target of createPlacementCandidatePositions(origin, bot.entity?.position)) {
    const targetBlock = readMineflayerBlockAt(bot, target);
    if (!isEmptyBlock(targetBlock)) {
      continue;
    }

    const supportPosition = { x: target.x, y: target.y - 1, z: target.z };
    const supportBlock = readMineflayerBlockAt(bot, supportPosition);
    if (supportBlock === null || isEmptyBlock(supportBlock)) {
      continue;
    }

    candidates.push({ target, supportPosition });
    if (candidates.length >= PLACEMENT_CANDIDATE_LIMIT) {
      return Object.freeze(candidates);
    }
  }

  return Object.freeze(candidates);
}

function createPlacementCandidatePositions(
  origin: MineflayerVec3Like,
  botPosition: MineflayerVec3Like | undefined,
): readonly MineflayerVec3Like[] {
  const base = {
    x: Math.floor(origin.x),
    y: Math.floor(origin.y),
    z: Math.floor(origin.z),
  };
  const botFloor =
    botPosition === undefined
      ? null
      : {
          x: Math.floor(botPosition.x),
          y: Math.floor(botPosition.y),
          z: Math.floor(botPosition.z),
        };
  const positions: MineflayerVec3Like[] = [];

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -PLACEMENT_SEARCH_RADIUS; dx <= PLACEMENT_SEARCH_RADIUS; dx += 1) {
      for (let dz = -PLACEMENT_SEARCH_RADIUS; dz <= PLACEMENT_SEARCH_RADIUS; dz += 1) {
        const target = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
        if (
          botFloor !== null &&
          target.x === botFloor.x &&
          target.z === botFloor.z &&
          Math.abs(target.y - botFloor.y) <= 1
        ) {
          continue;
        }

        positions.push(target);
      }
    }
  }

  return Object.freeze(
    positions.sort(
      (left, right) =>
        calculateDistanceSquared(left, origin) - calculateDistanceSquared(right, origin),
    ),
  );
}

function findInventoryItemByName(
  bot: MineflayerBotHandle,
  itemName: string,
): MineflayerItemHandle | null {
  const itemId = (bot.registry as MineflayerRegistryFacts | undefined)?.itemsByName?.[itemName]?.id;

  return (
    bot.inventory
      ?.items()
      .find(
        (item) =>
          normalizePlacementName(item.name ?? "") === itemName ||
          (itemId !== undefined && item.type === itemId),
      ) ?? null
  );
}

function isEmptyBlock(block: MineflayerBlockHandle | null): boolean {
  if (block === null) {
    return false;
  }

  const blockName = normalizePlacementName(block.name ?? "");
  return (
    block.type === 0 || blockName === "air" || blockName === "cave_air" || blockName === "void_air"
  );
}

type EnsureCraftingTableItemResult =
  | { readonly status: "ready"; readonly item: MineflayerItemHandle | null }
  | { readonly status: "failed"; readonly result: PlacementTransportResult };

async function ensureCraftingTableItem(input: {
  readonly bot: MineflayerBotHandle;
  readonly worldKey: string | null;
  readonly cache: CraftingTablePlacementCache;
}): Promise<EnsureCraftingTableItemResult> {
  const existingItem = findInventoryItemByName(input.bot, "crafting_table");
  if (existingItem !== null) {
    return { status: "ready", item: existingItem };
  }

  const craftResult = await executeMineflayerCraft({
    bot: input.bot,
    params: { itemName: "crafting_table", count: 1 },
    worldKey: input.worldKey,
    craftingTableCache: input.cache,
  });

  if (craftResult.ok) {
    return { status: "ready", item: findInventoryItemByName(input.bot, "crafting_table") };
  }

  if (craftResult.error.code !== "missing_materials") {
    return { status: "failed", result: craftResult };
  }

  const planksResult = await executeMineflayerCraft({
    bot: input.bot,
    params: { itemName: "planks", count: readLargestMissingMaterialCount(craftResult.error) },
    worldKey: input.worldKey,
    craftingTableCache: input.cache,
  });

  if (!planksResult.ok) {
    return { status: "failed", result: planksResult };
  }

  const retryCraftResult = await executeMineflayerCraft({
    bot: input.bot,
    params: { itemName: "crafting_table", count: 1 },
    worldKey: input.worldKey,
    craftingTableCache: input.cache,
  });

  if (!retryCraftResult.ok) {
    return { status: "failed", result: retryCraftResult };
  }

  return { status: "ready", item: findInventoryItemByName(input.bot, "crafting_table") };
}

function readLargestMissingMaterialCount(error: {
  readonly details?: Readonly<Record<string, unknown>>;
}): number {
  const candidates = readRecordArray(error.details?.candidates);
  let largestMissing = 1;

  for (const candidate of candidates) {
    for (const missingItem of readRecordArray(candidate.missing)) {
      const missing = missingItem.missing;
      if (typeof missing === "number" && Number.isFinite(missing) && missing > largestMissing) {
        largestMissing = Math.ceil(missing);
      }
    }
  }

  return largestMissing;
}

function readRecordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Readonly<Record<string, unknown>> => typeof item === "object" && item !== null,
  );
}

function createBlockCenter(position: MineflayerVec3Like): Vec3 {
  return new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5);
}

function createPlacementSuccess(
  worldKey: string | null,
  position: MineflayerVec3Like,
): PlacementTransportResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      world_key: worldKey,
      completed_count: 1,
      block_name: "crafting_table",
      position: Object.freeze({ x: position.x, y: position.y, z: position.z }),
    }),
  });
}

function createPlacementFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}): PlacementTransportResult {
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

function normalizePlacementName(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function calculateDistanceSquared(left: MineflayerVec3Like, right: MineflayerVec3Like): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
