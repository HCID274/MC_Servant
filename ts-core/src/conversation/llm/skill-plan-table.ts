import {
  COLLECT_DEFAULT_RADIUS,
  COLLECT_MAX_RADIUS,
  COLLECT_MIN_RADIUS,
  SKILL_DIRECTORY,
  type SkillName,
  type SkillParamsByName,
  isCollectSkillParams,
  isCutTreeSkillParams,
  isEquipSkillParams,
  isGoToSkillParams,
  isMineSkillParams,
} from "../../core-ports/skills.js";
import { createSkillCallPlanDraft } from "../planning.js";
import { ConversationLlmPlanError, ConversationLlmSkillNotEnabledError } from "./errors.js";
import type { ConversationLlmPlanResult, ONLINE_PLAN_SKILLS } from "./types.js";

/** 在线规划允许的技能名。 */
export type OnlinePlanSkillName = (typeof ONLINE_PLAN_SKILLS)[number];

/** 单技能规划策略。 */
export interface ConversationSkillPlanStrategy<TName extends OnlinePlanSkillName> {
  /** 技能名。 */
  readonly skill: TName;
  /** 参数结构说明，用于生成 Prompt（提示词）。 */
  readonly paramsSchema: string;
  /** 参数校验守卫。 */
  readonly guard: (params: unknown) => params is SkillParamsByName[TName];
  /** 已校验参数到规划草案的构建器。 */
  readonly buildPlan: (
    reply: string,
    params: SkillParamsByName[TName],
  ) => Extract<ConversationLlmPlanResult, { skill: TName }>;
}

type ConversationSkillPlanStrategyTable = {
  readonly [TName in OnlinePlanSkillName]: ConversationSkillPlanStrategy<TName>;
};

type AnyConversationSkillPlanStrategy =
  ConversationSkillPlanStrategyTable[keyof ConversationSkillPlanStrategyTable];

const T046_DISABLED_PLAN_SKILLS = Object.freeze([] as const);

/** skill（技能） 到 guard（守卫） / buildPlan（构建器） 的只读策略表。 */
export const CONVERSATION_SKILL_PLAN_TABLE = Object.freeze({
  [SKILL_DIRECTORY.goTo]: createSkillPlanStrategy({
    skill: SKILL_DIRECTORY.goTo,
    paramsSchema: "params: { x: number; y: number; z: number }",
    guard: isGoToSkillParams,
  }),
  [SKILL_DIRECTORY.collect]: createSkillPlanStrategy({
    skill: SKILL_DIRECTORY.collect,
    paramsSchema: `params: { itemName?: string; center?: { x: number; y: number; z: number }; radius?: number }，radius 默认 ${COLLECT_DEFAULT_RADIUS}，允许范围 ${COLLECT_MIN_RADIUS} 到 ${COLLECT_MAX_RADIUS}`,
    guard: isCollectSkillParams,
  }),
  [SKILL_DIRECTORY.mine]: createSkillPlanStrategy({
    skill: SKILL_DIRECTORY.mine,
    paramsSchema:
      "params: { blockName: 'stone' | 'iron_ore' | 'deepslate_iron_ore'; count: number }，count 为需要实际进入背包的掉落物数量",
    guard: isMineSkillParams,
  }),
  [SKILL_DIRECTORY.cutTree]: createSkillPlanStrategy({
    skill: SKILL_DIRECTORY.cutTree,
    paramsSchema: "params: { count: number }，count 为需要实际进入背包的原木数量",
    guard: isCutTreeSkillParams,
  }),
  [SKILL_DIRECTORY.equip]: createSkillPlanStrategy({
    skill: SKILL_DIRECTORY.equip,
    paramsSchema: "params: { itemName: string; destination?: 'hand' }，把背包目标物品拿到主手",
    guard: isEquipSkillParams,
  }),
} satisfies ConversationSkillPlanStrategyTable);

