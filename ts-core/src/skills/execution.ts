/**
 * 技能真实执行边界。
 *
 * 1. 逻辑收口：将 skill_call 任务统一路由到可注入的执行适配器中。
 * 2. 交互隔离：通过 GoToMovementAdapter 抽象 Mineflayer 物理移动能力，支持在测试环境注入假实现。
 */

import { ExecutionTaskKind } from "../core-ports/foundation.js";
import type {
  CollectSkillAdapter,
  CollectSkillExecutionResult,
  CutTreeSkillAdapter,
  CutTreeSkillExecutionResult,
  EquipSkillAdapter,
  EquipSkillExecutionResult,
  GoToMovementAdapter,
  GoToSkillExecutionResult,
  MineSkillAdapter,
  MineSkillExecutionResult,
  SkillExecutionDependencies,
  SkillExecutionResult,
} from "../core-ports/skills.js";
import type { SkillCallJob } from "../core-ports/tasking.js";
import { SKILL_DIRECTORY, type SkillParamsByName } from "./contracts.js";

export type {
  CollectSkillExecutionResult,
  CutTreeSkillAdapter,
  CutTreeSkillExecutionResult,
  EquipSkillExecutionResult,
  GoToSkillExecutionResult,
  MineSkillExecutionResult,
  SkillExecutionDependencies,
  SkillExecutionResult,
} from "../core-ports/skills.js";

export {
  createCollectSkillExecutionResult,
  createCutTreeSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../core-ports/skills.js";

/**
 * 执行单个 skill_call 任务。
 *
 * 1. 类型分发：校验任务类型并将其分发到对应的技能执行逻辑。
 * 2. 安全边界：当前阶段仅允许既有 Phase 1（第一阶段） 单技能调用进入真实执行路径。
 *
 * @param input 包含任务对象与注入依赖的输入
 * @returns 技能执行结果
 */
export async function executeSkillCallJob(input: {
  /** 待执行任务。 */
  readonly job: SkillCallJob;
  /** 执行依赖。 */
  readonly dependencies: SkillExecutionDependencies;
}): Promise<SkillExecutionResult> {
  if (input.job.type !== ExecutionTaskKind.SkillCall) {
    throw new Error("executeSkillCallJob requires a skill_call job");
  }

  switch (input.job.skill) {
    case SKILL_DIRECTORY.goTo:
      return input.dependencies.goToMovement.goTo(input.job.params);
    case SKILL_DIRECTORY.mine:
      return input.dependencies.mine(input.job.params);
    case SKILL_DIRECTORY.collect:
      return input.dependencies.collect(input.job.params);
    case SKILL_DIRECTORY.cutTree:
      if (input.dependencies.cutTree === undefined) {
        throw new Error("Skill cutTree execution dependency is not configured");
      }

      return input.dependencies.cutTree(input.job.params);
    case SKILL_DIRECTORY.equip:
      return input.dependencies.equip(input.job.params);
  }
}
