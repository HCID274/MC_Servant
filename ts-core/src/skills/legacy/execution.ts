/**
 * 旧单技能执行入口。
 *
 * 仅用于历史回放、迁移测试或负向测试；在线路径必须走 Plan 产出的 TS code
 * 与 sandbox host bridge，不得把该入口作为失败兜底。
 */

export { executeSkillInvocation } from "./invocation-execution.js";
export type { LegacySkillCallInput as SkillCallInput } from "../../core-ports/legacy/skill-call.js";
