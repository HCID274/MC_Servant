import type { ModuleBoundary } from "../domain/contracts.js";

/** world-model 模块边界声明。 */
export const worldModelModuleBoundary = {
  moduleName: "world-model",
  responsibilities: ["保留世界模型的只读推导入口", "等待后续接入观测快照与威胁评估边界"],
  placeholderExports: ["worldModelModuleBoundary", "createWorldModelPlaceholder"],
} satisfies ModuleBoundary;

/** 创建 world-model 模块占位对象。 */
export function createWorldModelPlaceholder() {
  return {
    derivedViews: [] as const,
    status: "placeholder" as const,
  };
}
