import { RESOURCE_REFRESH_RADIUS_STEPS } from "../core-ports/runtime.js";
import {
  type MineSkillAdapter,
  type MineSkillExecutionResult,
  type MineSkillParams,
  type MineSkillTargetCandidate,
  createMineSkillExecutionResult,
} from "../core-ports/skills.js";
import type {
  ResourceClusterQueryResult,
  ResourceServiceBoundary,
} from "../world-model/contracts.js";

/** mine（挖掘） 装备只读端口，用于执行前确认手持工具。 */
export interface MineEquipmentReader {
  /** 读取当前主手物品标准名称。 */
  readMainHandItemName(): string | null;
}

/** 创建接入 ResourceService（资源服务） 与 StairBFSPlanner（阶梯规划器） runtime（运行时） 的 mine（挖掘） 技能执行器。 */
export function createMineSkillExecutor(input: {
  readonly resourceService: ResourceServiceBoundary;
  readonly miner: MineSkillAdapter;
  readonly equipment: MineEquipmentReader;
}): (params: Readonly<MineSkillParams>) => Promise<MineSkillExecutionResult> {
  return async (params) => {
    const blockName = normalizeMinecraftName(params.blockName);
    const diagnostics: string[] = [];

    assertSupportedMineTarget(blockName);
    assertMineToolEquipped({
      blockName,
      mainHandItemName: input.equipment.readMainHandItemName(),
    });

    const oreTargets = isOreMineTarget(blockName)
      ? await selectOreResourceTargets(input.resourceService, blockName, params.count)
      : undefined;

    let minedResult: MineSkillExecutionResult;

    try {
      minedResult = await input.miner.mine({
        blockName,
        count: params.count,
        worldKey: input.resourceService.query(blockName).world_key,
        ...(oreTargets === undefined ? {} : { targets: oreTargets }),
      });
    } catch (error) {
      throw createRuntimeMineFailureError(error, blockName, params.count);
    }

    diagnostics.push(...minedResult.diagnostics);
    if (minedResult.collected_count < params.count) {
      throw new Error(
        `drop_not_obtained:${minedResult.collected_item_name ?? blockName}:${minedResult.collected_count}/${params.count}:mine completed without enough inventory diff`,
      );
    }

    return createMineSkillExecutionResult(params, {
      world_key: minedResult.world_key,
      collected_item_name: minedResult.collected_item_name,
      collected_count: minedResult.collected_count,
      mined_count: minedResult.mined_count,
      diagnostics: [...diagnostics, "mine_completed_by_inventory_diff"],
      total_steps: minedResult.total_steps,
    });
  };
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

function assertMineToolEquipped(input: {
  readonly blockName: string;
  readonly mainHandItemName: string | null;
}): void {
  if (isHandMineTarget(input.blockName)) {
    return;
  }

  const tool = input.mainHandItemName;
  if (tool === null) {
    throw new Error(`not_equipped:${input.blockName}:main_hand_empty`);
  }

  if (input.blockName === "stone") {
    if (tool === "wooden_pickaxe" || tool === "stone_pickaxe") {
      return;
    }

    throw new Error(`not_equipped:${input.blockName}:requires_wooden_or_stone_pickaxe`);
  }

  if (tool !== "stone_pickaxe") {
    throw new Error(`not_equipped:${input.blockName}:requires_stone_pickaxe`);
  }
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

function isHandMineTarget(blockName: string): boolean {
  return blockName === "dirt" || blockName === "sand" || blockName === "gravel";
}

function normalizeMinecraftName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("minecraft:") ? trimmed.slice("minecraft:".length) : trimmed;
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
