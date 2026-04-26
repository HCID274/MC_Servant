import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  createGoToSkillExecutionResult,
} from "../../core-ports/skills.js";
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
}): Promise<GoToSkillExecutionResult> {
  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  input.pathfinder.setMovements?.(movements);
  await input.pathfinder.goto(
    new input.pathfinderModule.goals.GoalBlock(input.params.x, input.params.y, input.params.z),
  );

  return createGoToSkillExecutionResult(input.params);
}