/** 生成 Prompt（提示词） 可用技能段。 */
export function createConversationSkillPlanPromptSection(): string {
  return Object.values(CONVERSATION_SKILL_PLAN_TABLE)
    .map((strategy) => `- ${strategy.skill}: ${strategy.paramsSchema}`)
    .join("\n");
}

/** 生成 Prompt（提示词） 合法技能名列表。 */
export function createConversationSkillPlanNameList(): string {
  return Object.keys(CONVERSATION_SKILL_PLAN_TABLE).join("、");
}

/** 从 LLM（大语言模型） 原始技能名查找规划策略。 */
export function getConversationSkillPlanStrategy(
  skill: unknown,
): AnyConversationSkillPlanStrategy | undefined {
  if (typeof skill !== "string") {
    return undefined;
  }

  return CONVERSATION_SKILL_PLAN_TABLE[skill as OnlinePlanSkillName];
}

/** 用策略表构建规划结果。 */
export function createConversationSkillPlanFromTable(input: {
  reply: string;
  skill: unknown;
  params: unknown;
}): ConversationLlmPlanResult {
  const strategy = getConversationSkillPlanStrategy(input.skill);

  if (strategy === undefined) {
    if (isT046DisabledPlanSkill(input.skill)) {
      throw new ConversationLlmSkillNotEnabledError(
        `skill ${input.skill} has not passed independent validation and is not enabled`,
        { skill: input.skill },
      );
    }

    throw new ConversationLlmPlanError(
      `planner must return skill=${createConversationSkillPlanNameList().replaceAll("、", "|")}`,
    );
  }

  const params =
    strategy.skill === SKILL_DIRECTORY.collect
      ? normalizeCollectPlanParams(input.params)
      : input.params;

  if (!strategy.guard(params)) {
    throw new ConversationLlmPlanError(`planner returned invalid ${strategy.skill} params`);
  }

  /*
   * TypeScript（类型脚本） 无法在动态表查找后把 union（联合） 策略的 guard（守卫）
   * 与 buildPlan（构建器） 参数重新关联；断言集中在表边界，避免散落到每个技能分支。
   */
  return strategy.buildPlan(input.reply, params as never);
}

function normalizeCollectPlanParams(params: unknown): unknown {
  if (!isRecord(params) || typeof params.itemName !== "string") {
    return params;
  }

  const normalizedItemName = params.itemName.trim().toLowerCase();
  if (normalizedItemName !== "item" && normalizedItemName !== "unknown") {
    return params;
  }

  const { itemName: _itemName, ...rest } = params;

  return Object.freeze(rest);
}

function createSkillPlanStrategy<TName extends OnlinePlanSkillName>(input: {
  skill: TName;
  paramsSchema: string;
  guard: (params: unknown) => params is SkillParamsByName[TName];
}): ConversationSkillPlanStrategy<TName> {
  return Object.freeze({
    skill: input.skill,
    paramsSchema: input.paramsSchema,
    guard: input.guard,
    buildPlan: (reply: string, params: SkillParamsByName[TName]) =>
      /*
       * createSkillCallPlanDraft（创建技能调用规划草案） 的泛型输入经过对象字面量后会退化为 union（联合）；
       * 这里是策略表构造边界，断言保持在单点，调用方不再分支断言。
       */
      createSkillCallPlanDraft({
        reply,
        skill: input.skill,
        params,
      }) as Extract<ConversationLlmPlanResult, { skill: TName }>,
  });
}

/** 判断技能是否属于在线规划策略表。 */
export function isOnlinePlanSkillName(skill: SkillName): skill is OnlinePlanSkillName {
  return Object.hasOwn(CONVERSATION_SKILL_PLAN_TABLE, skill);
}

function isT046DisabledPlanSkill(
  skill: unknown,
): skill is (typeof T046_DISABLED_PLAN_SKILLS)[number] {
  return (
    typeof skill === "string" && (T046_DISABLED_PLAN_SKILLS as readonly string[]).includes(skill)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
