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
