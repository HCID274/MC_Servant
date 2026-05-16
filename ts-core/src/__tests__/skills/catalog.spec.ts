import { describe, expect, it } from "vitest";

import {
  CRAFT_SERVICE_ALLOWED_TARGETS,
  FORBIDDEN_TOOLCHAIN_DEMO_NAMES,
  PHASE1_SKILL_DEFINITIONS,
  PHASE1_SKILL_NAMES,
  PLACEMENT_SERVICE_ALLOWED_BLOCKS,
  SKILL_DIRECTORY,
  type SkillName,
  type SkillParamsByName,
  TOOLCHAIN_CAPABILITY_NAMES,
  TOOLCHAIN_FAILURE_CODES,
  type ToolchainCapabilityName,
  type ToolchainCapabilityResult,
  createCollectSkillExecutionResult,
  createCraftService,
  createCutTreeSkillExecutionResult,
  createMineSkillExecutionResult,
  createPhase1SkillRegistry,
  createPlacementService,
  createSkillRegistry,
  evaluateEnsureCondition,
  getSkillDefinition,
  hasSkillDefinition,
  isCollectSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
  listSkillDefinitions,
  registerSkillDefinition,
} from "../../index.js";
import { createConditionState, createFakeEnsureFacts } from "./toolchain-ensure.fixture.js";

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

describe("skills/catalog 主路径契约", () => {
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

    expect(TOOLCHAIN_CAPABILITY_NAMES).toEqual(["craft", "place", "equip", "mine", "ensure"]);
    expect(FORBIDDEN_TOOLCHAIN_DEMO_NAMES).toEqual(["demoMineIron"]);
    expect(TOOLCHAIN_CAPABILITY_NAMES).not.toContain("demoMineIron");
    expect(TOOLCHAIN_FAILURE_CODES).toEqual(
      expect.arrayContaining([
        "missing_materials",
        "missing_crafting_table",
        "crafting_table_required",
        "recipe_not_found",
        "runtime_craft_failed",
        "craft_failed",
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

  it("资源结果工厂缺完成证明时不得伪造成成功", () => {
    let proofError: unknown;
    try {
      createMineSkillExecutionResult({ blockName: "stone", count: 2 });
    } catch (error) {
      proofError = error;
    }
    expect(proofError).toMatchObject({
      error_code: "unknown_completion",
      details: {
        code: "unknown_completion",
        skill: "mine",
        requested_count: 2,
        known_fields: [],
        missing_fields: ["collected_count"],
      },
    });
    expect(() => createMineSkillExecutionResult({ blockName: "stone", count: 2 })).toThrow(
      "mine result lacks numeric collected_count completion proof",
    );
    expect(() =>
      createMineSkillExecutionResult(
        { blockName: "stone", count: 2 },
        {
          collected_item_name: "cobblestone",
          collected_count: 2,
        },
      ),
    ).toThrow("mine result lacks numeric mined_count completion proof");
    expect(() =>
      createMineSkillExecutionResult(
        { blockName: "stone", count: 2 },
        {
          collected_item_name: null,
          collected_count: 2,
          mined_count: 2,
        },
      ),
    ).toThrow("mine result lacks collected item proof");
    expect(() =>
      createMineSkillExecutionResult(
        { blockName: "stone", count: 2 },
        {
          collected_item_name: "   ",
          collected_count: 2,
          mined_count: 2,
        },
      ),
    ).toThrow("mine result lacks collected item proof");
    expect(
      createMineSkillExecutionResult(
        { blockName: "stone", count: 2 },
        {
          collected_item_name: "cobblestone",
          collected_count: 2,
          mined_count: 2,
        },
      ),
    ).toMatchObject({
      skill: "mine",
      collected_item_name: "cobblestone",
      collected_count: 2,
      mined_count: 2,
    });
    expect(() => createCollectSkillExecutionResult({ itemName: "oak_log" })).toThrow(
      "collect result lacks collected completion proof",
    );
    expect(() => createCutTreeSkillExecutionResult({ count: 5 })).toThrow(
      "cutTree result lacks numeric collected_count completion proof",
    );
    expect(() =>
      createCutTreeSkillExecutionResult(
        { count: 5 },
        {
          collected_count: 5,
          clusters: [],
        },
      ),
    ).toThrow("cutTree result lacks explicit completion state proof");
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
});
