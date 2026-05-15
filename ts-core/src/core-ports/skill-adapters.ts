/** 技能执行适配器契约。 */

import type { MineSkillExecutionRequest, SkillParamsByName } from "./skill-catalog.js";
import type {
  CollectSkillExecutionResult,
  CutTreeSkillExecutionResult,
  EquipSkillExecutionResult,
  GoToSkillExecutionResult,
  MineSkillExecutionResult,
} from "./skill-results.js";
import type {
  CraftCapabilityParams,
  EnsureCondition,
  EnsureConditionEvaluation,
  EnsureConditionStateSnapshot,
  EnsureDependencyParams,
  PlaceCapabilityParams,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
} from "./skill-toolchain.js";

/** 技能执行控制信号；所有真实执行适配器必须显式接收。 */
export interface SkillExecutionControl {
  readonly signal: AbortSignal;
  throwIfAborted(): void;
}

const noopSkillAbortController = new AbortController();

/** 无中断控制；仅用于测试或非 sandbox 直接调用，生产沙箱必须透传真实 signal。 */
export const NOOP_SKILL_EXECUTION_CONTROL: SkillExecutionControl = Object.freeze({
  signal: noopSkillAbortController.signal,
  throwIfAborted(): void {
    if (noopSkillAbortController.signal.aborted) {
      throw noopSkillAbortController.signal.reason;
    }
  },
});

/** `goTo` 移动适配器，真实路径由 transport 实现。 */
export interface GoToMovementAdapter {
  goTo(
    params: Readonly<SkillParamsByName["goTo"]>,
    control: SkillExecutionControl,
  ): Promise<GoToSkillExecutionResult>;
}

/** `mine` 技能执行适配器。 */
export interface MineSkillAdapter {
  mine(
    params: Readonly<MineSkillExecutionRequest>,
    control: SkillExecutionControl,
  ): Promise<MineSkillExecutionResult>;
}

/** `collect` 技能执行适配器。 */
export interface CollectSkillAdapter {
  collect(
    params: Readonly<SkillParamsByName["collect"]>,
    control: SkillExecutionControl,
  ): Promise<CollectSkillExecutionResult>;
}

/** `cutTree` 技能执行适配器。 */
export interface CutTreeSkillAdapter {
  cutTree(
    params: Readonly<SkillParamsByName["cutTree"]>,
    control: SkillExecutionControl,
  ): Promise<CutTreeSkillExecutionResult>;
}

/** `equip` 技能执行适配器。 */
export interface EquipSkillAdapter {
  equip(
    params: Readonly<SkillParamsByName["equip"]>,
    control: SkillExecutionControl,
  ): Promise<EquipSkillExecutionResult>;
}

/** `craft` 工具链执行适配器。 */
export interface CraftToolchainAdapter {
  craft(
    params: Readonly<CraftCapabilityParams>,
    control: SkillExecutionControl,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
}

/** `place` 工具链执行适配器。 */
export interface PlaceToolchainAdapter {
  place(
    params: Readonly<PlaceCapabilityParams>,
    control: SkillExecutionControl,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
}

/** ensure 工具链执行适配器集合。 */
export interface ToolchainEnsureAdapter {
  ensureDependency?(
    params: Readonly<EnsureDependencyParams>,
    control: SkillExecutionControl,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
  evaluateCondition?(
    input: Readonly<{
      readonly condition: EnsureCondition;
      readonly baseline: EnsureConditionStateSnapshot;
      readonly current: EnsureConditionStateSnapshot;
    }>,
  ): Promise<EnsureConditionEvaluation> | EnsureConditionEvaluation;
}

/** 技能执行器依赖集合。 */
export interface SkillExecutionDependencies
  extends MineSkillAdapter,
    CollectSkillAdapter,
    EquipSkillAdapter,
    CraftToolchainAdapter,
    PlaceToolchainAdapter,
    ToolchainEnsureAdapter {
  readonly goToMovement: GoToMovementAdapter;
  readonly cutTree?: CutTreeSkillAdapter["cutTree"];
}
