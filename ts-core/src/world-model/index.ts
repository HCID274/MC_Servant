import type { ModuleBoundary } from "../domain/contracts.js";

/** world-model 模块边界声明。 */
export const worldModelModuleBoundary = {
  moduleName: "world-model",
  responsibilities: [
    "提供资源画像、资源簇与候选块的只读查询契约",
    "显式拆分 query 与 refresh 边界",
  ],
  placeholderExports: [
    "worldModelModuleBoundary",
    "createWorldModelQueryBoundary",
    "createWorldModelRefreshBoundary",
    "queryBestResourceCluster",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./query.js";
