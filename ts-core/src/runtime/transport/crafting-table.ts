import type {
  MineflayerBlockHandle,
  MineflayerRegistryFacts,
  MineflayerVec3Like,
} from "./types.js";

/** runtime（运行时） 传输实例内的 crafting table（工作台） 位置缓存。 */
export interface CraftingTablePlacementCache {
  /** 最近一次由工具链确认可用的工作台位置。 */
  position: MineflayerVec3Like | null;
}

/** 判断方块是否为 crafting table（工作台）；事实来自 Mineflayer（Minecraft 客户端库） registry（注册表） 或方块快照。 */
export function isCraftingTableBlock(
  registry: unknown,
  block: MineflayerBlockHandle | null,
): boolean {
  if (block === null) {
    return false;
  }

  const craftingTableId = (registry as MineflayerRegistryFacts | undefined)?.blocksByName
    ?.crafting_table?.id;

  return (
    normalizeCraftingTableName(block.name ?? "") === "crafting_table" ||
    (craftingTableId !== undefined && block.type === craftingTableId)
  );
}

function normalizeCraftingTableName(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}
