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

/** LLM（大语言模型） 规划命中了尚未启用技能的门禁错误。 */
export class ConversationLlmSkillNotEnabledError extends ConversationLlmPlanError {
  /** 被门禁拒绝的技能名；cannot_plan（无法规划） 场景可能没有明确技能名。 */
  readonly skill?: string;

  /**
   * 创建未启用技能门禁错误。
   *
   * @param message 错误消息
   * @param input 可选技能名
   * @param options 原始 cause（原因）
   */
  constructor(message: string, input: { readonly skill?: string } = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationLlmSkillNotEnabledError";

    if (input.skill !== undefined) {
      this.skill = input.skill;
    }
  }
}

/** 判断错误是否为未启用技能门禁错误。 */
export function isConversationLlmSkillNotEnabledError(
  error: unknown,
): error is ConversationLlmSkillNotEnabledError {
  return error instanceof ConversationLlmSkillNotEnabledError;
}
