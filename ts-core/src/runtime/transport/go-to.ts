import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  createGoToSkillExecutionResult,
} from "../../core-ports/skills.js";
import { TERRAIN_ACTION_COST, configureTerrainAwareMovements } from "./movement-policy.js";
import { resolveGoalBlockConstructor } from "./pathfinder-goals.js";
import type {
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
} from "./types.js";

/** 执行 goTo（前往坐标） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerGoTo(input: {
  readonly bot: MineflayerMovementPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<GoToSkillParams>;
  readonly worldKey: string | null;
}): Promise<GoToSkillExecutionResult> {
  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  const GoalBlock = resolveGoalBlockConstructor(input.pathfinderModule);
  configureGoToMovements(movements);
  input.pathfinder.setMovements?.(movements);
  await input.pathfinder.goto(new GoalBlock(input.params.x, input.params.y, input.params.z));

  return createGoToSkillExecutionResult(input.params, { world_key: input.worldKey });
}

/** 配置 goTo（前往坐标） 的 pathfinder（寻路器）移动代价。 */
export function configureGoToMovements(movements: unknown): void {
  configureTerrainAwareMovements(movements, {
    canDig: true,
    digCost: TERRAIN_ACTION_COST,
    placeCost: TERRAIN_ACTION_COST,
  });
}
