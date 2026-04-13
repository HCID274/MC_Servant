import type { ModuleBoundary } from "../domain/contracts.js";

/** skills 模块边界声明。 */
export const skillsModuleBoundary = {
  moduleName: "skills",
  responsibilities: [
    "维护技能目录、参数契约与注册表的纯类型边界",
    "为 runtime 与后续 sandbox 共享同一套 skill_call 契约",
  ],
  placeholderExports: [
    "SKILL_DIRECTORY",
    "PHASE1_SKILL_NAMES",
    "createSkillCall",
    "createPhase1SkillRegistry",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./registry.js";
