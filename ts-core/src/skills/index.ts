/**
 * 机器人技能契约与注册模块。
 *
 * 1. 技能建模：定义系统支持的所有原子动作及其参数契约，实现业务能力的标准描述。
 * 2. 契约复用：复用 core-ports 的技能参数、结果与工具链窄契约。
 * 3. 注册表管理：维护版本化的技能清单，为 BotActor 提供明确的可用动作能力集。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** skills 模块边界声明，确立技能目录、参数契约及执行注册表在系统中的物理边界。 */
export const skillsModuleBoundary = {
  moduleName: "skills",
  responsibilities: [
    "维护技能目录、参数契约与注册表的纯类型边界",
    "为 runtime 与 code 执行共享同一套技能调用契约",
  ],
  placeholderExports: ["SKILL_DIRECTORY", "PHASE1_SKILL_NAMES", "createPhase1SkillRegistry"],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./registry.js";
export * from "./cut-tree.js";
export * from "./mine.js";
export * from "./recent-event.js";
export * from "./toolchain-ensure.js";
