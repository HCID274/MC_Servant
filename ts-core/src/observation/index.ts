/**
 * 环境观测与快照模块。
 *
 * 架构职责：
 * 1. 状态映射：定义 Minecraft 游戏环境的只读快照契约（Environment Snapshot），涵盖机器人状态、周边实体及世界元数据。
 * 2. 观测抽象：提供 ObservationReadBoundary，将底层的 Mineflayer 或跨语言 Bridge 的原始观测数据抽象为领域模型。
 * 3. 威胁评估：实现静态的威胁分析逻辑（assessThreat），为 Bot 的决策提供环境安全参考。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/**
 * observation 模块边界声明。
 *
 * 架构意图：
 * 1. 边界定义：明确观测模块在环境快照定义、观测边界抽象及威胁评估三个维度的核心职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
export const observationModuleBoundary = {
  moduleName: "observation",
  responsibilities: ["统一 Mineflayer 与 JAR Bridge 的只读快照契约", "提供威胁评估与只读观察边界"],
  placeholderExports: [
    "observationModuleBoundary",
    "createObservationReadBoundary",
    "createEnvironmentSnapshot",
    "assessThreat",
    "createObservationRuntimeCache",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./snapshot.js";
export * from "./runtime.js";
