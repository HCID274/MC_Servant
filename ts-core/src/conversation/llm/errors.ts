import type { ConversationLlmDiagnosticRecord } from "./types.js";

export class ConversationLlmChatError extends Error {
  /** 失败时已生成的诊断摘要。 */
  readonly diagnostics: ConversationLlmDiagnosticRecord;

  /**
   * 创建携带诊断摘要的闲聊调用错误。
   *
   * @param message 错误消息
   * @param diagnostics 失败诊断
   * @param options 原始 cause（原因）
   */
  constructor(
    message: string,
    diagnostics: ConversationLlmDiagnosticRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationLlmChatError";
    this.diagnostics = diagnostics;
  }
}

/** 最小规划失败错误。 */
export class ConversationLlmPlanError extends Error {
  /**
   * 创建规划失败错误。
   *
   * @param message 错误消息
   * @param options 原始 cause（原因）
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationLlmPlanError";
  }
}
