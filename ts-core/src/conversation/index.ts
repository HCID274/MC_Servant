import type { ModuleBoundary } from "../domain/contracts.js";

/** conversation（对话） 模块边界声明。 */
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
