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
    "InterruptSource",
    "InterruptSignal",
    "RuntimeTaskEnvelope",
    "createRuntimeScaffold",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
