import type {
  CollectSkillAdapter,
  CraftToolchainAdapter,
  CutTreeSkillAdapter,
  EquipSkillAdapter,
  MineSkillAdapter,
  PlaceToolchainAdapter,
  SkillExecutionControl,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainEnsureFacts,
} from "../../core-ports/skills.js";

export const DEPENDENCY_COLLECT_RADIUS = 8;
export const DEPENDENCY_RETRY_LIMIT = 3;

export type EnsureResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** ToolchainEnsure（工具链确保） 背包只读端口。 */
export interface ToolchainEnsureInventoryReader {
  /** 读取当前背包物品快照。 */
  readInventoryItems(): readonly Readonly<{ readonly item_name: string; readonly count: number }>[];
  /** 按运行时事实/测试注入的语义统计原木数量。 */
  countLogs?(
    items: readonly Readonly<{ readonly item_name: string; readonly count: number }>[],
  ): number;
}

/** ToolchainEnsure（工具链确保） 依赖集合；只能组合底层通用能力。 */
export interface ToolchainEnsureDependencies {
  readonly inventory: ToolchainEnsureInventoryReader;
  readonly facts: ToolchainEnsureFacts;
  /** 读取当前世界键；由 runtime（运行时） 既有世界键端口注入。 */
  readonly readCurrentWorldKey?: () => string | null;
  readonly craft: CraftToolchainAdapter["craft"];
  readonly place: PlaceToolchainAdapter["place"];
  readonly equip: EquipSkillAdapter["equip"];
  readonly mine: MineSkillAdapter["mine"];
  readonly collect: CollectSkillAdapter["collect"];
  readonly cutTree?: CutTreeSkillAdapter["cutTree"];
}

/** 通用 ensure（确保） 依赖解析器。 */
export interface ToolchainEnsureExecutor {
  readonly ensureDependency: (
    params: Readonly<import("../../core-ports/skills.js").EnsureDependencyParams>,
    control: SkillExecutionControl,
  ) => Promise<EnsureResult>;
}

export interface ResolverContext {
  readonly dependencies: ToolchainEnsureDependencies;
  readonly control: SkillExecutionControl;
}
