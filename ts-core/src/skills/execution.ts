/**
 * 技能真实执行边界。
 *
 * 架构职责：
 * 1. 将 `skill_call`（技能调用） 任务收口到可注入执行适配器。
 * 2. 当前阶段只允许 `goTo`（前往坐标） 进入真实执行路径。
 * 3. 为测试提供 fake（假） movement adapter（移动适配器） 注入点，避免依赖真实 MC（Minecraft，我的世界） 服务器。
 */

import { ExecutionTaskKind } from "../domain/contracts.js";
import type { SkillCallJob } from "../runtime/tasking.js";
import { type GoToSkillParams, SKILL_DIRECTORY, type SkillParamsByName } from "./contracts.js";

/** `goTo`（前往坐标） 技能执行结果。 */
export interface GoToSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "goTo";
  /** 目标坐标。 */
  readonly target: Readonly<GoToSkillParams>;
  /** 是否已由底层移动适配器确认完成。 */
  readonly reached: true;
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: 1;
}

/** 技能执行结果联合。 */
export type SkillExecutionResult = GoToSkillExecutionResult;

/** `goTo`（前往坐标） 移动适配器，真实路径由 Mineflayer（Minecraft 协议客户端） transport（传输） 实现。 */
export interface GoToMovementAdapter {
  /** 移动到指定坐标；失败必须抛错，不允许静默成功。 */
  goTo(params: Readonly<SkillParamsByName["goTo"]>): Promise<GoToSkillExecutionResult>;
}

/** 技能执行器依赖集合。 */
export interface SkillExecutionDependencies {
  /** `goTo`（前往坐标） 移动适配器。 */
  readonly goToMovement: GoToMovementAdapter;
}

/** 创建冻结的 `goTo`（前往坐标） 技能执行结果。 */
export function createGoToSkillExecutionResult(
  params: Readonly<GoToSkillParams>,
): GoToSkillExecutionResult {
  return Object.freeze({
    skill: "goTo" as const,
    target: Object.freeze({
      x: params.x,
      y: params.y,
      z: params.z,
    }),
    reached: true as const,
    total_steps: 1 as const,
  });
}

/** 执行单个 `skill_call`（技能调用） 任务。 */
export async function executeSkillCallJob(input: {
  /** 待执行任务。 */
  readonly job: SkillCallJob;
  /** 执行依赖。 */
  readonly dependencies: SkillExecutionDependencies;
}): Promise<SkillExecutionResult> {
  if (input.job.type !== ExecutionTaskKind.SkillCall) {
    throw new Error("executeSkillCallJob requires a skill_call job");
  }

  if (input.job.skill !== SKILL_DIRECTORY.goTo) {
    throw new Error(`Skill ${input.job.skill} is not executable in the current runtime`);
  }

  return input.dependencies.goToMovement.goTo(input.job.params);
}
