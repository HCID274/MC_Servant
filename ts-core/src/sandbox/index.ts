/**
 * 安全沙箱执行模块。
 *
 * 架构职责：
 * 1. 隔离执行：提供在受限环境中执行外部代码（Sandbox Code）的能力，支持内存、CPU 时间和能力的严格限制。
 * 2. Facade 契约：定义沙箱内可见的 API 边界（Facade Contract），将内部复杂的 Mineflayer 技能映射为沙箱内简单的异步函数调用。
 * 3. 错误与限制：集中定义沙箱执行请求、结果载荷、资源配额以及细粒度的沙箱错误分类。
 * 4. 稳压适配：负责将沙箱内部的执行状态、日志和异常无损地同步到主进程的诊断流水线。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** sandbox 模块边界声明。 */
export const sandboxModuleBoundary = {
  moduleName: "sandbox",
  responsibilities: [
    "定义 Facade API 的顶层类型边界与 Phase 1 技能映射",
    "集中描述沙箱执行请求、结果、资源限制与错误分类",
  ],
  placeholderExports: [
    "sandboxModuleBoundary",
    "createSandboxFacadeContract",
    "createSandboxExecutionRequest",
    "createSandboxError",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./facade.js";
export * from "./execution.js";
