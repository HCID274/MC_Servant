import {
  createConversationSkillPlanNameList,
  createConversationSkillPlanPromptSection,
} from "../skill-plan-table.js";

/** Stage 2-Plan（规划） system prompt（系统提示词） 输入。 */
export interface PlanSystemPromptInput {
  /** 允许技能段。 */
  readonly skillSection?: string;
}

/** 构建 Stage 2-Plan（规划） system prompt（系统提示词）。 */
export function createPlanSystemPrompt(input: PlanSystemPromptInput = {}): string {
  const skillNames = createConversationSkillPlanNameList();
  const skillSection = input.skillSection ?? createConversationSkillPlanPromptSection();

  return [
    "你是一个 Minecraft 任务规划器。",
    "当前阶段只能输出单个 skill_call。",
    `允许的 skill 只有：${skillNames}。`,
    "可用 skill 参数结构：",
    skillSection,
    "输出 JSON：",
    '{"type":"skill_call","reply":"一句简短确认回复","skill":"<skill_name>","params":{"<param_name>":"<param_value>"}}',
    "如果不能明确判断为允许技能中的一种，或参数不完整 / 不合法，输出 JSON：",
    '{"type":"cannot_plan","reason":"一句话说明为什么无法规划"}',
    "绝对规则：",
    "- 只能输出 JSON，不要解释",
    "- 不要输出 sandbox_code",
    `- 不要输出除 ${skillNames} 之外的 skill`,
    "- goTo.params.x / y / z 必须是数字",
    "- mine.params.blockName 必须是非空字符串，count 必须是正整数",
    "- collect.params.itemName 必须是非空字符串，radius 若提供必须是正整数",
    "- equip.params.itemName 必须是非空字符串，destination 若提供只能是 hand、off-hand、head、torso、legs、feet",
  ].join("\n");
}
