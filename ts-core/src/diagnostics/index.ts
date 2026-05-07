/**
 * 诊断与日志通道模块。
 *
 * 1. 结构化日志：定义任务执行（tasks）、沙箱操作（sandbox）和大语言模型调用（llm）的 JSONL 行契约。
 * 2. 诊断目录：维护诊断通道的元数据，包括存储目录、保留策略及引用的校验规则。
 * 3. 持久化适配：提供标准化函数，将系统事件转换为可供后续分析、审计或 RAG 检索的结构化日志行。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/**
 * diagnostics 模块边界声明。
 *
 * 1. 边界定义：明确诊断模块在结构化日志（JSONL）定义、存储目录管理及保留策略（Retention）三个维度的核心职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
export const diagnosticsModuleBoundary = {
  moduleName: "diagnostics",
  responsibilities: [
    "定义 tasks、sandbox、llm 三类 JSONL 日志行契约",
    "统一诊断通道目录、保留期与 log_ref/code_ref 校验规则",
  ],
  placeholderExports: [
    "diagnosticsModuleBoundary",
    "createDiagnosticsCatalog",
    "createTaskLogLine",
    "createTaskLifecycleSummaryJsonlLine",
    "createSandboxLogLine",
    "createLocalConversationReplyLogSink",
    "createLocalLlmDiagnosticLogSink",
    "createAsyncDiagnosticSink",
    "createLocalBrainDiagnosticLogSink",
    "createLocalTaskLogExcerptReader",
    "createLocalProductionMetricLogSink",
    "createProductionLlmMetricSummaries",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./logs.js";
export * from "./async-sink.js";
export * from "./conversation-reply-log.js";
export * from "./llm-log.js";
export * from "./brain-log.js";
export * from "./task-log-reader.js";
export * from "./eval-jsonl.js";
export * from "./production-metrics.js";
export * from "./production-metrics-summary.js";
