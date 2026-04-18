import type { ModuleBoundary } from "../domain/contracts.js";

/**
 * conversation（对话） 模块边界声明。
 *
 * 架构意图：
 * 1. 边界定义：显式声明对话模块的职责（分诊、闲聊、规划）及其核心导出项。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
export const conversationModuleBoundary = {
  moduleName: "conversation",
  responsibilities: [
    "承载 ConversationWorker 的分诊、闲聊、规划与纯路由契约",
    "统一 task、modify、cancel 三类对话意图的纯函数边界",
  ],
  placeholderExports: [
    "conversationModuleBoundary",
    "createMessageTriage",
    "createConversationRouteDecision",
    "createConversationPlanningContext",
    "createSkillCallPlanDraft",
    "createSandboxCodePlanDraft",
    "createConversationReply",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./triage.js";
export * from "./chat.js";
export * from "./planning.js";
