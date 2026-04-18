/**
 * 数据定义与配置模块。
 *
 * 架构职责：
 * 1. 模式声明（Schema Declaration）：定义数据库表结构、类型安全 Schema 及持久化规则。
 * 2. 存储抽象：维护日志、代码等外部存储引用的路径生成与校验规则。
 * 3. 配置聚合：统一处理环境变量、基础设施配置及 Bot 级配置覆盖，提供一致的 DataConfig 视图。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

export * from "./contracts.js";
export * from "./logs.js";
export * from "./schema.js";

/**
 * data 模块边界声明。
 *
 * 架构意图：
 * 1. 边界定义：明确数据模块在持久化（Schema）、存储引用（Refs）及配置管理（Config）三个维度的核心职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
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
