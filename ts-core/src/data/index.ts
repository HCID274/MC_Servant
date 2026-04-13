import type { ModuleBoundary } from "../domain/contracts.js";

export * from "./contracts.js";
export * from "./logs.js";
export * from "./schema.js";

/** data 模块边界声明。 */
export const dataModuleBoundary = {
  moduleName: "data",
  responsibilities: [
    "声明 mc_servant 持久化表结构与类型安全 schema 出口",
    "集中维护 log_ref 与 code_ref 的相对路径规则",
    "集中维护基础设施配置默认值、环境变量别名与 Bot 级配置覆盖语义",
  ],
  placeholderExports: [
    "dataModuleBoundary",
    "MC_SERVANT_SCHEMA_NAME",
    "mcServantTables",
    "createDataConfig",
    "createBotConfigOverlay",
    "applyBotConfigOverlay",
    "isValidStorageRef",
  ],
} satisfies ModuleBoundary;
