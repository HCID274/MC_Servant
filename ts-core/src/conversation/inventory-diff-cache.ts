import type { InventorySummary } from "../core-ports/observation.js";

/** inventory diff（背包差异） 单条 delta（增量）。 */
export interface ConversationInventoryDiffEntry {
  /** 标准物品标识。 */
  readonly item_name: string;
  /** 相对 baseline（基线） 的净变化量。 */
  readonly delta: number;
}

/** prompt（提示词） 构建期准备好的 inventory diff（背包差异） 上下文。 */
export interface ConversationInventoryDiffPromptContext {
  /** `[背包变化]` 行内容；为空表示整行省略。 */
  readonly inventoryChangeContext?: string;
  /** 在 prompt（提示词） 渲染完成后推进 baseline（基线）。 */
  advanceBaseline(): void;
}

/** ConversationWorker（对话工作线程） 侧 inventory diff cache（背包差异缓存）。 */
export interface ConversationInventoryDiffCache {
  /** 计算本轮 diff（差异），并返回延迟推进 baseline（基线） 的 prompt（提示词）上下文。 */
  preparePromptContext(input: {
    /** 目标 Bot（机器人） 标识。 */
    readonly bot_id: string;
    /** 当前 observation（观测） 背包快照。 */
    readonly inventory: InventorySummary;
  }): ConversationInventoryDiffPromptContext;
}

/** 创建进程内 inventory diff cache（背包差异缓存）。 */
export function createConversationInventoryDiffCache(
  input: {
    /** 可注入当前时间，测试用。 */
    readonly now?: () => number;
  } = {},
): ConversationInventoryDiffCache {
  const now = input.now ?? Date.now;
  const baselines = new Map<
    string,
    {
      readonly snapshot: ReadonlyMap<string, number>;
      readonly captured_at: number;
    }
  >();

  return Object.freeze({
    preparePromptContext(input: {
      readonly bot_id: string;
      readonly inventory: InventorySummary;
    }) {
      const { bot_id, inventory } = input;
      const currentSnapshot = createInventoryCountMap(inventory);
      const baseline = baselines.get(bot_id);
      const inventoryChangeContext =
        baseline === undefined
          ? undefined
          : renderInventoryDiff(baseline.snapshot, currentSnapshot);
      let advanced = false;

      return Object.freeze({
        ...(inventoryChangeContext === undefined ? {} : { inventoryChangeContext }),
        advanceBaseline() {
          if (advanced) {
            return;
          }

          advanced = true;
          baselines.set(bot_id, {
            snapshot: currentSnapshot,
            captured_at: now(),
          });
        },
      });
    },
  });
}

function createInventoryCountMap(inventory: InventorySummary): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const item of inventory.items) {
    counts.set(item.item_name, (counts.get(item.item_name) ?? 0) + item.count);
  }

  return counts;
}

function renderInventoryDiff(
  baseline: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): string | undefined {
  const entries = [...new Set([...baseline.keys(), ...current.keys()])]
    .map<ConversationInventoryDiffEntry>((itemName) =>
      Object.freeze({
        item_name: itemName,
        delta: (current.get(itemName) ?? 0) - (baseline.get(itemName) ?? 0),
      }),
    )
    .filter((entry) => entry.delta !== 0);

  if (entries.length === 0) {
    return undefined;
  }

  return entries
    .map((entry) => `${entry.item_name}${entry.delta > 0 ? "+" : ""}${entry.delta}`)
    .join(", ");
}
