import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  createGoToSkillExecutionResult,
} from "../../core-ports/skills.js";
import { resolveGoalBlockConstructor } from "./pathfinder-goals.js";
import type {
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
} from "./types.js";

const DEFAULT_GO_TO_DIG_COST = 10;

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
  if (movements === null || typeof movements !== "object") {
    return;
  }

  /*
   * canDig（允许挖掘） 让寻路器在无可通行路线时才挖障碍；digCost（挖掘代价）
   * 提高挖掘路线成本，使普通草地移动优先于破坏方块。
   */
  Object.assign(movements, {
    canDig: true,
    digCost: DEFAULT_GO_TO_DIG_COST,
  });
}
