import { Vec3 } from "vec3";

import type {
  PlaceCapabilityParams,
  SkillExecutionControl,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailureCode,
} from "../../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../../core-ports/skills.js";
import { executeMineflayerCraft } from "./craft.js";
import { type CraftingTablePlacementCache, isCraftingTableBlock } from "./crafting-table.js";
import { createMineBlockFactReader } from "./mine-block-facts.js";
import { navigateTerrainToFoot, readTerrainBotFoot } from "./terrain-navigation.js";
import type { TerrainBlockPos } from "./terrain-router.js";
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
const PLACE_BLOCK_ATTEMPT_LIMIT = 3;
const PLACE_BLOCK_RECHECK_DELAY_MS = 100;
const PLACE_FACE_UP = Object.freeze({ x: 0, y: 1, z: 0 });
const PLACE_REACH_DISTANCE = 4.5;

type PlacementTransportResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** 执行最小 place（放置） 能力；当前只允许工具链放置 crafting table（工作台）。 */
export async function executeMineflayerPlaceCraftingTable(input: {
  readonly bot: MineflayerBotHandle;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<PlaceCapabilityParams>;
  readonly worldKey: string | null;
  readonly cache: CraftingTablePlacementCache;
  readonly control: SkillExecutionControl;
}): Promise<PlacementTransportResult> {
  const control = input.control ?? NOOP_SKILL_EXECUTION_CONTROL;
  control.throwIfAborted();
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

  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);
  void input.pathfinderModule;
  control.throwIfAborted();
  const failures: Readonly<Record<string, unknown>>[] = [];
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    control.throwIfAborted();
    const placement = await tryPlaceCraftingTableAtCandidate(
      { bot: input.bot, control },
      candidate,
      diagnostics,
    );
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
    details: { attempts: failures, diagnostics },
  });
}

