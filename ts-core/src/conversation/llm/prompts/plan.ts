import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  COLLECT_MIN_RADIUS,
} from "../../../core-ports/skills.js";
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
    '{"type":"cannot_plan","reason":"一句话说明为什么无法规划","code":"可选机器可读原因"}',
    "绝对规则：",
    "- 只能输出 JSON，不要解释",
    "- 不要输出 sandbox_code",
    `- 不要输出除 ${skillNames} 之外的 skill`,
    "- collect 表示捡拾 center/radius 范围内匹配掉落物；未给 center 时表示 Bot 当前位置附近；未给 itemName 时表示捡拾范围内所有掉落物",
    `- collect.params.radius 默认 ${COLLECT_DEFAULT_RADIUS}，允许范围 ${COLLECT_MIN_RADIUS} 到 ${COLLECT_MAX_RADIUS}；超过 ${COLLECT_MAX_RADIUS} 必须输出 cannot_plan，让上层先 goTo`,
    '- mine / equip / cutTree 尚未通过单技能验收，必须输出 {"type":"cannot_plan","reason":"skill_not_enabled","code":"skill_not_enabled"}',
    "- goTo.params.x / y / z 必须是数字",
    "- collect.params.itemName 如果提供，必须是物品标准英文 id；如果用户没有指定具体物品，可省略 itemName",
  ].join("\n");
}
