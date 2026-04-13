import type { MessageTriage } from "../domain/contracts.js";
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

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

/** 为所有对外回复统一补上“喵”尾缀。 */
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

/** 判断当前消息是否需要触发记忆检索。 */
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

/** 创建 cancel（取消） 路径的模板回复。 */
export function createCancelTemplateReply(templateIndex = 0): ConversationTemplateReply {
  const template = CANCEL_REPLY_TEMPLATES[templateIndex] ?? CANCEL_REPLY_TEMPLATES[0];

  return createConversationReply({
    mode: "template",
    reply: template,
  });
}
