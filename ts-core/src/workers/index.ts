/**
 * 异步工作线程与任务队列模块。
 *
 * 1. 队列管理：定义对话、执行和摘要三类任务队列的命名规范与物理目录，实现跨线程任务调度。
 * 2. 交互协议：收口 Worker 的输入包与输出动作契约，并负责将对话决策桥接为运行时的中断信号。
 * 3. 链路流转：规定任务在不同 Worker 间的流转逻辑，支持从入站消息到动作执行再到结果总结的全异步闭环。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/** workers 模块边界声明，确立工作线程在队列命名、跨线程协议及中断桥接方面的架构定位。 */
export const workersModuleBoundary = {
  moduleName: "workers",
  responsibilities: [
    "统一三队列命名规则、Worker 输入任务与输出动作契约",
    "桥接 cancel 与抢占式 task 到运行时中断协议",
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
    "createBotWorkerRuntime",
    "createBrainWorkerRuntime",
    "createOpenAiCompatibleEmbeddingGenerator",
    "createOpenAiCompatibleBrainWorkerLlmClient",
  ],
} satisfies ModuleBoundary;

export * from "./queues.js";
export * from "./bullmq.js";
export * from "./contracts.js";
export * from "./conversation-worker.js";
export * from "./bot-worker.js";
export * from "./brain-worker.js";
export * from "./embedding-client.js";
export * from "./brain-llm.js";
