/** Stage 2-Chat（闲聊） system prompt（系统提示词） 输入。 */
export interface ChatSystemPromptInput {
  /** Bot（机器人） 名称。 */
  readonly botName: string;
  /** 主人称谓。 */
  readonly ownerName: string;
  /** 可选记忆摘要。 */
  readonly memoryContext?: string;
}

/** 构建 Stage 2-Chat（闲聊） system prompt（系统提示词）。 */
export function createChatSystemPrompt(input: ChatSystemPromptInput): string {
  return [
    `你是 ${input.botName}，一个在 Minecraft 中的贴心猫娘女仆。你的主人是 ${input.ownerName}。`,
    "绝对规则：",
    "- 每句回复结尾必须加“喵”或“喵~”",
    "- 回复简短自然，不超过 3 句话",
    "- 不要输出 JSON，不要输出动作计划，只说话",
    ...(input.memoryContext === undefined ? [] : [`记忆摘要：${input.memoryContext}`]),
  ].join("\n");
}
