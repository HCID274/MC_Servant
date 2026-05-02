import {
  type MineSkillExecutionResult,
  type MineSkillParams,
  createMineSkillExecutionResult,
} from "../../core-ports/skills.js";
import { normalizeMinecraftName } from "./naming.js";
import type {
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
} from "./types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";

/** mine（挖掘） 技能需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerMinePort = MineflayerMovementPort & MineflayerMiningPort;

/** 执行 mine（挖掘） 技能的 Mineflayer（Minecraft 协议客户端） 适配器。 */
export async function executeMineflayerMine(input: {
  readonly bot: MineflayerMinePort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly params: Readonly<MineSkillParams>;
}): Promise<MineSkillExecutionResult> {
  if (typeof input.bot.findBlocks !== "function") {
    throw new Error("Mineflayer bot handle does not expose findBlocks for mine");
  }
  if (!canReadMineflayerBlockAt(input.bot)) {
    throw new Error("Mineflayer bot handle does not expose blockAt for mine");
  }
  if (typeof input.bot.dig !== "function") {
    throw new Error("Mineflayer bot handle does not expose dig for mine");
  }

  const positions = await input.bot.findBlocks({
    matching: (block) =>
      normalizeMinecraftName(block.name) === normalizeMinecraftName(input.params.blockName),
    maxDistance: 32,
    count: input.params.count,
  });

  if (positions.length < input.params.count) {
    throw new Error(`Mineflayer cannot find enough ${input.params.blockName} blocks to mine`);
  }

  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  input.pathfinder.setMovements?.(movements);

  for (const position of positions.slice(0, input.params.count)) {
    const block = readMineflayerBlockAt(input.bot, position);

    if (block === null || block === undefined) {
      throw new Error(`Mineflayer cannot load target block for ${input.params.blockName}`);
    }

    await input.pathfinder.goto(
      new input.pathfinderModule.goals.GoalNear(position.x, position.y, position.z, 1),
    );
    await input.bot.dig(block);
  }

  return createMineSkillExecutionResult(input.params);
}
