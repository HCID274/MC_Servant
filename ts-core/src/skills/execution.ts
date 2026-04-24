/**
 * 技能真实执行边界。
 *
 * 1. 逻辑收口：将 skill_call 任务统一路由到可注入的执行适配器中。
 * 2. 交互隔离：通过 GoToMovementAdapter 抽象 Mineflayer 物理移动能力，支持在测试环境注入假实现。
 */

import { ExecutionTaskKind } from "../domain/contracts.js";
import type { SkillCallJob } from "../runtime/tasking.js";
import {
  type CollectSkillParams,
  type EquipSkillParams,
  type GoToSkillParams,
  type MineSkillParams,
  SKILL_DIRECTORY,
  type SkillParamsByName,
} from "./contracts.js";

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

/** `mine`（挖掘） 技能执行结果。 */
export interface MineSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "mine";
  /** 目标方块标准名称。 */
  readonly block_name: string;
  /** 实际完成的挖掘数量。 */
  readonly mined_count: number;
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: number;
}

/** `collect`（捡拾） 技能执行结果。 */
export interface CollectSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "collect";
  /** 目标物品标准名称。 */
  readonly item_name: string;
  /** 使用的搜索半径。 */
  readonly radius: number;
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: 1;
}

/** `equip`（装备） 技能执行结果。 */
export interface EquipSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "equip";
  /** 已装备的物品标准名称。 */
  readonly item_name: string;
  /** 实际装备槽位。 */
  readonly destination: NonNullable<EquipSkillParams["destination"]> | "hand";
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: 1;
}

/** 技能执行结果联合。 */
export type SkillExecutionResult =
  | GoToSkillExecutionResult
  | MineSkillExecutionResult
  | CollectSkillExecutionResult
  | EquipSkillExecutionResult;

/** `goTo`（前往坐标） 移动适配器，真实路径由 Mineflayer（Minecraft 协议客户端） transport（传输） 实现。 */
export interface GoToMovementAdapter {
  /** 移动到指定坐标；失败必须抛错，不允许静默成功。 */
  goTo(params: Readonly<SkillParamsByName["goTo"]>): Promise<GoToSkillExecutionResult>;
}

/** `mine`（挖掘） 技能执行适配器。 */
export interface MineSkillAdapter {
  /** 按方块标准名称执行最小真实挖掘。 */
  mine(params: Readonly<SkillParamsByName["mine"]>): Promise<MineSkillExecutionResult>;
}

/** `collect`（捡拾） 技能执行适配器。 */
export interface CollectSkillAdapter {
  /** 按物品标准名称执行最小真实捡拾。 */
  collect(params: Readonly<SkillParamsByName["collect"]>): Promise<CollectSkillExecutionResult>;
}

/** `equip`（装备） 技能执行适配器。 */
export interface EquipSkillAdapter {
  /** 将指定物品装备到目标槽位；失败必须显式抛错。 */
  equip(params: Readonly<SkillParamsByName["equip"]>): Promise<EquipSkillExecutionResult>;
}

/** 技能执行器依赖集合。 */
export interface SkillExecutionDependencies
  extends MineSkillAdapter,
    CollectSkillAdapter,
    EquipSkillAdapter {
  /** `goTo`（前往坐标） 移动适配器。 */
  readonly goToMovement: GoToMovementAdapter;
}

/** 创建冻结的 goTo 技能执行结果。 */
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

/** 创建冻结的 `mine`（挖掘） 技能执行结果。 */
export function createMineSkillExecutionResult(
  params: Readonly<MineSkillParams>,
): MineSkillExecutionResult {
  return Object.freeze({
    skill: "mine" as const,
    block_name: params.blockName,
    mined_count: params.count,
    total_steps: params.count,
  });
}

/** 创建冻结的 `collect`（捡拾） 技能执行结果。 */
export function createCollectSkillExecutionResult(
  params: Readonly<CollectSkillParams>,
): CollectSkillExecutionResult {
  return Object.freeze({
    skill: "collect" as const,
    item_name: params.itemName,
    radius: params.radius ?? 8,
    total_steps: 1 as const,
  });
}

/** 创建冻结的 `equip`（装备） 技能执行结果。 */
export function createEquipSkillExecutionResult(
  params: Readonly<EquipSkillParams>,
): EquipSkillExecutionResult {
  return Object.freeze({
    skill: "equip" as const,
    item_name: params.itemName,
    destination: params.destination ?? "hand",
    total_steps: 1 as const,
  });
}

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
    case SKILL_DIRECTORY.equip:
      return input.dependencies.equip(input.job.params);
    default:
      throw new Error(`Skill ${input.job.skill} is not executable in the current runtime`);
  }
}
