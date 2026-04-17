/**
 * 机器人技能契约与注册模块。
 *
 * 架构职责：
 * 1. 技能建模：定义系统支持的所有原子动作（Skills）及其参数契约。
 * 2. 契约复用：提供统一的 skill_call 结构，由运行时的直接调用和沙箱内的代理调用共享。
 * 3. 注册表管理：维护技能定义的版本化清单（如 Phase 1 清单），为 BotActor 提供可用的动作集。
 * 4. 工厂校验：提供强类型的技能调用工厂，确保任务生成的参数合法性。
 */

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
    "executeSkillCallJob",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./registry.js";
export * from "./execution.js";
