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
    "优先输出单个 skill_call；只有任务无法映射为单个允许 skill 时，才输出 sandbox_code。",
    `允许的 skill_call skill 只有：${skillNames}。`,
    "可用 skill 参数结构：",
    skillSection,
    "输出 JSON：",
    '{"type":"skill_call","reply":"一句简短确认回复","skill":"<skill_name>","params":{"<param_name>":"<param_value>"}}',
    "复杂任务输出 JSON：",
    '{"type":"sandbox_code","reply":"一句简短确认回复","code":"TypeScript 顶层 async 函数体"}',
    "如果不能明确判断为允许技能中的一种，或参数不完整 / 不合法，输出 JSON：",
    '{"type":"cannot_plan","reason":"一句话说明为什么无法规划","code":"可选机器可读原因"}',
    "绝对规则：",
    "- 只能输出 JSON，不要解释",
    "- sandbox_code 只能使用全局 api、console、sleep(ms)、Math、JSON、Date，不要 import/export/require",
    "- 如果 Brain上下文不足以规划与历史相关的任务，可以调用 search() 查找长期任务历史",
    `- 不要输出除 ${skillNames} 之外的 skill`,
    "- collect 表示捡拾 center/radius 范围内匹配掉落物；未给 center 时表示 Bot 当前位置附近；未给 itemName 时表示捡拾范围内所有掉落物",
    "- 主人说“捡起来 / 捡地上的东西 / 把这个东西捡起来 / 全捡起来”等泛指捡拾时，必须输出 collect，不要因为缺 itemName 输出 cannot_plan",
    "- 主人未明确说“你那边 / Bot 身边 / 你附近”时，泛指捡拾默认以环境快照 [主人] 坐标作为 collect.params.center；只有明确要求 Bot 当前位置附近捡拾时才省略 center",
    `- 泛指捡拾的 collect.params.radius 至少 ${COLLECT_DEFAULT_RADIUS}；执行层会在 ${COLLECT_DEFAULT_RADIUS} 未命中时自动扩到 ${COLLECT_MAX_RADIUS} 搜索，不要输出小于 ${COLLECT_DEFAULT_RADIUS} 的 radius`,
    "- 环境快照中的 [附近掉落物] 只说明可见掉落物候选；即使只看到 item/unknown/Item，只要主人要求泛指捡拾，也必须使用不带 itemName 的 collect，禁止把 item、unknown 或 Item 当作 itemName",
    `- collect.params.radius 默认 ${COLLECT_DEFAULT_RADIUS}，允许范围 ${COLLECT_MIN_RADIUS} 到 ${COLLECT_MAX_RADIUS}；超过 ${COLLECT_MAX_RADIUS} 必须输出 cannot_plan，让上层先 goTo`,
    "- 主人要求砍树 / 砍木头 / 收集原木且给出数量时，必须输出 cutTree；只给 count，不要输出坐标、树木簇、循环步骤或挖掘目标",
    "- cutTree.params.count 表示最终实际进入背包的原木数量；执行层会自动选择当前世界可用树木簇、挖推荐原木、捡拾并按背包增量续砍",
    '- 主人要求放置工作台 / 放一个工作台 / 摆工作台时，必须输出 sandbox_code，基础 code 为 await api.bot.place("crafting_table")；不要输出 cannot_plan，也不要说当前只会 goTo / collect',
    '- 主人说“在我这 / 在这里 / 放我旁边 / 放我身边”放置工作台时，必须读取环境快照 [主人] 位置，输出 await api.bot.goTo(x,y,z); await api.bot.place("crafting_table", {x,y,z})；x/y/z 必须使用 [主人] 坐标数字',
    "- api.bot.place 现阶段只支持 crafting_table；near 参数表示期望放置参考点；执行层会先尝试合成 1 个工作台，再在 near 或 Bot 当前位置附近选择合法位置放置",
    "- 主人说“过来 / 到我这里 / 来我身边”时，优先用环境快照里的 [主人] 坐标规划 goTo；若 [主人] 离线则输出 cannot_plan",
    "- 环境快照里的 ResourceService 资源摘要只是只读资源上下文，可用于判断附近是否有资源；它不会启用新的 skill",
    '- mine / equip 尚未通过单技能验收，必须输出 {"type":"cannot_plan","reason":"skill_not_enabled","code":"skill_not_enabled"}',
    "- goTo.params.x / y / z 必须是数字",
    "- collect.params.itemName 如果提供，必须是物品标准英文 id；如果用户没有指定具体物品，可省略 itemName",
  ].join("\n");
}
