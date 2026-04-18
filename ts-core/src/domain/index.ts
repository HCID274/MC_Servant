/**
 * 核心领域定义与通用不变量。
 *
 * 1. 基础契约：沉淀全局复用的核心枚举（TaskKind, MessageSource）和数据结构（EventLogEntry, TaskEnvelope）。
 * 2. 跨模块共享：提供被所有子系统引用的基础类型定义，减少模块间的循环依赖。
 * 3. 不变量校验：提供统一的 assert 和 clone 工具，确保系统全局的数据完整性和不可变性。
 * 4. 领域一致性：规定任务、消息和分诊结果的顶层边界协议。
 */

import type { ModuleBoundary } from "./contracts.js";

/**
 * domain 模块边界声明。
 *
 * 1. 边界定义：明确领域模块在核心类型定义、不变量校验及基础契约三个维度的核心职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
export const domainModuleBoundary = {
  moduleName: "domain",
  responsibilities: [
    "沉淀全局复用的核心类型与基础契约",
    "提供跨模块共享的不变量校验与只读辅助工具",
    "约束任务、消息与事件日志的统一边界",
  ],
  placeholderExports: [
    "CORE_MODULE_NAMES",
    "ConversationTaskKind",
    "ConversationPriority",
    "ExecutionTaskKind",
    "MessageSource",
    "assertNonEmptyString",
    "cloneReadonlyValue",
    "EventLogEntry",
    "TaskEnvelope",
    "MessageTriage",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./invariants.js";
