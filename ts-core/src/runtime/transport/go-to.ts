import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  type SkillExecutionControl,
  createGoToSkillExecutionResult,
} from "../../core-ports/skills.js";
import { createMineBlockFactReader } from "./block-facts.js";
import { navigateTerrainToFoot, vec3LikeToTerrainFoot } from "./terrain-navigation.js";
import type { TerrainBlockPos } from "./terrain-router.js";
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
  readonly control: SkillExecutionControl;
}): Promise<GoToSkillExecutionResult> {
  input.control.throwIfAborted();
  input.pathfinder.stop?.();
  input.pathfinder.setGoal?.(null);
  void input.pathfinderModule;

  const facts = createMineBlockFactReader(input.bot.registry);
  const diagnostics: string[] = [];
  const targetFoot = readTargetFoot(input.params);

  let totalSteps = 0;
  try {
    const navigation = await navigateTerrainToFoot({
      bot: input.bot,
      facts,
      targetFoot,
      goalRange: GOTO_GOAL_RANGE,
      allowPlaceUp: true,
      allowDig: true,
      diagnostics,
      diagnosticPrefix: "go_to",
      control: input.control,
      pathfinder: input.pathfinder,
      pathfinderModule: input.pathfinderModule,
    });
    totalSteps = navigation.totalSteps;
  } catch (error) {
    throw createGoToFailure({
      code: getErrorMessage(error).split(":")[0] ?? "terrain_route_execution_failed",
      params: input.params,
      diagnostics,
      position: input.bot.entity?.position,
      cause: error,
    });
  }

  diagnostics.push(`terrain_go_to_completed:steps=${totalSteps}`);
  return createGoToSkillExecutionResult(input.params, {
    world_key: input.worldKey,
    total_steps: totalSteps,
    diagnostics,
  });
}

function readTargetFoot(params: Readonly<GoToSkillParams>): TerrainBlockPos {
  return vec3LikeToTerrainFoot(params);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
