/**
 * 运行时与 BotActor 核心模块。
 * 
 * 架构职责：
 * 1. 状态机驱动：定义 Bot 的核心运行时状态（BotStatus）及其流转逻辑（State Machine），管理从初始化到执行、中断及关闭的完整生命周期。
 * 2. 任务调度：统一运行时任务（ExecJob）的包装、优先级管理及异步执行契约。
 * 3. 认证管理：处理与外部系统（如 Minecraft 服务器）的认证状态、密钥绑定及执行计划。
 * 4. 事件总线契约：定义运行时生命周期事件（Lifecycle Events），为持久化和实时推送提供标准化的事件载荷。
 * 5. 中断协议：定义并实现中断信号（Interrupt Signal）机制，支持任务的优雅中断与强制抢占。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** runtime 模块边界声明。 */
export const runtimeModuleBoundary = {
  moduleName: "runtime",
  responsibilities: [
    "承载 BotActor 的执行态边界与状态流转契约",
    "统一运行时任务包与中断协议的基础结构",
  ],
  placeholderExports: [
    "BotStatus",
    "EXTERNAL_AUTH_STATUSES",
    "createExternalAuthSecretBinding",
    "createExternalAuthState",
    "createExternalAuthExecutionPlan",
    "createExternalAuthPublicState",
    "createRuntimeReadyGate",
    "InterruptSource",
    "InterruptSignal",
    "ExecJob",
    "TaskHistoryStatus",
    "TASK_TERMINAL_STATUSES",
    "RUNTIME_EVENT_TYPES",
    "TASK_LIFECYCLE_EVENT_TYPE_BY_STATUS",
    "createTaskAcceptedLifecycleEvent",
    "createTaskStartedLifecycleEvent",
    "createTaskDiscardedLifecycleEvent",
    "createTaskTerminalLifecycleEvent",
    "resolveTransition",
    "RuntimeTaskEnvelope",
    "createRuntimeScaffold",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./tasking.js";
export * from "./events.js";
export * from "./state-machine.js";
