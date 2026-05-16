import type { MineflayerLifecyclePort } from "../types.js";
import { isSelfPlacedTerrainBlock } from "./self-placed-memory.js";

interface TerrainResourceBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 判断资源刷新是否应排除某个地形块。
 *
 * 这是 terrain 对外的窄语义出口，隐藏 self-placed memory（自放置记忆） 的内部实现，
 * 避免 transport 根装配直接依赖 terrain 内部状态模块。
 */
export function shouldExcludeTerrainResourceBlock(
  bot: MineflayerLifecyclePort,
  pos: TerrainResourceBlockPos,
): boolean {
  return isSelfPlacedTerrainBlock(bot, pos);
}
