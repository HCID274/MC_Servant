import { describe, expect, it } from "vitest";
import { createCodeJobForSkill } from "./test-code-job.js";

import {
  CRAFT_SERVICE_ALLOWED_TARGETS,
  ExecPriority,
  ExecutionTaskKind,
  FORBIDDEN_TOOLCHAIN_DEMO_NAMES,
  PHASE1_SKILL_DEFINITIONS,
  PHASE1_SKILL_NAMES,
  PLACEMENT_SERVICE_ALLOWED_BLOCKS,
  SKILL_DIRECTORY,
  type SkillCallInput,
  type SkillName,
  type SkillParamsByName,
  TOOLCHAIN_CAPABILITY_NAMES,
  TOOLCHAIN_FAILURE_CODES,
  type ToolchainCapabilityName,
  type ToolchainCapabilityResult,
  type ToolchainEnsureFacts,
  createCraftService,
  createMineSkillExecutionResult,
  createPhase1SkillRegistry,
  createPlacementService,
  createSkillCall,
  createSkillRegistry,
  createToolchainEnsureExecutor,
  evaluateEnsureCondition,
  getSkillDefinition,
  hasSkillDefinition,
  isCollectSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
  listSkillDefinitions,
  registerSkillDefinition,
} from "../index.js";

const validEquipParams: SkillParamsByName["equip"] = {
  itemName: "stone_pickaxe",
  destination: "hand",
};
void validEquipParams;

// @ts-expect-error Phase 1（第一阶段） 技能目录不包含 follow。
const invalidSkillName: SkillName = "follow";
void invalidSkillName;

// @ts-expect-error `equip`（装备） 参数不接受挖掘计数字段。
const invalidEquipParams: SkillParamsByName["equip"] = { itemName: "stone_pickaxe", count: 1 };
void invalidEquipParams;

const validToolchainCapabilityName: ToolchainCapabilityName = "craft";
void validToolchainCapabilityName;

// @ts-expect-error `demoMineIron`（演示挖铁） 不允许成为可复用工具链能力。
const invalidToolchainCapabilityName: ToolchainCapabilityName = "demoMineIron";
void invalidToolchainCapabilityName;

const invalidSkillCallInput: SkillCallInput = {
  skill: SKILL_DIRECTORY.goTo,
  // @ts-expect-error `goTo`（前往坐标） 与 `count`（数量） 参数形态不对齐。
  params: { count: 2 },
};
void invalidSkillCallInput;

