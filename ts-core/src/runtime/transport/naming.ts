import type { MineflayerItemHandle } from "./types.js";

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
