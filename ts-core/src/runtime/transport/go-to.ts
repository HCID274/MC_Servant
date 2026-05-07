import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  createGoToSkillExecutionResult,
} from "../../core-ports/skills.js";
import { createMineBlockFactReader } from "./mine-block-facts.js";
import { TERRAIN_ACTION_COST, configureTerrainAwareMovements } from "./movement-policy.js";
import { executeTerrainRouteAction, isTerrainBotAtFoot } from "./terrain-action-executor.js";
import { type TerrainBlockPos, planTerrainRoute } from "./terrain-router.js";
import type {
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
} from "./types.js";

type GoToBot = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

const GOTO_GOAL_RANGE = 1.5;

/** 执行 goTo：优先使用自研地形 BFS，避免依赖 pathfinder 的不稳定垫高路径。 */
export async function executeMineflayerGoTo(input: {
  readonly bot: GoToBot;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<GoToSkillParams>;
  readonly worldKey: string | null;
}): Promise<GoToSkillExecutionResult> {
  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);
  void input.pathfinderModule;

  const facts = createMineBlockFactReader(input.bot.registry);
  const diagnostics: string[] = [];
  const targetFoot = readTargetFoot(input.params);
  const startFoot = readBotFoot(input.bot);

  const planResult = planTerrainRoute({
    bot: input.bot,
    facts,
    startFoot,
    targetFoot,
    goalRange: GOTO_GOAL_RANGE,
    allowPlaceUp: true,
    allowDig: true,
  });
  diagnostics.push(...planResult.diagnostics);

  if (planResult.plan === null) {
    throw createGoToFailure({
      code: "terrain_route_not_found",
      params: input.params,
      diagnostics,
      position: input.bot.entity?.position,
    });
  }

  let totalSteps = 0;
  try {
    for (const action of planResult.plan.actions) {
      await executeTerrainRouteAction({
        bot: input.bot,
        facts,
        action,
        diagnostics,
      });
      totalSteps += 1;
    }
    if (!isTerrainBotAtFoot(input.bot, planResult.plan.finalFoot)) {
      throw new Error(`terrain_final_foot_mismatch:${posLabel(planResult.plan.finalFoot)}`);
    }
  } catch (error) {
    throw createGoToFailure({
      code: getErrorMessage(error).split(":")[0] ?? "terrain_route_execution_failed",
      params: input.params,
      diagnostics,
      position: input.bot.entity?.position,
      cause: error,
    });
  }

  diagnostics.push(`terrain_go_to_completed:steps=${totalSteps};cost=${planResult.plan.cost}`);
  return createGoToSkillExecutionResult(input.params, {
    world_key: input.worldKey,
    total_steps: totalSteps,
    diagnostics,
  });
}

/** 旧 digBlockAt 仍复用该移动策略；在线 goTo 默认不再走 pathfinder。 */
export function configureGoToMovements(movements: unknown): void {
  configureTerrainAwareMovements(movements, {
    canDig: true,
    digCost: TERRAIN_ACTION_COST,
    placeCost: TERRAIN_ACTION_COST,
  });
}

function readTargetFoot(params: Readonly<GoToSkillParams>): TerrainBlockPos {
  return Object.freeze({
    x: Math.floor(params.x),
    y: Math.floor(params.y),
    z: Math.floor(params.z),
  });
}

function readBotFoot(bot: GoToBot): TerrainBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

function createGoToFailure(input: {
  readonly code: string;
  readonly params: Readonly<GoToSkillParams>;
  readonly diagnostics: readonly string[];
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  readonly cause?: unknown;
}): Error {
  const message = input.cause === undefined ? input.code : getErrorMessage(input.cause);
  return Object.assign(new Error(message), {
    error_code: input.code,
    details: {
      failure_stage: "goTo",
      target: {
        x: input.params.x,
        y: input.params.y,
        z: input.params.z,
      },
      ...(input.position === undefined
        ? {}
        : {
            current_position: {
              x: input.position.x,
              y: input.position.y,
              z: input.position.z,
            },
          }),
      diagnostics: input.diagnostics,
    },
  });
}

function posLabel(pos: TerrainBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
