/**
 * 技能契约兼容入口。
 *
 * 纯技能端口已下沉到 core-ports（核心端口层）；skills（技能） 模块保留重新导出，避免旧导入点一次性迁移。
 */

export * from "../core-ports/skills.js";
