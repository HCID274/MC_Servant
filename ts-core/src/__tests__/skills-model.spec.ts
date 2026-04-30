import { describe, expect, it } from "vitest";

import {
  ExecPriority,
  ExecutionTaskKind,
  PHASE1_SKILL_DEFINITIONS,
  PHASE1_SKILL_NAMES,
  SKILL_DIRECTORY,
  type SkillCallJobInput,
  type SkillName,
  type SkillParamsByName,
  createPhase1SkillRegistry,
  createSkillCall,
  createSkillCallJob,
  createSkillRegistry,
  getSkillDefinition,
  hasSkillDefinition,
  isCollectSkillParams,
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

const invalidSkillCallJob: SkillCallJobInput = {
  message_id: "type-mismatch",
  intent_epoch: 1,
  snapshot_ts: 1,
  priority: ExecPriority.Normal,
  skill: SKILL_DIRECTORY.goTo,
  // @ts-expect-error `goTo`（前往坐标） 与 `count`（数量） 参数形态不对齐。
  params: { count: 2 },
};
void invalidSkillCallJob;

describe("skills 模块契约", () => {
  it("应暴露五个 Phase 1 技能目录与参数校验器", () => {
    expect(PHASE1_SKILL_NAMES).toEqual(["goTo", "mine", "cutTree", "collect", "equip"]);
    expect(SKILL_DIRECTORY.cutTree).toBe("cutTree");
    expect(isGoToSkillParams({ x: 1, y: 64, z: -3 })).toBe(true);
    expect(isGoToSkillParams({ x: 1, y: 64 })).toBe(false);
    expect(isMineSkillParams({ blockName: "stone", count: 3 })).toBe(true);
    expect(isMineSkillParams({ blockName: "stone", count: 0 })).toBe(false);
    expect(
      isCollectSkillParams({ itemName: "oak_log", center: { x: 1, y: 64, z: -2 }, radius: 8 }),
    ).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 32 })).toBe(true);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 7 })).toBe(false);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: 33 })).toBe(false);
    expect(isCollectSkillParams({ itemName: "oak_log", radius: -1 })).toBe(false);
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

  it("应让 skill_call 构造与运行时任务共享同一套强类型目录", () => {
    const skillCall = createSkillCall({
      skill: SKILL_DIRECTORY.collect,
      params: {
        itemName: "oak_log",
        radius: 8,
      },
    });
    const skillCallJob = createSkillCallJob({
      message_id: "msg-skill-call",
      intent_epoch: 3,
      snapshot_ts: 1_712_930_100,
      priority: ExecPriority.Urgent,
      skill: SKILL_DIRECTORY.cutTree,
      params: { count: 2 },
    });

    expect(skillCall.skill).toBe("collect");
    expect(skillCall.params.radius).toBe(8);
    expect(Object.isFrozen(skillCall)).toBe(true);
    expect(Object.isFrozen(skillCall.params)).toBe(true);
    expect(skillCallJob.type).toBe(ExecutionTaskKind.SkillCall);
    expect(skillCallJob.skillCall.skill).toBe("cutTree");
    expect(skillCallJob.skill).toBe(skillCallJob.skillCall.skill);
    expect(skillCallJob.params).toEqual({ count: 2 });
    expect(Object.isFrozen(skillCallJob.skillCall)).toBe(true);
    expect(Object.isFrozen(skillCallJob.skillCall.params)).toBe(true);
  });
});
