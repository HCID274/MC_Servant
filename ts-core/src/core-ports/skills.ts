/**
 * 技能端口契约。
 *
 * 该文件只承载 Phase 1（第一阶段） 技能名、参数、元信息与纯校验逻辑。
 * runtime（运行时）、sandbox（沙箱） 与 conversation（对话） 依赖这里，而不是依赖 skills（技能） 实现模块。
 */

/** Phase 1（第一阶段） 技能标识目录。 */
export const SKILL_DIRECTORY = Object.freeze({
  goTo: "goTo",
  mine: "mine",
  cutTree: "cutTree",
  collect: "collect",
  equip: "equip",
} as const);

/** Phase 1（第一阶段） 技能名联合类型。 */
export type SkillName = (typeof SKILL_DIRECTORY)[keyof typeof SKILL_DIRECTORY];

/** Phase 1（第一阶段） 技能名有序列表。 */
export const PHASE1_SKILL_NAMES = Object.freeze([
  SKILL_DIRECTORY.goTo,
  SKILL_DIRECTORY.mine,
  SKILL_DIRECTORY.cutTree,
  SKILL_DIRECTORY.collect,
  SKILL_DIRECTORY.equip,
] as const);

/** `equip`（装备） 技能允许的目标槽位。 */
export const EQUIP_DESTINATIONS = Object.freeze([
  "hand",
  "off-hand",
  "head",
  "torso",
  "legs",
  "feet",
] as const);

/** `equip`（装备） 技能的目标槽位联合类型。 */
export type EquipDestination = (typeof EQUIP_DESTINATIONS)[number];

/** `goTo`（前往坐标） 技能参数。 */
export interface GoToSkillParams {
  /** 目标 X 坐标。 */
  readonly x: number;
  /** 目标 Y 坐标。 */
  readonly y: number;
  /** 目标 Z 坐标。 */
  readonly z: number;
}

/** `mine`（挖掘方块） 技能参数。 */
export interface MineSkillParams {
  /** 目标方块标准名称。 */
  readonly blockName: string;
  /** 期望挖掘数量。 */
  readonly count: number;
}

/** `cutTree`（砍树） 技能参数。 */
export interface CutTreeSkillParams {
  /** 期望砍伐的树木数量。 */
  readonly count: number;
}

/** `collect`（捡拾掉落物） 技能参数。 */
export interface CollectSkillParams {
  /** 目标物品标准名称。 */
  readonly itemName: string;
  /** 可选搜索半径。 */
  readonly radius?: number;
}

/** `equip`（装备物品） 技能参数。 */
export interface EquipSkillParams {
  /** 目标物品标准名称。 */
  readonly itemName: string;
  /** 可选装备目标槽位。 */
  readonly destination?: EquipDestination;
}

/** Phase 1（第一阶段） 技能参数映射表。 */
export interface SkillParamsByName {
  /** `goTo`（前往坐标） 的参数结构。 */
  readonly goTo: GoToSkillParams;
  /** `mine`（挖掘方块） 的参数结构。 */
  readonly mine: MineSkillParams;
  /** `cutTree`（砍树） 的参数结构。 */
  readonly cutTree: CutTreeSkillParams;
  /** `collect`（捡拾掉落物） 的参数结构。 */
  readonly collect: CollectSkillParams;
  /** `equip`（装备物品） 的参数结构。 */
  readonly equip: EquipSkillParams;
}

/** 单技能调用的只读桥接结构。 */
export interface SkillCall<TName extends SkillName = SkillName> {
  /** 技能名。 */
  readonly skill: TName;
  /** 与技能名一一对齐的参数对象。 */
  readonly params: Readonly<SkillParamsByName[TName]>;
}

/** 所有合法 `skill_call`（技能调用） 输入的判别联合。 */
export type SkillCallInput = {
  [TName in SkillName]: SkillCall<TName>;
}[SkillName];

/** 技能元信息分类。 */
export type SkillCategory = "movement" | "resource" | "inventory";

/** 技能元信息结构。 */
export interface SkillMetadata {
  /** 归属分类。 */
  readonly category: SkillCategory;
  /** 面向规划层的简短描述。 */
  readonly summary: string;
  /** 参数键列表，用于目录浏览与调试。 */
  readonly parameterKeys: readonly string[];
}

