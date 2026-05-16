import { describe, expect, it } from "vitest";

import {
  type MineSkillExecutionResult,
  createMineSkillExecutionResult,
  createToolchainEnsureExecutor,
} from "../../index.js";
import {
  addInventory,
  countInventory,
  createFakeEnsureFacts,
  createMissingMaterialsFailure,
} from "./toolchain-ensure.fixture.js";

describe("skills/toolchain ensure 行为", () => {
  it("ToolchainEnsure（工具链确保） 应能从空手编排到石镐装备", async () => {
    const inventory: { item_name: string; count: number }[] = [];
    const actions: string[] = [];
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: (items) =>
          items.reduce((sum, item) => sum + (item.item_name === "oak_log" ? item.count : 0), 0),
      },
      async cutTree(params) {
        actions.push(`cutTree:${params.count}`);
        addInventory(inventory, "oak_log", Math.max(4, params.count));
        return {
          skill: "cutTree",
          requested_count: params.count,
          world_key: "minecraft:overworld",
          collected_count: Math.max(4, params.count),
          completed: true,
          status: "completed",
          clusters: [],
          diagnostics: [],
          total_steps: 1,
        };
      },
      async collect() {
        actions.push("collect");
        return {
          skill: "collect",
          item_name: null,
          center: { x: 0, y: 64, z: 0 },
          radius: 8,
          collected: [],
          skipped: [],
          total_steps: 1,
        };
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (params.itemName === "oak_planks" && countInventory(inventory, "oak_log") <= 0) {
          return createMissingMaterialsFailure("oak_planks", "oak_log", 1);
        }
        if (params.itemName === "wooden_pickaxe" && countInventory(inventory, "oak_log") <= 0) {
          return createMissingMaterialsFailure("wooden_pickaxe", "oak_planks", 3);
        }
        if (params.itemName === "stone_pickaxe" && countInventory(inventory, "cobblestone") < 3) {
          return createMissingMaterialsFailure(
            "stone_pickaxe",
            "cobblestone",
            3 - countInventory(inventory, "cobblestone"),
          );
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        if (countInventory(inventory, params.itemName) <= 0) {
          throw new Error(`missing_item:${params.itemName}`);
        }
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine(params) {
        actions.push(`mine:${params.blockName}:${params.count}`);
        addInventory(inventory, "cobblestone", params.count);
        return createMineSkillExecutionResult(params, {
          world_key: "minecraft:overworld",
          collected_item_name: "cobblestone",
          collected_count: params.count,
          mined_count: params.count,
          total_steps: params.count,
        });
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "iron_ore", count: 1 },
        code: "not_equipped",
        message: "not_equipped:iron_ore:requires_stone_pickaxe",
      },
      condition: { kind: "gained", itemName: "raw_iron", count: 1 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "stone_pickaxe",
        completed_count: 1,
        target_count: 1,
      },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        "craft:wooden_pickaxe",
        "cutTree:1",
        "mine:stone:3",
        "craft:stone_pickaxe",
        "equip:stone_pickaxe",
      ]),
    );
  });

  it("ToolchainEnsure（工具链确保） 应能为挖石头的未装备失败补木镐", async () => {
    const inventory: { item_name: string; count: number }[] = [];
    const actions: string[] = [];
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: (items) =>
          items.reduce((sum, item) => sum + (item.item_name === "oak_log" ? item.count : 0), 0),
      },
      async cutTree(params) {
        actions.push(`cutTree:${params.count}`);
        addInventory(inventory, "oak_log", Math.max(4, params.count));
        return {
          skill: "cutTree",
          requested_count: params.count,
          world_key: "minecraft:overworld",
          collected_count: Math.max(4, params.count),
          completed: true,
          status: "completed",
          clusters: [],
          diagnostics: [],
          total_steps: 1,
        };
      },
      async collect() {
        actions.push("collect");
        return {
          skill: "collect",
          item_name: null,
          center: { x: 0, y: 64, z: 0 },
          radius: 8,
          collected: [],
          skipped: [],
          total_steps: 1,
        };
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (params.itemName === "oak_planks" && countInventory(inventory, "oak_log") <= 0) {
          return createMissingMaterialsFailure("oak_planks", "oak_log", 1);
        }
        if (params.itemName === "wooden_pickaxe" && countInventory(inventory, "oak_log") <= 0) {
          return createMissingMaterialsFailure("wooden_pickaxe", "oak_planks", 3);
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        if (countInventory(inventory, params.itemName) <= 0) {
          throw new Error(`missing_item:${params.itemName}`);
        }
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine() {
        throw new Error("mine should be retried by ensure caller, not dependency resolver");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "stone", count: 5 },
        code: "not_equipped",
        message: "not_equipped:stone:requires_wooden_or_stone_pickaxe",
      },
      condition: { kind: "gained", itemName: "cobblestone", count: 5 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "wooden_pickaxe",
        completed_count: 1,
      },
    });
    expect(actions).toEqual(
      expect.arrayContaining(["cutTree:1", "craft:wooden_pickaxe", "equip:wooden_pickaxe"]),
    );
    expect(actions).not.toContain("craft:stone_pickaxe");
  });

  it("ToolchainEnsure（工具链确保） 恢复合成缺料时应接受 facts 解析出的等价原木且不重复 collect", async () => {
    const inventory: { item_name: string; count: number }[] = [];
    const actions: string[] = [];
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: (items) =>
          items
            .filter((item) => item.item_name.endsWith("_log"))
            .reduce((sum, item) => sum + item.count, 0),
      },
      async cutTree(params) {
        actions.push(`cutTree:${params.count}`);
        addInventory(inventory, "cherry_log", Math.max(1, params.count));
        return {
          skill: "cutTree",
          requested_count: params.count,
          world_key: "minecraft:overworld",
          collected_count: Math.max(1, params.count),
          completed: true,
          status: "completed",
          clusters: [],
          diagnostics: [],
          total_steps: 1,
        };
      },
      async collect() {
        throw new Error(
          "cutTree success already proves material recovery; collect must not repeat",
        );
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (
          params.itemName === "wooden_pickaxe" &&
          countInventory(inventory, "oak_log") + countInventory(inventory, "cherry_log") <= 0
        ) {
          return createMissingMaterialsFailure("wooden_pickaxe", "oak_log", 1);
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        if (countInventory(inventory, params.itemName) <= 0) {
          throw new Error(`missing_item:${params.itemName}`);
        }
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine() {
        throw new Error("dependency resolver should not retry original mine action");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "stone", count: 4 },
        code: "not_equipped",
        message: "not_equipped:stone:requires_harvest_tool",
      },
      condition: { kind: "gainedDropOf", blockName: "stone", count: 4 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "wooden_pickaxe",
        completed_count: 1,
      },
    });
    expect(actions).toEqual([
      "craft:wooden_pickaxe",
      "cutTree:1",
      "craft:wooden_pickaxe",
      "equip:wooden_pickaxe",
    ]);
  });

  it("ToolchainEnsure（工具链确保） 应在 mine action 前预检并补齐采掘工具", async () => {
    const inventory: { item_name: string; count: number }[] = [{ item_name: "oak_log", count: 4 }];
    const actions: string[] = [];
    let tablePlaced = false;
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: (items) =>
          items.reduce((sum, item) => sum + (item.item_name === "oak_log" ? item.count : 0), 0),
      },
      async cutTree() {
        throw new Error("preflight should use current materials before cutting trees");
      },
      async collect() {
        throw new Error("preflight should not collect");
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        tablePlaced = true;
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (params.itemName === "wooden_pickaxe" && !tablePlaced) {
          return {
            ok: false,
            error: {
              code: "missing_crafting_table",
              message: "Craft target requires a nearby crafting table",
              world_key: "minecraft:overworld",
            },
          };
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        if (countInventory(inventory, params.itemName) <= 0) {
          throw new Error(`missing_item:${params.itemName}`);
        }
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine() {
        throw new Error("preflight must not start mining");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "stone", count: 5 },
        code: "preflight_mine_equipment",
        message: "ensure preflight mine equipment",
      },
      condition: { kind: "gainedDropOf", blockName: "stone", count: 5 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "wooden_pickaxe",
        completed_count: 1,
      },
    });
    expect(actions).toEqual([
      "craft:wooden_pickaxe",
      "craft:crafting_table",
      "place:crafting_table",
      "craft:wooden_pickaxe",
      "equip:wooden_pickaxe",
    ]);
  });

  it("ToolchainEnsure（工具链确保） 缺工作台物品时应先合成并放置，再回到原合成目标", async () => {
    const inventory: { item_name: string; count: number }[] = [
      { item_name: "cobblestone", count: 3 },
      { item_name: "stick", count: 2 },
    ];
    const actions: string[] = [];
    let tablePlaced = false;
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: () => 0,
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        if (countInventory(inventory, "crafting_table") <= 0) {
          return {
            ok: false,
            error: {
              code: "missing_crafting_table_item",
              message: "Crafting table item is not available for placement",
              world_key: "minecraft:overworld",
            },
          };
        }
        tablePlaced = true;
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (params.itemName === "stone_pickaxe" && !tablePlaced) {
          return {
            ok: false,
            error: {
              code: "missing_crafting_table",
              message: "Craft target requires a nearby crafting table",
              world_key: "minecraft:overworld",
            },
          };
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine() {
        throw new Error("mine should not run when materials are already present");
      },
      async collect() {
        throw new Error("collect should not run");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "iron_ore", count: 1 },
        code: "not_equipped",
        message: "not_equipped:iron_ore:requires_stone_pickaxe",
      },
      condition: { kind: "gainedDropOf", blockName: "iron_ore", count: 1 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "stone_pickaxe",
        completed_count: 1,
      },
    });
    expect(actions).toEqual([
      "craft:stone_pickaxe",
      "craft:crafting_table",
      "place:crafting_table",
      "craft:stone_pickaxe",
      "equip:stone_pickaxe",
    ]);
  });

  it("ToolchainEnsure（工具链确保） 应保留底层失败原因与动作摘要", async () => {
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => [{ item_name: "crafting_table", count: 1 }],
        countLogs: () => 0,
      },
      async craft() {
        return {
          ok: false,
          error: {
            code: "missing_materials",
            message: "Inventory does not contain enough recipe ingredients",
            world_key: "minecraft:overworld",
          },
        };
      },
      async place() {
        return {
          ok: false,
          error: {
            code: "no_placeable_position",
            message: "No placeable position nearby",
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip() {
        throw new Error("missing_item:wooden_pickaxe");
      },
      async mine() {
        throw new Error("runtime_mine_failed:test");
      },
      async collect() {
        throw new Error("collect should not run");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "craft",
        params: { itemName: "stone_pickaxe", count: 1 },
        code: "missing_crafting_table",
        message: "Craft target requires a nearby crafting table",
      },
      condition: { kind: "gained", itemName: "stone_pickaxe", count: 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "no_placeable_position",
      },
    });
    expect(result.ok ? [] : result.error.details?.actions).toEqual([
      {
        action: "place",
        target: "crafting_table",
        requested_count: 1,
        completed_count: 0,
        status: "failed",
        world_key: "minecraft:overworld",
        reason: "no_placeable_position",
      },
    ]);
  });

  it("ToolchainEnsure（工具链确保） mine 恢复缺完成证明时不得用 total_steps 伪造成成功", async () => {
    const inventory: { item_name: string; count: number }[] = [
      { item_name: "wooden_pickaxe", count: 1 },
    ];
    const ensure = createToolchainEnsureExecutor({
      readCurrentWorldKey: () => "minecraft:overworld",
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: () => 0,
      },
      async equip(params) {
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine() {
        return {
          skill: "mine",
          block_name: "stone",
          total_steps: 1,
        } as unknown as MineSkillExecutionResult;
      },
      async craft() {
        throw new Error("craft should not run");
      },
      async place() {
        throw new Error("place should not run");
      },
      async collect() {
        throw new Error("collect should not run");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "stone", count: 1 },
        code: "condition_not_met",
        message: "condition_not_met",
        details: { missing_count: 1 },
      },
      condition: { kind: "gainedDropOf", blockName: "stone", count: 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unknown_completion",
        details: {
          action: "mine",
          target: "stone",
          requested_count: 1,
          missing_fields: ["collected_count", "mined_count"],
          result_summary: {
            skill: "mine",
            total_steps: 1,
          },
          actions: expect.arrayContaining([
            expect.objectContaining({
              action: "mine",
              target: "stone",
              requested_count: 1,
              completed_count: 0,
              status: "failed",
              reason: "unknown_completion",
            }),
          ]),
        },
      },
    });
  });

  it("ToolchainEnsure（工具链确保） 合成石镐缺 1 个圆石时应补到目标总数", async () => {
    const inventory: { item_name: string; count: number }[] = [
      { item_name: "cobblestone", count: 2 },
      { item_name: "wooden_pickaxe", count: 1 },
    ];
    const actions: string[] = [];
    const ensure = createToolchainEnsureExecutor({
      readCurrentWorldKey: () => "minecraft:overworld",
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => inventory,
        countLogs: () => 0,
      },
      async place(params) {
        actions.push(`place:${params.blockName}`);
        return {
          ok: true,
          data: {
            block_name: params.blockName,
            completed_count: 1,
            world_key: "minecraft:overworld",
          },
        };
      },
      async craft(params) {
        actions.push(`craft:${params.itemName}`);
        if (params.itemName === "stone_pickaxe" && countInventory(inventory, "cobblestone") < 3) {
          return createMissingMaterialsFailure(
            "stone_pickaxe",
            "cobblestone",
            3 - countInventory(inventory, "cobblestone"),
          );
        }
        addInventory(inventory, params.itemName, params.count);
        return {
          ok: true,
          data: {
            item_name: params.itemName,
            completed_count: params.count,
            world_key: "minecraft:overworld",
          },
        };
      },
      async equip(params) {
        actions.push(`equip:${params.itemName}`);
        return {
          skill: "equip",
          item_name: params.itemName,
          destination: "hand",
          status: "equipped",
          total_steps: 1,
        };
      },
      async mine(params) {
        actions.push(`mine:${params.blockName}:${params.count}`);
        addInventory(inventory, "cobblestone", params.count);
        return createMineSkillExecutionResult(params, {
          world_key: "minecraft:overworld",
          collected_item_name: "cobblestone",
          collected_count: params.count,
          mined_count: params.count,
          total_steps: params.count,
        });
      },
      async collect() {
        throw new Error("collect should not run");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "mine",
        params: { blockName: "iron_ore", count: 1 },
        code: "not_equipped",
        message: "not_equipped:iron_ore:requires_stone_pickaxe",
      },
      condition: { kind: "gained", itemName: "raw_iron", count: 1 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        item_name: "stone_pickaxe",
        world_key: "minecraft:overworld",
      },
    });
    expect(actions).toContain("mine:stone:1");
    expect(actions.filter((action) => action === "craft:stone_pickaxe")).toHaveLength(2);
  });

  it("ToolchainEnsure（工具链确保） 不再暴露具体原木确保入口", async () => {
    let cutTreeCalls = 0;
    const ensure = createToolchainEnsureExecutor({
      readCurrentWorldKey: () => "minecraft:overworld",
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => [{ item_name: "oak_log", count: 8 }],
        countLogs: (items) =>
          items.reduce((sum, item) => sum + (item.item_name === "oak_log" ? item.count : 0), 0),
      },
      async cutTree() {
        cutTreeCalls += 1;
        throw new Error("cutTree should not run");
      },
      async craft() {
        throw new Error("craft should not run");
      },
      async place() {
        throw new Error("place should not run");
      },
      async equip() {
        throw new Error("equip should not run");
      },
      async mine() {
        throw new Error("mine should not run");
      },
      async collect() {
        throw new Error("collect should not run");
      },
    });

    const result = await ensure.ensureDependency({
      failure: {
        action: "unknown",
        params: {},
        code: "unsupported_capability",
        message: "unsupported",
      },
      condition: { kind: "gained", itemName: "oak_log", count: 4 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_capability",
      },
    });
    expect(cutTreeCalls).toBe(0);
  });
});
