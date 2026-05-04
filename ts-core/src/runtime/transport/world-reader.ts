import { Vec3 } from "vec3";
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

/** 兼容 Mineflayer（Minecraft 协议客户端） 原生 blockAt 对 Vec3（向量） floored() 的要求。 */
function createMineflayerBlockAtPosition(position: MineflayerVec3Like): MineflayerVec3Like {
  if (hasVec3Methods(position)) {
    return position;
  }

  return new Vec3(position.x, position.y, position.z);
}

function hasVec3Methods(position: MineflayerVec3Like): boolean {
  const candidate = position as MineflayerVec3Like & {
    readonly floored?: unknown;
    readonly offset?: unknown;
  };

  return typeof candidate.floored === "function" && typeof candidate.offset === "function";
}
