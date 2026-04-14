/**
 * 对话回复生成与辅助逻辑。
 * 
 * 架构职责：
 * 1. 回复风格统一：通过 ensureReplyEndsWithMeow 确保机器人所有对外回复均符合特定的性格（“喵”后缀）。
 * 2. 检索策略：定义并判断消息是否触发记忆检索（Memory Search）的启发式规则。
 * 3. 模板管理：管理特定场景（如取消操作）下的标准回复模板，确保响应的一致性。
 */

import type { MessageTriage } from "../domain/contracts.js";
import { assertNonEmptyString } from "../domain/invariants.js";
import {
  CONVERSATION_REPLY_MODES,
  type ConversationLlmReply,
  type ConversationReply,
  type ConversationReplyMode,
  type ConversationTemplateReply,
} from "./contracts.js";

/** 聊天记忆检索触发词表。 */
export const CONVERSATION_MEMORY_RECALL_TRIGGERS = [
  "上次",
  "之前",
  "还记得",
  "那个",
  "以前",
  "昨天",
  "刚才",
] as const;

/** cancel（取消） 路径允许使用的模板回复。 */
export const CANCEL_REPLY_TEMPLATES = [
  "好的，已经停下来了喵~",
  "收到，我先停下当前动作喵~",
  "明白，这就先取消掉喵~",
] as const;

/**
 * 统一回复风格。
 * 
 * 架构意图：
 * 强制所有对外输出的文本均以“喵”相关后缀结尾，用于塑造统一的 Bot 性格。
 * 
 * @param text 原始文本
 * @returns 补全后缀后的文本
 */
export function ensureReplyEndsWithMeow(text: string): string {
  const trimmed = text.trimEnd();

  if (
    trimmed.endsWith("喵") ||
    trimmed.endsWith("喵~") ||
    trimmed.endsWith("喵！") ||
    trimmed.endsWith("喵。")
  ) {
    return trimmed;
  }

  return `${trimmed}喵~`;
}

/**
 * 判断当前消息是否需要触发记忆检索。
 * 
 * 架构策略：
 * 1. 意图驱动：所有 task 或 modify 意图均强制开启检索。
 * 2. 关键词驱动：若消息内容包含特定触发词（如“上次”、“记得”），则认为用户在引用历史，需要开启检索。
 * 
 * @param input 包含消息文本和分诊意图的输入
 * @returns 是否需要检索
 */
export function shouldSearchConversationMemory(input: {
  message: string;
  triage: Pick<MessageTriage, "intent">;
}): boolean {
  if (input.triage.intent === "task" || input.triage.intent === "modify") {
    return true;
  }

  return CONVERSATION_MEMORY_RECALL_TRIGGERS.some((trigger) => input.message.includes(trigger));
}

/** 创建经过尾缀兜底的只读对话回复。 */
export function createConversationReply(input: {
  mode: "llm";
  reply: string;
}): ConversationLlmReply;
/** 创建经过尾缀兜底的只读对话回复。 */
export function createConversationReply(input: {
  mode: "template";
  reply: string;
}): ConversationTemplateReply;
/** 创建经过尾缀兜底的只读对话回复。 */
/**
 * 创建对话回复对象。
 * 
 * 架构意图：
 * 作为一个工厂函数，它负责验证回复模式并应用统一的性格化（ensureReplyEndsWithMeow），
 * 确保所有生成的回复对象都是不可变的且满足业务契约。
 * 
 * @param input 包含模式和原始回复文本的输入
 * @returns 包装后的回复对象
 */
export function createConversationReply(input: {
  mode: ConversationReplyMode;
  reply: string;
}): ConversationReply {
  if (!(CONVERSATION_REPLY_MODES as readonly string[]).includes(input.mode)) {
    throw new Error(`Unsupported conversation reply mode: ${input.mode}`);
  }

  assertNonEmptyString(input.reply, "reply");

  return Object.freeze({
    mode: input.mode,
    reply: ensureReplyEndsWithMeow(input.reply),
  });
}

/**
 * 创建取消操作的模板回复。
 * 
 * 架构意图：
 * 快速生成用于中断/取消任务场景下的确认回复。
 * 
 * @param templateIndex 模板索引
 * @returns 模板回复对象
 */
export function createCancelTemplateReply(templateIndex = 0): ConversationTemplateReply {
  const template = CANCEL_REPLY_TEMPLATES[templateIndex] ?? CANCEL_REPLY_TEMPLATES[0];

  return createConversationReply({
    mode: "template",
    reply: template,
  });
}
