/**
 * 安全沙箱执行模块。
 *
 * 1. 隔离执行：提供在受限环境中执行 Plan TS code 的能力，支持内存、CPU 时间和能力的严格限制。
 * 2. Host bridge：通过闭包桥接 runtime 单写者能力，不向沙箱代码暴露旧命名空间执行面。
 * 3. 稳压适配：负责将沙箱内部的执行状态、日志和异常无损地同步到主进程的诊断流水线。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** sandbox 模块边界声明，确立沙箱在安全执行、资源配额及 Facade 映射方面的架构定位。 */
export const sandboxModuleBoundary = {
  moduleName: "sandbox",
  responsibilities: [
    "执行 Plan 产出的 TS code 并注入顶层语义函数",
    "集中描述沙箱执行请求、结果、资源限制与错误分类",
  ],
  placeholderExports: [
    "sandboxModuleBoundary",
    "createSandboxExecutionRequest",
    "createSandboxError",
  ],
} satisfies ModuleBoundary;

export * from "./execution.js";
export * from "./recent-event.js";
export type {
  SandboxExecutionRequest,
  SandboxExecutionResourceLimits,
  SandboxExecutionResult,
  SandboxExecutionSummary,
  SandboxExecutionFailure,
  SandboxExecutionInterrupted,
  SandboxExecutionSuccess,
  SandboxGoalResult,
  SandboxStepResult,
} from "./contracts.js";
