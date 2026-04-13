import type { ModuleBoundary } from "./contracts.js";

/** domain 模块边界声明。 */
export const domainModuleBoundary = {
  moduleName: "domain",
  responsibilities: ["沉淀全局复用的核心类型与基础契约", "约束任务、消息与事件日志的统一边界"],
  placeholderExports: [
    "CORE_MODULE_NAMES",
    "ConversationTaskKind",
    "ConversationPriority",
    "ExecutionTaskKind",
    "MessageSource",
    "EventLogEntry",
    "TaskEnvelope",
    "MessageTriage",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
