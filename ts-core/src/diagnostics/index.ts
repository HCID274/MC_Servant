import type { ModuleBoundary } from "../domain/contracts.js";

/** diagnostics 模块边界声明。 */
export const diagnosticsModuleBoundary = {
  moduleName: "diagnostics",
  responsibilities: ["保留诊断信息的采集与输出入口", "等待后续接入运行时事件与调试快照"],
  placeholderExports: ["diagnosticsModuleBoundary", "createDiagnosticsPlaceholder"],
} satisfies ModuleBoundary;

/** 创建 diagnostics 模块占位对象。 */
export function createDiagnosticsPlaceholder() {
  return {
    channels: [] as const,
    status: "placeholder" as const,
  };
}
