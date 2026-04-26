/**
 * 领域模型核心契约。
 *
 * 1. 顶层抽象：定义系统模块清单（CORE_MODULE_NAMES）和模块边界声明。
 * 2. 兼容导出：基础通信协议已下沉到 core-ports（核心端口层），本文件只重新导出以兼容旧调用点。
 * 3. 边界声明：通过 ModuleBoundary 提供一种标准化的方式来声明各模块的职责和导出，支撑架构的模块化演进。
 */

export * from "../core-ports/foundation.js";

/** TS Core 内的顶层模块名集合。 */
export const CORE_MODULE_NAMES = [
  "runtime",
  "skills",
  "observation",
  "world-model",
  "interfaces",
  "conversation",
  "workers",
  "sandbox",
  "diagnostics",
  "domain",
  "db",
  "data",
] as const;

/** TS Core 内的顶层模块名联合类型。 */
export type CoreModuleName = (typeof CORE_MODULE_NAMES)[number];

/** 模块边界描述结构，用于工程骨架阶段声明职责范围。 */
export interface ModuleBoundary {
  /** 模块名。 */
  moduleName: CoreModuleName;
  /** 模块职责列表。 */
  responsibilities: readonly string[];
  /** 当前阶段仅提供的占位导出清单。 */
  placeholderExports: readonly string[];
}
