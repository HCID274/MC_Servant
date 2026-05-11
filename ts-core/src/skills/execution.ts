/**
 * 技能真实执行边界。
 *
 * 1. 逻辑收口：将技能调用统一路由到可注入的执行适配器中。
 * 2. 交互隔离：通过 GoToMovementAdapter 抽象 Mineflayer 物理移动能力，支持在测试环境注入假实现。
 */

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
  SkillCallInput,
  SkillExecutionControl,
  SkillExecutionDependencies,
  SkillExecutionResult,
} from "../core-ports/skills.js";
import { NOOP_SKILL_EXECUTION_CONTROL } from "../core-ports/skills.js";
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
 * 执行单个技能调用。
 *
 * 1. 类型分发：校验任务类型并将其分发到对应的技能执行逻辑。
 * 2. 安全边界：当前阶段仅允许既有 Phase 1（第一阶段） 单技能调用进入真实执行路径。
 *
 * @param input 包含任务对象与注入依赖的输入
 * @returns 技能执行结果
 */
export async function executeSkillInvocation(input: {
  /** 待执行调用。 */
  readonly invocation: SkillCallInput;
  /** 执行依赖。 */
  readonly dependencies: SkillExecutionDependencies;
  /** 中断控制。 */
  readonly control: SkillExecutionControl;
}): Promise<SkillExecutionResult> {
  const control = input.control ?? NOOP_SKILL_EXECUTION_CONTROL;

  switch (input.invocation.skill) {
    case SKILL_DIRECTORY.goTo:
      return input.dependencies.goToMovement.goTo(input.invocation.params, control);
    case SKILL_DIRECTORY.mine:
      return input.dependencies.mine(input.invocation.params, control);
    case SKILL_DIRECTORY.collect:
      return input.dependencies.collect(input.invocation.params, control);
    case SKILL_DIRECTORY.cutTree:
      if (input.dependencies.cutTree === undefined) {
        throw new Error("Skill cutTree execution dependency is not configured");
      }

      return input.dependencies.cutTree(input.invocation.params, control);
    case SKILL_DIRECTORY.equip:
      return input.dependencies.equip(input.invocation.params, control);
  }
}
