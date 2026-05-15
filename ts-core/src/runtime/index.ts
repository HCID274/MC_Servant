/**
 * 运行时与 BotActor 核心模块。
 *
 * 该模块是系统的执行中枢，负责定义和驱动 Bot 的核心生命周期，包括状态机流转、异步任务调度、外部认证管理以及标准化的事件总线。
 * 它通过定义严谨的中断协议（Interrupt Protocol）和生命周期事件（Lifecycle Events），确保机器人在复杂环境下的行为可预测且具备审计追踪能力。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/**
 * runtime 模块边界声明。
 *
 * 该声明确立了运行时模块在系统全局架构中的定位，主要负责承载 BotActor 的执行态边界、状态流转契约、任务包装标准及中断信号协议。
 */
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
    "createMineflayerTransportDescriptor",
    "createMineflayerRuntimeTransport",
    "createBotActorRuntime",
    "selectReflexAction",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./tasking.js";
export * from "./events.js";
export * from "./state-machine.js";
export * from "./actor.js";
export { createMineflayerTransportDescriptor } from "./transport/lifecycle.js";
export { createMineflayerRuntimeTransport } from "./transport/runtime.js";
export { parseWorldDimensionMap } from "./transport/block-world-compat.js";
export type {
  MineflayerRuntimeTransportDependencies,
  MineflayerRuntimeTransport,
  MineflayerTransportDescriptor,
  MineflayerTransportSnapshot,
} from "./transport/types.js";
