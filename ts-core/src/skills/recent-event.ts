import type {
  CollectSkillExecutionResult,
  CutTreeSkillExecutionResult,
  GoToSkillExecutionResult,
  MineSkillExecutionResult,
  SkillExecutionResult,
  SkillName,
} from "../core-ports/skills.js";
import { SKILL_DIRECTORY } from "../core-ports/skills.js";

/** skill（技能） 最近上下文终态。 */
export type SkillRecentEventStatus = "completed" | "failed" | "interrupted" | "cancelled";

/** skill（技能） 最近上下文格式化输入。 */
export type SkillRecentEventLineInput =
  | {
      readonly skill: "goTo";
      readonly status: SkillRecentEventStatus;
      readonly result?: GoToSkillExecutionResult;
      readonly message?: string;
    }
  | {
      readonly skill: "collect";
      readonly status: SkillRecentEventStatus;
      readonly result?: CollectSkillExecutionResult;
      readonly message?: string;
    }
  | {
      readonly skill: "cutTree";
      readonly status: SkillRecentEventStatus;
      readonly result?: CutTreeSkillExecutionResult;
      readonly message?: string;
    }
  | {
      readonly skill: "mine";
      readonly status: SkillRecentEventStatus;
      readonly result?: MineSkillExecutionResult;
      readonly message?: string;
    };

type SkillRecentEventFormatter<TSkill extends SkillRecentEventLineInput["skill"]> = (
  input: Extract<SkillRecentEventLineInput, { readonly skill: TSkill }>,
) => string;

/** 已上线 skill（技能） 的最近上下文 formatter（格式化器） 表。 */
export const SKILL_RECENT_EVENT_FORMATTERS = Object.freeze({
  [SKILL_DIRECTORY.goTo]: formatGoToRecentEventLine,
  [SKILL_DIRECTORY.collect]: formatCollectRecentEventLine,
  [SKILL_DIRECTORY.cutTree]: formatCutTreeRecentEventLine,
  [SKILL_DIRECTORY.mine]: formatMineRecentEventLine,
} satisfies {
  readonly [TName in SkillRecentEventLineInput["skill"]]: SkillRecentEventFormatter<TName>;
});

/** 格式化 skill（技能） 执行结果为确定性单行。 */
export function formatSkillRecentEventLine(input: SkillRecentEventLineInput): string {
  switch (input.skill) {
    case SKILL_DIRECTORY.goTo:
      return SKILL_RECENT_EVENT_FORMATTERS.goTo(input);
    case SKILL_DIRECTORY.collect:
      return SKILL_RECENT_EVENT_FORMATTERS.collect(input);
    case SKILL_DIRECTORY.cutTree:
      return SKILL_RECENT_EVENT_FORMATTERS.cutTree(input);
    case SKILL_DIRECTORY.mine:
      return SKILL_RECENT_EVENT_FORMATTERS.mine(input);
  }
}

/** 校验已上线 skill（技能） 都具备 formatter（格式化器）。 */
export function assertSkillRecentEventFormatters(skills: readonly SkillName[]): void {
  for (const skill of skills) {
    if (
      (skill === SKILL_DIRECTORY.goTo ||
        skill === SKILL_DIRECTORY.collect ||
        skill === SKILL_DIRECTORY.cutTree ||
        skill === SKILL_DIRECTORY.mine) &&
      SKILL_RECENT_EVENT_FORMATTERS[skill] === undefined
    ) {
      throw new Error(`Missing recent event formatter for skill ${skill}`);
    }
  }
}

function formatMineRecentEventLine(input: Extract<SkillRecentEventLineInput, { skill: "mine" }>) {
  switch (input.status) {
    case "completed":
      return input.result === undefined
        ? "mine 成功"
        : `mine 成功,获得 ${input.result.collected_item_name ?? input.result.block_name} x${input.result.collected_count}`;
    case "failed":
      return `mine 失败：${normalizeMessage(input.message)}`;
    case "interrupted":
      return `mine 中断：${normalizeMessage(input.message)}`;
    case "cancelled":
      return `mine 取消：${normalizeMessage(input.message)}`;
  }
}

function formatGoToRecentEventLine(input: Extract<SkillRecentEventLineInput, { skill: "goTo" }>) {
  switch (input.status) {
    case "completed": {
      const target = input.result?.target;
      return target === undefined
        ? "goTo 成功"
        : `goTo 成功,到达 (${formatNumber(target.x)},${formatNumber(target.y)},${formatNumber(target.z)})`;
    }
    case "failed":
      return `goTo 失败：${normalizeMessage(input.message)}`;
    case "interrupted":
      return `goTo 中断：${normalizeMessage(input.message)}`;
    case "cancelled":
      return `goTo 取消：${normalizeMessage(input.message)}`;
  }
}

function formatCollectRecentEventLine(
  input: Extract<SkillRecentEventLineInput, { skill: "collect" }>,
) {
  switch (input.status) {
    case "completed": {
      const collected = input.result?.collected ?? [];
      if (collected.length === 0) {
        return "collect 成功,未捡到物品";
      }

      return `collect 成功,捡到 ${collected
        .map((item) => `${item.name} x${item.count}`)
        .join(", ")}`;
    }
    case "failed":
      return `collect 失败：${normalizeMessage(input.message)}`;
    case "interrupted":
      return `collect 中断：${normalizeMessage(input.message)}`;
    case "cancelled":
      return `collect 取消：${normalizeMessage(input.message)}`;
  }
}

function formatCutTreeRecentEventLine(
  input: Extract<SkillRecentEventLineInput, { skill: "cutTree" }>,
) {
  switch (input.status) {
    case "completed":
      return input.result === undefined
        ? "cutTree 成功"
        : `cutTree ${input.result.completed ? "成功" : "不足"},获得 ${input.result.collected_count}/${input.result.requested_count} 个原木`;
    case "failed":
      return `cutTree 失败：${normalizeMessage(input.message)}`;
    case "interrupted":
      return `cutTree 中断：${normalizeMessage(input.message)}`;
    case "cancelled":
      return `cutTree 取消：${normalizeMessage(input.message)}`;
  }
}

function normalizeMessage(message: string | undefined): string {
  const normalized = message?.replaceAll(/\s+/gu, " ").trim();

  return normalized === undefined || normalized.length === 0 ? "unknown" : normalized;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
