import type { MineflayerBlockHandle, MineflayerMiningPort, MineflayerVec3Like } from "./types.js";

/** transport（传输层） 内唯一的 Mineflayer（Minecraft 协议客户端） 单点方块读取入口。 */
export function canReadMineflayerBlockAt(bot: MineflayerMiningPort): bot is MineflayerMiningPort & {
  blockAt(position: MineflayerVec3Like): MineflayerBlockHandle | null | undefined;
} {
  return typeof bot.blockAt === "function";
}

/** 读取指定坐标的方块，集中承接 T-NET-003 的多世界方块缓存适配前提。 */
export function readMineflayerBlockAt(
  bot: MineflayerMiningPort,
  position: MineflayerVec3Like,
): MineflayerBlockHandle | null {
  if (!canReadMineflayerBlockAt(bot)) {
    return null;
  }

  return bot.blockAt(position) ?? null;
}
