import type { SkillExecutionControl } from "../../../core-ports/skills.js";
import type { MineBlockFactReader } from "../block-facts.js";
import type {
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerPlacementPort,
  MineflayerVec3Like,
} from "../types.js";
import { executeTerrainRouteAction, isTerrainBotAtFoot } from "./action-executor.js";
import {
  type TerrainBlockPos,
  type TerrainRouteBudget,
  type TerrainRouteProfile,
  planTerrainRoute,
} from "./router.js";

export type TerrainNavigationBot = MineflayerMovementPort &
  MineflayerMiningPort &
  MineflayerPlacementPort &
  MineflayerInventoryPort;

export interface TerrainNavigationResult {
  readonly finalFoot: TerrainBlockPos;
  readonly totalSteps: number;
  readonly cost: number;
}

/** 用自研 terrain-router 执行“靠近目标 foot”的通用移动，供 goTo/collect/place 共享。 */
export async function navigateTerrainToFoot(input: {
  readonly bot: TerrainNavigationBot;
  readonly facts: MineBlockFactReader;
  readonly targetFoot: TerrainBlockPos;
  readonly goalRange?: number;
  readonly goalYRange?: number;
  readonly allowPlaceUp?: boolean;
  readonly allowDig?: boolean;
  readonly routeProfile?: TerrainRouteProfile;
  readonly routeBudget?: TerrainRouteBudget;
  readonly diagnostics: string[];
  readonly diagnosticPrefix: string;
  readonly control: SkillExecutionControl;
  readonly pathfinder?: MineflayerPathfinderApi;
  readonly pathfinderModule?: MineflayerPathfinderModule;
}): Promise<TerrainNavigationResult> {
  input.control.throwIfAborted();
  const startFoot = readTerrainBotFoot(input.bot);
  const planResult = planTerrainRoute({
    bot: input.bot,
    facts: input.facts,
    startFoot,
    targetFoot: input.targetFoot,
    ...(input.goalRange === undefined ? {} : { goalRange: input.goalRange }),
    ...(input.goalYRange === undefined ? {} : { goalYRange: input.goalYRange }),
    ...(input.allowPlaceUp === undefined ? {} : { allowPlaceUp: input.allowPlaceUp }),
    ...(input.allowDig === undefined ? {} : { allowDig: input.allowDig }),
    ...(input.routeProfile === undefined ? {} : { routeProfile: input.routeProfile }),
    ...(input.routeBudget === undefined ? {} : { routeBudget: input.routeBudget }),
  });
  input.diagnostics.push(
    ...planResult.diagnostics.map((entry) => `${input.diagnosticPrefix}:${entry}`),
  );

  if (planResult.plan === null) {
    const error = new Error(
      `${input.diagnosticPrefix}_terrain_route_not_found:${posLabel(input.targetFoot)}`,
    ) as Error & { error_code?: string; details?: Readonly<Record<string, unknown>> };
    error.error_code = "unreachable_target";
    error.details = Object.freeze({
      failure_stage: input.diagnosticPrefix,
      target_foot: input.targetFoot,
      diagnostics: Object.freeze([...input.diagnostics]),
    });
    throw error;
  }

  let totalSteps = 0;
  for (const action of planResult.plan.actions) {
    input.control.throwIfAborted();
    await executeTerrainRouteAction({
      bot: input.bot,
      facts: input.facts,
      action,
      diagnostics: input.diagnostics,
      control: input.control,
      ...(input.pathfinder === undefined ? {} : { pathfinder: input.pathfinder }),
      ...(input.pathfinderModule === undefined ? {} : { pathfinderModule: input.pathfinderModule }),
    });
    totalSteps += 1;
  }
  input.control.throwIfAborted();

  if (!isTerrainBotAtFoot(input.bot, planResult.plan.finalFoot)) {
    throw new Error(
      `${input.diagnosticPrefix}_terrain_final_foot_mismatch:${posLabel(planResult.plan.finalFoot)}`,
    );
  }

  input.diagnostics.push(
    `${input.diagnosticPrefix}:terrain_navigation_completed:steps=${totalSteps};cost=${planResult.plan.cost}`,
  );
  return Object.freeze({
    finalFoot: planResult.plan.finalFoot,
    totalSteps,
    cost: planResult.plan.cost,
  });
}

export function readTerrainBotFoot(bot: MineflayerMovementPort): TerrainBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

export function vec3LikeToTerrainFoot(position: Readonly<MineflayerVec3Like>): TerrainBlockPos {
  return Object.freeze({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

function posLabel(pos: TerrainBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}
