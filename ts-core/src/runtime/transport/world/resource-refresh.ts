import type {
  ResourceRefreshRadius,
  RuntimeResourceBlockSummary,
  RuntimeResourceRefreshResult,
} from "../../../core-ports/runtime.js";
import { cloneReadonlyValue } from "../../../domain/invariants.js";
import {
  blockMatchesResourceKey,
  createRuntimeResourceSemanticRoles,
  createRuntimeResourceTags,
  readBoolean,
  readRegistryBlockFactForBlock,
  registryCanResolveResourceKey,
} from "../facts/index.js";
import { stringifyMineflayerError } from "../lifecycle.js";
import { readMineflayerWorldKey } from "../naming.js";
import type { MineflayerBlockHandle, MineflayerBotHandle } from "../types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./reader.js";

const DEFAULT_RESOURCE_SCAN_COUNT = 512;

/** 执行 Mineflayer 只读资源扫描。 */
export async function executeMineflayerResourceRefresh(input: {
  readonly bot: MineflayerBotHandle;
  readonly resourceKey: string;
  readonly radius: ResourceRefreshRadius;
}): Promise<RuntimeResourceRefreshResult> {
  const origin = input.bot.entity?.position;
  const worldKey = readMineflayerWorldKey(input.bot);
  const scannedAt = Date.now();
  const snapshotVersion = `${worldKey}:${scannedAt}:${input.resourceKey}:${input.radius}`;

  if (origin === undefined) {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin: { x: 0, y: 0, z: 0 },
      blocks: [],
      diagnostics: ["runtime_unavailable", "bot_position_unavailable"],
    });
  }

  if (typeof input.bot.findBlocks !== "function" || !canReadMineflayerBlockAt(input.bot)) {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin,
      blocks: [],
      diagnostics: ["runtime_unavailable", "mineflayer_block_query_unavailable"],
    });
  }

  let positions: readonly { readonly x: number; readonly y: number; readonly z: number }[];

  try {
    positions = await input.bot.findBlocks({
      matching: (block) => blockMatchesResourceKey(input.bot.registry, block, input.resourceKey),
      maxDistance: input.radius,
      count: DEFAULT_RESOURCE_SCAN_COUNT,
    });
  } catch (error) {
    return createRuntimeResourceRefreshResult({
      input,
      status: "runtime_unavailable",
      worldKey,
      snapshotVersion,
      scannedAt,
      origin,
      blocks: [],
      diagnostics: [
        "runtime_unavailable",
        `resource_refresh_failed:${stringifyMineflayerError(error)}`,
      ],
    });
  }

  const blocks = positions
    .map((position) => readMineflayerBlockAt(input.bot, position))
    .filter((block): block is MineflayerBlockHandle => block !== null && block !== undefined)
    .filter((block) => blockMatchesResourceKey(input.bot.registry, block, input.resourceKey))
    .map((block) =>
      createRuntimeResourceBlockSummary({
        bot: input.bot,
        block,
        origin,
        resourceKey: input.resourceKey,
      }),
    )
    .sort((left, right) => left.distance - right.distance);
  const unsupportedResourceKey =
    blocks.length === 0 && !registryCanResolveResourceKey(input.bot.registry, input.resourceKey);

  return createRuntimeResourceRefreshResult({
    input,
    status:
      blocks.length > 0
        ? "found"
        : unsupportedResourceKey
          ? "unsupported_resource_key"
          : "cache_miss",
    worldKey,
    snapshotVersion,
    scannedAt,
    origin,
    blocks,
    diagnostics:
      blocks.length > 0
        ? []
        : unsupportedResourceKey
          ? [`unsupported_resource_key:${input.resourceKey}`]
          : ["cache_miss"],
  });
}

export function createRuntimeUnavailableResourceRefreshResult(input: {
  readonly resourceKey: string;
  readonly radius: ResourceRefreshRadius;
  readonly worldKey: string;
  readonly diagnostics: readonly string[];
}): RuntimeResourceRefreshResult {
  const scannedAt = Date.now();

  return cloneReadonlyValue({
    resource_key: input.resourceKey,
    radius: input.radius,
    status: "runtime_unavailable",
    world_key: input.worldKey,
    snapshot_version: `${input.worldKey}:${scannedAt}:${input.resourceKey}:${input.radius}`,
    scanned_at: scannedAt,
    origin: {
      x: 0,
      y: 0,
      z: 0,
    },
    blocks: [],
    diagnostics: input.diagnostics,
  });
}

function createRuntimeResourceRefreshResult(input: {
  readonly input: {
    readonly resourceKey: string;
    readonly radius: ResourceRefreshRadius;
  };
  readonly status: RuntimeResourceRefreshResult["status"];
  readonly worldKey: string;
  readonly snapshotVersion: string;
  readonly scannedAt: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly blocks: readonly RuntimeResourceBlockSummary[];
  readonly diagnostics: readonly string[];
}): RuntimeResourceRefreshResult {
  return cloneReadonlyValue({
    resource_key: input.input.resourceKey,
    radius: input.input.radius,
    status: input.status,
    world_key: input.worldKey,
    snapshot_version: input.snapshotVersion,
    scanned_at: input.scannedAt,
    origin: {
      x: input.origin.x,
      y: input.origin.y,
      z: input.origin.z,
    },
    blocks: input.blocks,
    diagnostics: input.diagnostics,
  });
}

function createRuntimeResourceBlockSummary(input: {
  readonly bot: MineflayerBotHandle;
  readonly block: MineflayerBlockHandle;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly resourceKey: string;
}): RuntimeResourceBlockSummary {
  const position = input.block.position ?? input.origin;
  const targetDiagnostics: string[] = [];
  const isDiggable = canDigRuntimeResourceBlock(input.bot.registry, input.block, targetDiagnostics);
  const isReachable = canReachRuntimeResourceBlock(input.bot, input.block, targetDiagnostics);

  return cloneReadonlyValue({
    block_name: input.block.name ?? "unknown",
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    distance: Math.hypot(
      position.x - input.origin.x,
      position.y - input.origin.y,
      position.z - input.origin.z,
    ),
    resource_keys: [input.resourceKey],
    resource_tags: createRuntimeResourceTags(input.bot.registry, input.block),
    semantic_roles: createRuntimeResourceSemanticRoles(input.bot.registry, input.block),
    is_diggable: isDiggable,
    is_reachable: isReachable,
    target_diagnostics: targetDiagnostics,
  });
}

function canDigRuntimeResourceBlock(
  registry: unknown,
  block: MineflayerBlockHandle,
  diagnostics: string[],
): boolean {
  if (block.diggable === false) {
    diagnostics.push("not_diggable");
    return false;
  }

  if (block.diggable === true) {
    return true;
  }

  const fact = readRegistryBlockFactForBlock(registry, block);
  if (readBoolean(fact?.diggable, false)) {
    return true;
  }

  diagnostics.push("diggable_fact_unavailable");
  return false;
}

function canReachRuntimeResourceBlock(
  bot: MineflayerBotHandle,
  block: MineflayerBlockHandle,
  diagnostics: string[],
): boolean {
  if (typeof bot.canSeeBlock === "function") {
    const canSee = bot.canSeeBlock(block);

    if (!canSee) {
      diagnostics.push("line_of_sight_blocked");
      diagnostics.push("reachability_deferred_to_skill");
    }

    return true;
  }

  diagnostics.push("reachability_deferred_to_skill");
  return true;
}
