/**
 * 异步工作线程与任务队列模块。
 *
 * 架构职责：
 * 1. 队列管理：定义并维护对话（Conversation）、执行（Bot/Exec）和摘要（Brain）三类任务队列的命名规范与物理目录。
 * 2. Worker 契约：定义各类工作线程的输入任务包（Worker Task）与输出动作（Worker Actions）结构，收口跨线程通信协议。
 * 3. 路由桥接：负责将对话层的路由决策（如 Cancel, Modify）桥接为运行时可识别的中断信号（Interrupt Signal）。
 * 4. 任务流转：规定任务如何在不同 Worker 之间流转，支撑从“收到消息”到“执行动作”再到“结果总结”的完整异步链路。
 */

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
    "createWorkerBullmqRuntime",
    "createConversationWorkerTask",
    "createBotWorkerTask",
    "createBrainWorkerTask",
    "createConversationWorkerActions",
    "createBotWorkerActions",
    "createBrainWorkerActions",
    "createInterruptSignalFromRoute",
    "createConversationWorkerRuntime",
  ],
} satisfies ModuleBoundary;

export * from "./queues.js";
export * from "./bullmq.js";
export * from "./contracts.js";
export * from "./conversation-worker.js";
