import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  COLLECT_MIN_RADIUS,
  SKILL_DIRECTORY,
  type SkillName,
} from "../../core-ports/skills.js";

/** 允许 TS（TypeScript）代码规划通过 Semantic API（语义接口） 调用的动作名。 */
export type OnlinePlanSkillName =
  | typeof SKILL_DIRECTORY.goTo
  | typeof SKILL_DIRECTORY.collect
  | typeof SKILL_DIRECTORY.mine
  | typeof SKILL_DIRECTORY.cutTree
  | typeof SKILL_DIRECTORY.equip;

/** TS（TypeScript）代码规划可用的语义动作说明。 */
export interface ConversationCodePlanCapability {
  /** 语义动作名。 */
  readonly skill: OnlinePlanSkillName;
  /** 参数结构说明，用于生成 Prompt（提示词）。 */
  readonly paramsSchema: string;
}

type ConversationCodePlanCapabilityTable = {
  readonly [TName in OnlinePlanSkillName]: ConversationCodePlanCapability & {
    readonly skill: TName;
  };
};

/** skill（技能） 到 Semantic API（语义接口） 可编程能力的只读说明表。 */
export const CONVERSATION_SKILL_PLAN_TABLE = Object.freeze({
  [SKILL_DIRECTORY.goTo]: createCodePlanCapability({
    skill: SKILL_DIRECTORY.goTo,
    paramsSchema: "goTo(x: number, y: number, z: number)",
  }),
  [SKILL_DIRECTORY.collect]: createCodePlanCapability({
    skill: SKILL_DIRECTORY.collect,
    paramsSchema: `collect(itemName?: string, radius?: number)，radius 默认 ${COLLECT_DEFAULT_RADIUS}，允许范围 ${COLLECT_MIN_RADIUS} 到 ${COLLECT_MAX_RADIUS}`,
  }),
  [SKILL_DIRECTORY.mine]: createCodePlanCapability({
    skill: SKILL_DIRECTORY.mine,
    paramsSchema:
      "mine(blockName: 'stone' | 'iron_ore' | 'deepslate_iron_ore', count: number)，count 为需要实际进入背包的掉落物数量",
  }),
  [SKILL_DIRECTORY.cutTree]: createCodePlanCapability({
    skill: SKILL_DIRECTORY.cutTree,
    paramsSchema: "cutTree(count: number)，count 为需要实际进入背包的原木数量",
  }),
  [SKILL_DIRECTORY.equip]: createCodePlanCapability({
    skill: SKILL_DIRECTORY.equip,
    paramsSchema: "equip(itemName: string, destination?: 'hand')，把背包目标物品拿到主手",
  }),
} satisfies ConversationCodePlanCapabilityTable);

/** 生成 Prompt（提示词） 可用语义动作段。 */
export function createConversationSkillPlanPromptSection(): string {
  return Object.values(CONVERSATION_SKILL_PLAN_TABLE)
    .map((strategy) => `- ${strategy.paramsSchema}`)
    .join("\n");
}

/** 生成 Prompt（提示词） 合法语义动作名列表。 */
export function createConversationSkillPlanNameList(): string {
  return Object.keys(CONVERSATION_SKILL_PLAN_TABLE).join("、");
}

/** 判断技能是否属于在线代码规划可用的语义动作。 */
export function isOnlinePlanSkillName(skill: SkillName): skill is OnlinePlanSkillName {
  return Object.hasOwn(CONVERSATION_SKILL_PLAN_TABLE, skill);
}

function createCodePlanCapability<TName extends OnlinePlanSkillName>(input: {
  skill: TName;
  paramsSchema: string;
}): ConversationCodePlanCapability & { readonly skill: TName } {
  return Object.freeze({
    skill: input.skill,
    paramsSchema: input.paramsSchema,
  });
}
