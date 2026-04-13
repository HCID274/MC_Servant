import type { ModuleBoundary } from "../domain/contracts.js";

/** skills 模块边界声明。 */
export const skillsModuleBoundary = {
  moduleName: "skills",
  responsibilities: [
    "保留技能注册与技能目录的模块入口",
    "等待后续 skill_call 输出接入具体技能实现",
  ],
  placeholderExports: ["skillsModuleBoundary", "createSkillsModulePlaceholder"],
} satisfies ModuleBoundary;

/** 创建技能模块占位对象。 */
export function createSkillsModulePlaceholder() {
  return {
    registeredSkills: [] as const,
    status: "placeholder" as const,
  };
}
