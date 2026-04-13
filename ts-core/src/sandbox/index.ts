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
