import type { ModuleBoundary } from "../domain/contracts.js";

/** observation 模块边界声明。 */
export const observationModuleBoundary = {
  moduleName: "observation",
  responsibilities: ["保留环境观测聚合入口", "等待后续接入游戏侧与运行时侧的只读快照"],
  placeholderExports: ["observationModuleBoundary", "createObservationPlaceholder"],
} satisfies ModuleBoundary;

/** 创建 observation 模块占位对象。 */
export function createObservationPlaceholder() {
  return {
    snapshotSources: [] as const,
    status: "placeholder" as const,
  };
}