async function tryPlaceCraftingTableAtCandidate(
  input: {
    readonly bot: MineflayerBotHandle;
    readonly control: SkillExecutionControl;
  },
  candidate: PlacementCandidate,
  diagnostics: string[],
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: Readonly<Record<string, unknown>> }
> {
  try {
    const facts = createMineBlockFactReader(input.bot.registry);
    const approachFailures: Readonly<Record<string, unknown>>[] = [];
    for (const approachFoot of candidate.approachFeet) {
      try {
        await navigateTerrainToFoot({
          bot: input.bot,
          facts,
          targetFoot: approachFoot,
          goalRange: 0,
          allowPlaceUp: true,
          allowDig: true,
          diagnostics,
          diagnosticPrefix: "place",
          control: input.control,
        });
      } catch (error) {
        approachFailures.push({
          target: candidate.target,
          approach_foot: approachFoot,
          reason: "approach_unreachable",
          message: getErrorMessage(error),
        });
        continue;
      }

      const currentFoot = readTerrainBotFoot(input.bot);
      if (sameBlockFoot(currentFoot, candidate.target)) {
        approachFailures.push({
          target: candidate.target,
          approach_foot: approachFoot,
          reason: "approach_overlaps_target",
          current_foot: currentFoot,
        });
        continue;
      }

      const currentTargetBlock = readMineflayerBlockAt(input.bot, candidate.target);
      if (!isEmptyBlock(currentTargetBlock)) {
        return {
          ok: false,
          failure: {
            position: candidate.target,
            approach_foot: approachFoot,
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
            approach_foot: approachFoot,
            reason: "support_missing",
          },
        };
      }

      const placed = await placeCraftingTableWithRetries(
        input,
        candidate,
        supportBlock,
        diagnostics,
      );
      if (placed.ok) {
        return placed;
      }
      approachFailures.push({
        ...placed.failure,
        approach_foot: approachFoot,
      });
    }

    return {
      ok: false,
      failure: {
        position: candidate.target,
        reason: "all_approaches_failed",
        approaches: approachFailures,
      },
    };
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
}

async function placeCraftingTableWithRetries(
  input: {
    readonly bot: MineflayerBotHandle;
    readonly control: SkillExecutionControl;
  },
  candidate: PlacementCandidate,
  supportBlock: MineflayerBlockHandle,
  diagnostics: string[],
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: Readonly<Record<string, unknown>> }
> {
  let lastFailure: Readonly<Record<string, unknown>> | null = null;

  for (let attempt = 1; attempt <= PLACE_BLOCK_ATTEMPT_LIMIT; attempt += 1) {
    input.control.throwIfAborted();
    try {
      const equipped = await equipCraftingTableForPlace(input.bot);
      if (!equipped.ok) {
        return {
          ok: false,
          failure: {
            position: candidate.target,
            reason: equipped.reason,
            attempt,
          },
        };
      }
      await input.bot.lookAt?.(createBlockCenter(candidate.target), true);
      await input.bot.placeBlock?.(
        supportBlock,
        new Vec3(PLACE_FACE_UP.x, PLACE_FACE_UP.y, PLACE_FACE_UP.z),
      );
      const verified = verifyCraftingTablePlaced(input.bot, candidate, attempt);
      if (verified.ok) {
        diagnostics.push(
          `place:block_verified:attempt=${attempt};position=${posLabel(candidate.target)}`,
        );
        return { ok: true };
      }

      lastFailure = verified.failure;
      diagnostics.push(
        `place:block_verify_failed:attempt=${attempt};position=${posLabel(candidate.target)};block=${verified.failure.block_name ?? "null"}`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      await delay(PLACE_BLOCK_RECHECK_DELAY_MS);
      const verified = verifyCraftingTablePlaced(input.bot, candidate, attempt);
      if (verified.ok) {
        diagnostics.push(
          `place:block_verified_after_exception:attempt=${attempt};position=${posLabel(candidate.target)};message=${sanitizeDiagnostic(message)}`,
        );
        return { ok: true };
      }

      lastFailure = {
        position: candidate.target,
        reason: "place_exception",
        attempt,
        message,
        verified_block_name: verified.failure.block_name ?? null,
      };
      diagnostics.push(
        `place:block_exception:attempt=${attempt};position=${posLabel(candidate.target)};message=${sanitizeDiagnostic(message)};verified_block=${verified.failure.block_name ?? "null"}`,
      );
      if (!shouldRetryPlaceException(message)) {
        return { ok: false, failure: lastFailure };
      }
    }

    if (attempt < PLACE_BLOCK_ATTEMPT_LIMIT) {
      await delay(PLACE_BLOCK_RECHECK_DELAY_MS);
    }
  }

  return {
    ok: false,
    failure: lastFailure ?? {
      position: candidate.target,
      reason: "verification_failed",
      block_name: null,
    },
  };
}

function shouldRetryPlaceException(message: string): boolean {
  const normalized = message.toLowerCase();
  return !(
    normalized.includes("target blocked") ||
    normalized.includes("occupied") ||
    normalized.includes("must be holding") ||
    normalized.includes("missing reference position")
  );
}

function verifyCraftingTablePlaced(
  bot: MineflayerBotHandle,
  candidate: PlacementCandidate,
  attempt: number,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: Readonly<Record<string, unknown>> } {
  const placedBlock = readMineflayerBlockAt(bot, candidate.target);
  if (isCraftingTableBlock(bot.registry, placedBlock)) {
    return { ok: true };
  }

  return {
    ok: false,
    failure: {
      position: candidate.target,
      reason: "verification_failed",
      attempt,
      block_name: placedBlock?.name ?? null,
    },
  };
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
  readonly approachFeet: readonly TerrainBlockPos[];
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

    const approachFeet = createPlacementApproachFeet(target, bot.entity?.position);
    if (approachFeet.length === 0) {
      continue;
    }

    candidates.push({ target, supportPosition, approachFeet });
    if (candidates.length >= PLACEMENT_CANDIDATE_LIMIT) {
      return Object.freeze(candidates);
    }
  }

  return Object.freeze(candidates);
}

function createPlacementApproachFeet(
  target: MineflayerVec3Like,
  botPosition: MineflayerVec3Like | undefined,
): readonly TerrainBlockPos[] {
  const approaches: TerrainBlockPos[] = [];
  const addApproach = (foot: TerrainBlockPos) => {
    if (sameBlockFoot(foot, target)) {
      return;
    }
    if (approaches.some((existing) => sameTerrainFoot(existing, foot))) {
      return;
    }
    approaches.push(foot);
  };
  if (botPosition !== undefined) {
    const currentFoot = {
      x: Math.floor(botPosition.x),
      y: Math.floor(botPosition.y),
      z: Math.floor(botPosition.z),
    };
    if (calculateDistanceSquared(currentFoot, target) <= PLACE_REACH_DISTANCE ** 2) {
      addApproach(currentFoot);
    }
  }

  addApproach({ x: target.x + 1, y: target.y, z: target.z });
  addApproach({ x: target.x - 1, y: target.y, z: target.z });
  addApproach({ x: target.x, y: target.y, z: target.z + 1 });
  addApproach({ x: target.x, y: target.y, z: target.z - 1 });
  if (botPosition === undefined) {
    return Object.freeze(approaches);
  }

  return Object.freeze(
    approaches.sort(
      (left, right) =>
        calculateDistanceSquared(left, botPosition) - calculateDistanceSquared(right, botPosition),
    ),
  );
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

async function equipCraftingTableForPlace(
  bot: MineflayerBotHandle,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const item = findInventoryItemByName(bot, "crafting_table");
  if (item === null) {
    return { ok: false, reason: "missing_crafting_table_item" };
  }
  if (typeof bot.equip !== "function") {
    return { ok: false, reason: "equip_unavailable" };
  }

  await bot.equip(item, "hand");
  return { ok: true };
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

function sameBlockFoot(left: TerrainBlockPos, right: MineflayerVec3Like): boolean {
  return (
    left.x === Math.floor(right.x) &&
    left.y === Math.floor(right.y) &&
    left.z === Math.floor(right.z)
  );
}

function sameTerrainFoot(left: TerrainBlockPos, right: TerrainBlockPos): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function posLabel(position: MineflayerVec3Like): string {
  return `${position.x},${position.y},${position.z}`;
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/[\r\n;]+/gu, " ").slice(0, 240);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
