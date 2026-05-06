import { configureGoToMovements } from "./go-to.js";
import { resolveGoalNearConstructor } from "./pathfinder-goals.js";
import type {
  MineflayerBlockHandle,
  MineflayerMiningPort,
  MineflayerMovementPort,
  MineflayerPathfinderApi,
  MineflayerPathfinderModule,
  MineflayerVec3Like,
} from "./types.js";
import { canReadMineflayerBlockAt, readMineflayerBlockAt } from "./world-reader.js";

/** 坐标挖掘需要的 Mineflayer（Minecraft 协议客户端） 能力端口。 */
export type MineflayerDigBlockAtPort = MineflayerMovementPort & MineflayerMiningPort;

const DIG_APPROACH_RANGE = 2;
const HIGH_COST_DIG_OR_PLACE = 100;
const DIRECT_DIG_FALLBACK_REACH = 4.5;

/** 挖掘指定坐标的单个方块；调用方负责决定该坐标来自哪个资源簇。 */
export async function executeMineflayerDigBlockAt(input: {
  readonly bot: MineflayerDigBlockAtPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly position: Readonly<MineflayerVec3Like>;
}): Promise<void> {
  if (!canReadMineflayerBlockAt(input.bot)) {
    throw new Error("Mineflayer bot handle does not expose blockAt for digBlockAt");
  }
  if (typeof input.bot.dig !== "function") {
    throw new Error("Mineflayer bot handle does not expose dig for digBlockAt");
  }

  const block = readMineflayerBlockAt(input.bot, input.position);

  if (block === null || block === undefined) {
    throw new Error("Mineflayer cannot load target block for digBlockAt");
  }

  if (canDigTargetFromCurrentPosition(input.bot, block, input.position)) {
    await input.bot.dig(block);
    return;
  }

  await approachDigTarget(input);
  const currentBlock = readMineflayerBlockAt(input.bot, input.position);

  if (currentBlock === null || currentBlock === undefined) {
    throw new Error("Mineflayer cannot load target block after digBlockAt approach");
  }

  await input.bot.dig(currentBlock);
}

async function approachDigTarget(input: {
  readonly bot: MineflayerDigBlockAtPort;
  readonly pathfinder: MineflayerPathfinderApi;
  readonly pathfinderModule: MineflayerPathfinderModule;
  readonly position: Readonly<MineflayerVec3Like>;
}): Promise<void> {
  const movements = new input.pathfinderModule.Movements(input.bot, input.bot.registry);
  const GoalNear = resolveGoalNearConstructor(input.pathfinderModule);
  configureDigApproachMovements(movements);
  input.pathfinder.setMovements?.(movements);
  await input.pathfinder.goto(
    new GoalNear(input.position.x, input.position.y, input.position.z, DIG_APPROACH_RANGE),
  );
}

function configureDigApproachMovements(movements: unknown): void {
  configureGoToMovements(movements);
  if (movements === null || typeof movements !== "object") {
    return;
  }

  /*
   * digBlockAt（按坐标挖掘） 的靠近阶段允许必要挖路 / 补坑，但这些路线成本必须
   * 足够高；同时禁止 1x1 tower（一格塔），避免为了树根目标原地垫高。
   */
  Object.assign(movements, {
    canDig: true,
    digCost: HIGH_COST_DIG_OR_PLACE,
    placeCost: HIGH_COST_DIG_OR_PLACE,
    allow1by1towers: false,
  });
}

function canDigTargetFromCurrentPosition(
  bot: MineflayerDigBlockAtPort,
  block: MineflayerBlockHandle,
  fallbackPosition: Readonly<MineflayerVec3Like>,
): boolean {
  if (typeof bot.canDigBlock === "function") {
    return bot.canDigBlock(block);
  }

  const botPosition = bot.entity?.position;
  const blockPosition = block.position ?? fallbackPosition;
  if (botPosition === undefined) {
    return false;
  }

  return (
    Math.hypot(
      blockPosition.x + 0.5 - botPosition.x,
      blockPosition.y + 0.5 - (botPosition.y + 1.65),
      blockPosition.z + 0.5 - botPosition.z,
    ) <= DIRECT_DIG_FALLBACK_REACH
  );
}
