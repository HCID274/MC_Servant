import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { redactLocalDiagnosticJsonText } from "./local-log-redaction.js";

const CONVERSATION_LOG_DIRECTORY = "conversation";

/** 对话回复本地 JSONL（结构化日志） 行。 */
export interface ConversationReplyDiagnosticLogInput {
  /** 目标 Bot（机器人） 标识。 */
  readonly bot_id: string;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 日志创建时间。 */
  readonly created_at: string;
  /** 主人原始输入。 */
  readonly owner_message: string;
  /** 触发回复的 route（路由） 类型。 */
  readonly route_kind: string;
  /** 回复模式。 */
  readonly reply_mode: string;
  /** 最终广播给主人的回复。 */
  readonly reply: string;
  /** 分诊与路由摘要。 */
  readonly triage?: unknown;
  /** 注入回复生成链路的上下文。 */
  readonly contexts?: {
    readonly state_context?: string;
    readonly memory_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
  };
  /** LLM（大语言模型） 诊断记录，包含实际发送的 messages（消息）。 */
  readonly llm_diagnostics?: unknown;
}

/** 本地对话日志写入函数。 */
export type ConversationReplyDiagnosticLogSink = (
  input: ConversationReplyDiagnosticLogInput,
) => Promise<void>;

/** 创建本地 conversation（对话） JSONL（结构化日志） 写入器。 */
export function createLocalConversationReplyLogSink(input: {
  readonly baseDir: string;
  readonly sensitiveValues?: readonly string[];
  readonly now?: () => Date;
}): ConversationReplyDiagnosticLogSink {
  return async (record) => {
    const createdAt = new Date(record.created_at);
    const dateBucket = Number.isNaN(createdAt.getTime())
      ? (input.now?.() ?? new Date()).toISOString().slice(0, 10)
      : createdAt.toISOString().slice(0, 10);
    const directory = join(input.baseDir, CONVERSATION_LOG_DIRECTORY, dateBucket);
    const filePath = join(directory, `${sanitizeFileName(record.message_id)}.jsonl`);
    const line = `${redactLocalDiagnosticJsonText(
      JSON.stringify(record),
      input.sensitiveValues ?? [],
    )}\n`;

    await mkdir(directory, { recursive: true });
    await appendFile(filePath, line, "utf8");
  };
}

function sanitizeFileName(value: string): string {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9._-]/g, "_");

  return normalized.length === 0 ? "unknown-message" : normalized;
}
