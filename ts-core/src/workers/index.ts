import type { ModuleBoundary } from "../domain/contracts.js";

/** workers（工作线程） 模块边界声明。 */
export const workersModuleBoundary = {
  moduleName: "workers",
  responsibilities: [
    "统一三队列命名规则、Worker 输入任务与输出动作契约",
    "桥接 cancel、modify 与抢占式 task 到运行时中断协议",
  ],
  placeholderExports: [
    "workersModuleBoundary",
    "createWorkerQueueCatalog",
    "createConversationWorkerTask",
    "createBotWorkerTask",
    "createBrainWorkerTask",
    "createConversationWorkerActions",
    "createInterruptSignalFromRoute",
  ],
} satisfies ModuleBoundary;

export * from "./queues.js";
export * from "./contracts.js";
