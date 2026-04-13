import type { ModuleBoundary } from "../domain/contracts.js";

/** data 模块边界声明。 */
export const dataModuleBoundary = {
  moduleName: "data",
  responsibilities: [
    "保留持久化分层与 schema 隔离的模块入口",
    "等待后续接入 PostgreSQL 与日志抽象",
  ],
  placeholderExports: ["dataModuleBoundary", "createDataPlaceholder"],
} satisfies ModuleBoundary;

/** 创建 data 模块占位对象。 */
export function createDataPlaceholder() {
  return {
    stores: [] as const,
    status: "placeholder" as const,
  };
}
