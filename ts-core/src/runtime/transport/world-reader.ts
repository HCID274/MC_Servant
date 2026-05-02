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

  return bot.blockAt(createMineflayerBlockAtPosition(position)) ?? null;
}

type MineflayerBlockAtPosition = MineflayerVec3Like & {
  floored(): MineflayerBlockAtPosition;
};

/** 兼容 Mineflayer（Minecraft 协议客户端） 原生 blockAt 对 Vec3（向量） floored() 的要求。 */
function createMineflayerBlockAtPosition(position: MineflayerVec3Like): MineflayerVec3Like {
  if (hasFloored(position)) {
    return position;
  }

  const compatiblePosition: MineflayerBlockAtPosition = {
    x: position.x,
    y: position.y,
    z: position.z,
    floored() {
      return {
        x: Math.floor(this.x),
        y: Math.floor(this.y),
        z: Math.floor(this.z),
        floored: this.floored,
      };
    },
  };

  return compatiblePosition;
}

function hasFloored(position: MineflayerVec3Like): position is MineflayerBlockAtPosition {
  return typeof (position as MineflayerVec3Like & { floored?: unknown }).floored === "function";
}
