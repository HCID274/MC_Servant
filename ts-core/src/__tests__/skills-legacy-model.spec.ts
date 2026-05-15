import { describe, expect, it } from "vitest";

import {
  type LegacySkillCallInput as TestOnlyLegacySkillCallInput,
  createLegacySkillCall,
} from "../core-ports/legacy/skill-call.js";
import { SKILL_DIRECTORY } from "../index.js";

const invalidLegacySkillCallInput: TestOnlyLegacySkillCallInput = {
  skill: SKILL_DIRECTORY.goTo,
  // @ts-expect-error legacy/test-only：`goTo` 与 `count` 参数形态不对齐。
  params: { count: 2 },
};
void invalidLegacySkillCallInput;

describe("legacy/test-only skill call 夹具", () => {
  it("应只在 legacy/test-only 路径构造旧单技能调用夹具", () => {
    const legacySkillCall = createLegacySkillCall({
      skill: SKILL_DIRECTORY.collect,
      params: {
        itemName: "oak_log",
        radius: 32,
      },
    });

    expect(legacySkillCall.skill).toBe("collect");
    expect(legacySkillCall.params.radius).toBe(32);
    expect(Object.isFrozen(legacySkillCall)).toBe(true);
    expect(Object.isFrozen(legacySkillCall.params)).toBe(true);
  });
});