describe("skills 模块契约", () => {
  it("应暴露五个 Phase 1 技能目录与参数校验器", () => {
    expect(PHASE1_SKILL_NAMES).toEqual(["goTo", "mine", "cutTree", "collect", "equip"]);
    expect(SKILL_DIRECTORY.cutTree).toBe("cutTree");
    expect(isGoToSkillParams({ x: 1, y: 64, z: -3 })).toBe(true);
    expect(isGoToSkillParams({ x: 1, y: 64 })).toBe(false);
    expect(isMineSkillParams({ blockName: "stone", count: 3 })).toBe(true);
    expect(isMineSkillParams({ blockName: "stone", count: 0 })).toBe(false);
    expect(
      isCollectSkillParams({ itemName: "oak_log", center: { x: 1, y: 64, z: -2 }, radius: 32 }),
    ).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 8 })).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 31 })).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 64 })).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 0 })).toBe(false);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 65 })).toBe(false);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: -1 })).toBe(false);
    expect(isEquipSkillParams({ itemName: "bread" })).toBe(true);
    expect(isEquipSkillParams({ itemName: "bread", destination: "hand" })).toBe(true);
    expect(isEquipSkillParams({ itemName: "bread", destination: "off-hand" })).toBe(false);
  });

  it("应支持注册表查找、注册与只读列举边界", () => {
    const emptyRegistry = createSkillRegistry();
    const partialRegistry = registerSkillDefinition(emptyRegistry, PHASE1_SKILL_DEFINITIONS[0]);
    const phase1Registry = createPhase1SkillRegistry();
    const listedDefinitions = listSkillDefinitions(phase1Registry);

    expect(Object.isFrozen(emptyRegistry)).toBe(true);
    expect(getSkillDefinition(emptyRegistry, SKILL_DIRECTORY.goTo)).toBeUndefined();
    expect(hasSkillDefinition(partialRegistry, SKILL_DIRECTORY.goTo)).toBe(true);
    expect(listedDefinitions.map((definition) => definition.name)).toEqual([...PHASE1_SKILL_NAMES]);
    expect(Object.isFrozen(listedDefinitions)).toBe(true);
    expect(getSkillDefinition(phase1Registry, SKILL_DIRECTORY.equip)?.metadata).toEqual({
      category: "inventory",
      summary: "按物品名与槽位执行装备",
      parameterKeys: ["itemName", "destination"],
    });
  });

  it("应声明工具链能力、结构化失败码并禁止 demo（演示） 一键入口", () => {
    const failureResult: ToolchainCapabilityResult<{ readonly world_key: string | null }> = {
      ok: false,
      error: {
        code: "missing_materials",
        message: "缺少木棍",
        world_key: "minecraft:overworld",
      },
    };
    const successResult: ToolchainCapabilityResult<{
      readonly world_key: string | null;
      readonly completed_count: number;
    }> = {
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 1,
      },
    };

    expect(TOOLCHAIN_CAPABILITY_NAMES).toEqual([
      "craft",
      "place",
      "placeCraftingTable",
      "equip",
      "mine",
      "ensure",
    ]);
    expect(FORBIDDEN_TOOLCHAIN_DEMO_NAMES).toEqual(["demoMineIron"]);
    expect(TOOLCHAIN_CAPABILITY_NAMES).not.toContain("demoMineIron");
    expect(TOOLCHAIN_FAILURE_CODES).toEqual(
      expect.arrayContaining([
        "missing_materials",
        "missing_crafting_table",
        "recipe_not_found",
        "runtime_craft_failed",
        "missing_crafting_table_item",
        "no_placeable_position",
        "place_failed",
        "cached_position_invalid",
        "cannot_place",
        "missing_item",
        "runtime_equip_failed",
        "not_equipped",
        "resource_not_found",
        "unsafe_path",
        "world_mismatch",
      ]),
    );
    expect(failureResult.ok).toBe(false);
    expect(failureResult.error.code).toBe("missing_materials");
    expect(successResult.ok).toBe(true);
    expect(successResult.data.completed_count).toBe(1);
  });

  it("PlacementService（放置服务） 应只允许 crafting table（工作台） 并委托 runtime（运行时）", async () => {
    const calls: unknown[] = [];
    const placementService = createPlacementService({
      runtime: {
        async place(params) {
          calls.push(params);
          return {
            ok: true,
            data: {
              world_key: "minecraft:overworld",
              completed_count: 1,
              block_name: params.blockName,
              position: { x: 1, y: 64, z: 2 },
            },
          };
        },
      },
    });

    await expect(placementService.placeCraftingTable()).resolves.toMatchObject({
      ok: true,
      data: {
        block_name: "crafting_table",
      },
    });
    await expect(
      placementService.place({ blockName: "torch", near: { x: 1, y: 64, z: 2 } }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unsupported_capability",
      },
    });

    expect(PLACEMENT_SERVICE_ALLOWED_BLOCKS).toEqual(["crafting_table"]);
    expect(calls).toEqual([{ blockName: "crafting_table" }]);
  });

  it("CraftService（合成服务） 应只做 allowlist（白名单） 边界并委托 runtime（运行时） 校验事实", async () => {
    const calls: unknown[] = [];
    const craftService = createCraftService({
      runtime: {
        async craft(params) {
          calls.push(params);
          return {
            ok: true,
            data: {
              world_key: "minecraft:overworld",
              completed_count: params.count,
              item_name: params.itemName,
            },
          };
        },
      },
    });

    await expect(craftService.craft({ itemName: "sticks", count: 2 })).resolves.toEqual({
      ok: true,
      data: {
        world_key: "minecraft:overworld",
        completed_count: 2,
        item_name: "stick",
      },
    });
    await expect(craftService.craft({ itemName: "iron_ingot", count: 1 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unsupported_capability",
      },
    });
    await expect(craftService.craft({ itemName: "stick", count: 0 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unsupported_capability",
      },
    });

    expect(CRAFT_SERVICE_ALLOWED_TARGETS).toEqual([
      "planks",
      "stick",
      "sticks",
      "crafting_table",
      "wooden_pickaxe",
      "stone_pickaxe",
    ]);
    expect(calls).toEqual([{ itemName: "stick", count: 2 }]);
  });

  it("ensure condition checker（条件检查器） 应区分 gained baseline diff 与 has 当前总量", () => {
    const facts = createFakeEnsureFacts();
    const baseline = createConditionState([{ item_name: "cobblestone", count: 10 }]);
    const current = createConditionState([{ item_name: "cobblestone", count: 12 }]);

    expect(
      evaluateEnsureCondition({
        facts,
        baseline,
        current,
        condition: { kind: "gained", itemName: "cobblestone", count: 5 },
      }),
    ).toMatchObject({
      ok: false,
      completed_count: 2,
      target_count: 5,
      missing_count: 3,
    });
    expect(
      evaluateEnsureCondition({
        facts,
        baseline,
        current,
        condition: { kind: "has", itemName: "cobblestone", count: 10 },
      }),
    ).toMatchObject({
      ok: true,
      completed_count: 12,
      target_count: 10,
      missing_count: 0,
    });
  });

  it("ensure condition checker（条件检查器） 应通过 facts 解析 gainedDropOf 和 tag 数量", () => {
    const facts = createFakeEnsureFacts();
    const current = createConditionState([
      { item_name: "cobblestone", count: 6 },
      { item_name: "oak_log", count: 3 },
    ]);

    expect(
      evaluateEnsureCondition({
        facts,
        baseline: createConditionState([{ item_name: "cobblestone", count: 1 }]),
        current,
        condition: { kind: "gainedDropOf", blockName: "stone", count: 5 },
      }),
    ).toMatchObject({
      ok: true,
      completed_count: 5,
      resolved_targets: ["cobblestone"],
    });
    expect(
      evaluateEnsureCondition({
        facts,
        baseline: createConditionState([]),
        current,
        condition: { kind: "gainedTag", tagName: "logs", count: 3 },
      }),
    ).toMatchObject({
      ok: true,
      completed_count: 3,
    });
  });

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
      "place:crafting_table",
      "craft:wooden_pickaxe",
      "equip:wooden_pickaxe",
    ]);
  });

  it("ToolchainEnsure（工具链确保） 应保留底层失败原因与动作摘要", async () => {
    const ensure = createToolchainEnsureExecutor({
      facts: createFakeEnsureFacts(),
      inventory: {
        readInventoryItems: () => [],
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

  it("应让 code 构造与运行时任务共享同一套强类型目录", () => {
    const codeInvocation = createSkillCall({
      skill: SKILL_DIRECTORY.collect,
      params: {
        itemName: "oak_log",
        radius: 32,
      },
    });
    const codeJob = createCodeJobForSkill({
      message_id: "msg-skill-call",
      intent_epoch: 3,
      snapshot_ts: 1_712_930_100,
      priority: ExecPriority.Urgent,
      skill: SKILL_DIRECTORY.cutTree,
      params: { count: 2 },
    });

    expect(codeInvocation.skill).toBe("collect");
    expect(codeInvocation.params.radius).toBe(32);
    expect(Object.isFrozen(codeInvocation)).toBe(true);
    expect(Object.isFrozen(codeInvocation.params)).toBe(true);
    expect(codeJob.type).toBe(ExecutionTaskKind.Code);
    expect(codeJob.code).toContain("api.bot.cutTree(2)");
    expect(Object.isFrozen(codeJob)).toBe(true);
  });
});

function addInventory(
  inventory: { item_name: string; count: number }[],
  itemName: string,
  count: number,
): void {
  const existing = inventory.find((item) => item.item_name === itemName);
  if (existing === undefined) {
    inventory.push({ item_name: itemName, count });
    return;
  }

  existing.count += count;
}

function countInventory(
  inventory: readonly { readonly item_name: string; readonly count: number }[],
  itemName: string,
): number {
  return inventory.reduce((sum, item) => sum + (item.item_name === itemName ? item.count : 0), 0);
}

function createConditionState(
  inventory: readonly { readonly item_name: string; readonly count: number }[],
) {
  return Object.freeze({
    world_key: "minecraft:overworld",
    inventory: Object.freeze(inventory.map((item) => Object.freeze({ ...item }))),
    main_hand_item_name: null,
    nearby_block_names: Object.freeze(["crafting_table"]),
  });
}

function createFakeEnsureFacts(): ToolchainEnsureFacts {
  return Object.freeze({
    resolveRequiredEquipment({ failure, inventory }) {
      const blockName =
        typeof failure.params.blockName === "string" ? failure.params.blockName : "";
      if (blockName === "iron_ore") {
        return "stone_pickaxe";
      }
      if (blockName === "stone") {
        return inventory.some((item) => item.item_name === "stone_pickaxe" && item.count > 0)
          ? "stone_pickaxe"
          : "wooden_pickaxe";
      }
      return null;
    },
    resolveMaterialSource({ itemName }) {
      if (itemName === "cobblestone") {
        return { action: "mine", itemName: "cobblestone", blockName: "stone" };
      }
      if (itemName === "oak_log") {
        return { action: "cutTree", itemName: "oak_log", blockName: "oak_log" };
      }
      return null;
    },
    canCraft({ itemName }) {
      return ["oak_planks", "stick", "crafting_table", "wooden_pickaxe", "stone_pickaxe"].includes(
        itemName,
      );
    },
    resolveCraftingTableBlockName() {
      return "crafting_table";
    },
    resolveBlockDropItemNames({ blockName }) {
      return blockName === "stone" ? ["cobblestone"] : [blockName];
    },
    countInventoryItemsByTag({ tagName, inventory }) {
      if (tagName !== "logs") {
        return 0;
      }
      return inventory
        .filter((item) => item.item_name.endsWith("_log"))
        .reduce((sum, item) => sum + item.count, 0);
    },
  });
}

function createMissingMaterialsFailure(
  targetItemName: string,
  missingItemName: string,
  missing: number,
): ToolchainCapabilityResult<{ readonly world_key: string | null }> {
  return {
    ok: false,
    error: {
      code: "missing_materials",
      message: "Inventory does not contain enough recipe ingredients",
      world_key: "minecraft:overworld",
      details: {
        target_item_name: targetItemName,
        missing_item_name: missingItemName,
        missing,
        candidates: [
          {
            item_name: targetItemName,
            missing: [
              {
                item_name: missingItemName,
                missing,
              },
            ],
          },
        ],
      },
    },
  };
}
