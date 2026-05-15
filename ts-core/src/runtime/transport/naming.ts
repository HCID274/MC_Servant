import type { MineflayerItemHandle, MineflayerLifecyclePort } from "./types.js";

/** 规范化 Minecraft（我的世界） 标准名称。 */
export function normalizeMinecraftName(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_") ?? ""
  );
}

/** 判断物品句柄是否匹配目标标准名称。 */
export function matchesMinecraftItemName(item: MineflayerItemHandle, itemName: string): boolean {
  const expected = normalizeMinecraftName(itemName);

  return (
    normalizeMinecraftName(item.name) === expected ||
    normalizeMinecraftName(item.displayName) === expected
  );
}

/** 统一读取 Mineflayer（Minecraft 协议客户端） 当前世界键；transport 内部不得各自拼接 fallback。 */
export function readMineflayerWorldKey(bot: MineflayerLifecyclePort): string {
  return bot.game?.dimension ?? "unknown";
}
