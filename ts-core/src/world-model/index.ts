/**
 * 世界模型与资源建模模块。
 *
 * 1. 资源建模：定义资源画像和资源簇，将散乱的方块观测提升为结构化的资源认知。
 * 2. 空间查询：提供针对环境资源的只读查询契约，支持按距离、密度和价值评估最优资源点。
 * 3. 读写分离：显式拆分 Query（查询）与 Refresh（刷新）边界，确保认知的演进可控。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** world-model 模块边界声明，确立其在资源画像、空间查询及读写分离边界上的责任。 */
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
