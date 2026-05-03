import { describe, expect, it } from "vitest";

import { createConversationInventoryDiffCache } from "../conversation/index.js";
import type { InventorySummary } from "../core-ports/observation.js";

describe("conversation inventory diff cache（对话背包差异缓存）", () => {
  it("首次对话应省略背包变化并初始化 baseline（基线）", () => {
    const cache = createConversationInventoryDiffCache({ now: () => 1 });
    const first = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([
        ["oak_log", 3],
        ["cobblestone", 2],
      ]),
    });

    expect(first.inventoryChangeContext).toBeUndefined();
    first.advanceBaseline();

    const second = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([
        ["oak_log", 3],
        ["cobblestone", 2],
      ]),
    });

    expect(second.inventoryChangeContext).toBeUndefined();
  });

  it("净变化为零应省略整行", () => {
    const cache = createConversationInventoryDiffCache();
    const first = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([
        ["oak_log", 1],
        ["oak_log", 2],
      ]),
    });
    first.advanceBaseline();

    const second = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([["oak_log", 3]]),
    });

    expect(second.inventoryChangeContext).toBeUndefined();
  });

  it("应同时渲染正负 delta（增量）", () => {
    const cache = createConversationInventoryDiffCache();
    const first = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([
        ["oak_log", 1],
        ["cobblestone", 4],
      ]),
    });
    first.advanceBaseline();

    const second = cache.preparePromptContext({
      bot_id: "bot-inventory",
      inventory: createInventorySummary([
        ["oak_log", 6],
        ["cobblestone", 2],
        ["iron_ingot", 1],
      ]),
    });

    expect(second.inventoryChangeContext).toBe("oak_log+5, cobblestone-2, iron_ingot+1");
  });
});

function createInventorySummary(items: readonly (readonly [string, number])[]): InventorySummary {
  const entries = items.map(([itemName, count], index) =>
    Object.freeze({
      slot: index,
      item_name: itemName,
      count,
    }),
  );

  return Object.freeze({
    items: entries,
    total_items: entries.reduce((sum, item) => sum + item.count, 0),
    occupied_slots: entries.length,
    free_slots: 36 - entries.length,
  });
}
