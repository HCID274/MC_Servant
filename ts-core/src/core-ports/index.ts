/**
 * core-ports（核心端口层） 聚合导出入口。
 *
 * 依赖方向约束：业务模块可以依赖 core-ports（核心端口层），core-ports（核心端口层）
 * 不依赖 runtime（运行时）、sandbox（沙箱）、skills（技能）、observation（观测）、
 * diagnostics（诊断） 或 data（数据层） 的实现文件。
 */

export * from "./foundation.js";
export * from "./skills.js";
export * from "./observation.js";
export * from "./runtime.js";
export * from "./tasking.js";
export * from "./events.js";
export * from "./sandbox.js";
export * from "./task-result.js";