/** 技能定义结构，当前阶段仅承载元信息与参数校验边界。 */
export interface SkillDefinition<TName extends SkillName = SkillName> {
  /** 技能名。 */
  readonly name: TName;
  /** 技能元信息。 */
  readonly metadata: SkillMetadata;
  /** 参数校验函数。 */
  readonly validateParams: (params: unknown) => params is SkillParamsByName[TName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEquipDestination(value: unknown): value is EquipDestination {
  return typeof value === "string" && (EQUIP_DESTINATIONS as readonly string[]).includes(value);
}

function freezePlainObject<TValue extends object>(value: TValue): Readonly<TValue> {
  return Object.freeze({ ...value });
}

function createSkillDefinition<TName extends SkillName>(input: {
  name: TName;
  metadata: SkillMetadata;
  validateParams: (params: unknown) => params is SkillParamsByName[TName];
}): SkillDefinition<TName> {
  return Object.freeze({
    name: input.name,
    metadata: Object.freeze({
      category: input.metadata.category,
      summary: input.metadata.summary,
      parameterKeys: Object.freeze([...input.metadata.parameterKeys]),
    }),
    validateParams: input.validateParams,
  });
}

/** 校验 `goTo`（前往坐标） 技能参数。 */
export function isGoToSkillParams(params: unknown): params is GoToSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["x", "y", "z"])) {
    return false;
  }

  return isFiniteNumber(params.x) && isFiniteNumber(params.y) && isFiniteNumber(params.z);
}

/** 校验 `mine`（挖掘方块） 技能参数。 */
export function isMineSkillParams(params: unknown): params is MineSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["blockName", "count"])) {
    return false;
  }

  return isNonEmptyString(params.blockName) && isPositiveInteger(params.count);
}

/** 校验 `cutTree`（砍树） 技能参数。 */
export function isCutTreeSkillParams(params: unknown): params is CutTreeSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["count"])) {
    return false;
  }

  return isPositiveInteger(params.count);
}

/** 校验 `collect`（捡拾掉落物） 技能参数。 */
export function isCollectSkillParams(params: unknown): params is CollectSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["itemName", "radius"])) {
    return false;
  }

  return (
    isNonEmptyString(params.itemName) &&
    (params.radius === undefined || isPositiveInteger(params.radius))
  );
}

/** 校验 `equip`（装备物品） 技能参数。 */
export function isEquipSkillParams(params: unknown): params is EquipSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["itemName", "destination"])) {
    return false;
  }

  return (
    isNonEmptyString(params.itemName) &&
    (params.destination === undefined || isEquipDestination(params.destination))
  );
}

/** 创建与技能目录强绑定的只读技能调用结构。 */
export function createSkillCall<TInput extends SkillCallInput>(input: TInput): TInput {
  return Object.freeze({
    skill: input.skill,
    params: freezePlainObject(input.params),
  }) as TInput;
}

/** Phase 1（第一阶段） 默认技能定义目录。 */
export const PHASE1_SKILL_DEFINITIONS = Object.freeze([
  createSkillDefinition({
    name: SKILL_DIRECTORY.goTo,
    metadata: {
      category: "movement",
      summary: "移动到指定坐标",
      parameterKeys: ["x", "y", "z"],
    },
    validateParams: isGoToSkillParams,
  }),
  createSkillDefinition({
    name: SKILL_DIRECTORY.mine,
    metadata: {
      category: "resource",
      summary: "按方块名执行单技能挖掘",
      parameterKeys: ["blockName", "count"],
    },
    validateParams: isMineSkillParams,
  }),
  createSkillDefinition({
    name: SKILL_DIRECTORY.cutTree,
    metadata: {
      category: "resource",
      summary: "按树木数量执行单技能砍伐",
      parameterKeys: ["count"],
    },
    validateParams: isCutTreeSkillParams,
  }),
  createSkillDefinition({
    name: SKILL_DIRECTORY.collect,
    metadata: {
      category: "resource",
      summary: "按物品名执行范围内捡拾",
      parameterKeys: ["itemName", "radius"],
    },
    validateParams: isCollectSkillParams,
  }),
  createSkillDefinition({
    name: SKILL_DIRECTORY.equip,
    metadata: {
      category: "inventory",
      summary: "按物品名与槽位执行装备",
      parameterKeys: ["itemName", "destination"],
    },
    validateParams: isEquipSkillParams,
  }),
] as const);

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

/** 创建冻结的 goTo（前往坐标） 技能执行结果。 */
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
