import { readMineflayerWorldKey } from "../naming.js";
import type { MineflayerLifecyclePort } from "../types.js";

const SELF_PLACED_TERRAIN_BLOCKS = new Set<string>();

interface TerrainMemoryBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 记录本进程内 Bot 自己放置的临时地形块，用于后续低风险回收通路。 */
export function recordSelfPlacedTerrainBlock(
  bot: MineflayerLifecyclePort,
  pos: TerrainMemoryBlockPos,
): void {
  SELF_PLACED_TERRAIN_BLOCKS.add(createSelfPlacedKey(bot, pos));
}

/** 判断坐标是否为本进程内 Bot 自己放置的临时地形块。 */
export function isSelfPlacedTerrainBlock(
  bot: MineflayerLifecyclePort,
  pos: TerrainMemoryBlockPos,
): boolean {
  return SELF_PLACED_TERRAIN_BLOCKS.has(createSelfPlacedKey(bot, pos));
}

/** 方块已被挖掉或变更后清理内存记录，避免过期坐标影响后续寻路。 */
export function forgetSelfPlacedTerrainBlock(
  bot: MineflayerLifecyclePort,
  pos: TerrainMemoryBlockPos,
): void {
  SELF_PLACED_TERRAIN_BLOCKS.delete(createSelfPlacedKey(bot, pos));
}

export function clearSelfPlacedTerrainMemoryForTests(): void {
  SELF_PLACED_TERRAIN_BLOCKS.clear();
}

function createSelfPlacedKey(bot: MineflayerLifecyclePort, pos: TerrainMemoryBlockPos): string {
  const botKey = bot.username ?? "unknown_bot";
  const worldKey = readMineflayerWorldKey(bot);
  return `${botKey}:${worldKey}:${pos.x}:${pos.y}:${pos.z}`;
}
