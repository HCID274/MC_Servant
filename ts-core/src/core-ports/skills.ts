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

/** `collect`（捡拾） 面向规划层的建议最小搜索半径。 */
export const COLLECT_MIN_RADIUS = 32;

/** `collect`（捡拾） 显式调用允许的最小搜索半径。 */
export const COLLECT_EXPLICIT_MIN_RADIUS = 1;

/** `collect`（捡拾） 默认搜索半径。 */
export const COLLECT_DEFAULT_RADIUS = 32;

/** `collect`（捡拾） 允许的最大搜索半径。 */
export const COLLECT_MAX_RADIUS = 64;

/** `equip`（装备） 技能允许的目标槽位。 */
export const EQUIP_DESTINATIONS = Object.freeze(["hand"] as const);

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

/** `mine`（挖掘） 内部执行目标候选；只能由 ResourceService（资源服务） 或 runtime（运行时）事实源注入。 */
export interface MineSkillTargetCandidate {
  /** 具体方块名。 */
  readonly block_name: string;
  /** 目标方块坐标。 */
  readonly position: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
}

/** `mine`（挖掘） 内部执行请求；公共 sandbox（沙箱） 仍只暴露 MineSkillParams。 */
export interface MineSkillExecutionRequest extends MineSkillParams {
  /** 当前世界键，必须由既有 worldKey（世界键） 端口传入。 */
  readonly worldKey?: string | null;
  /** ResourceService（资源服务） 选出的具体候选；ore（矿石） 路径必须提供。 */
  readonly targets?: readonly MineSkillTargetCandidate[];
}

/** `cutTree`（砍树） 技能参数。 */
export interface CutTreeSkillParams {
  /** 期望砍伐的树木数量。 */
  readonly count: number;
}

/** `collect`（捡拾掉落物） 技能参数。 */
export interface CollectSkillParams {
  /** 可选目标物品标准名称；省略时收集范围内所有掉落物。 */
  readonly itemName?: string;
  /** 可选中心点；省略时使用 Bot（机器人） 当前坐标。 */
  readonly center?: Readonly<{
    /** 中心点 X 坐标。 */
    readonly x: number;
    /** 中心点 Y 坐标。 */
    readonly y: number;
    /** 中心点 Z 坐标。 */
    readonly z: number;
  }>;
  /** 可选搜索半径；默认 32，显式调用允许范围 1 到 64。 */
  readonly radius?: number;
  /** 可选执行超时毫秒数。 */
  readonly timeoutMs?: number;
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

/** 工具链能力失败码；用于 sandbox（沙箱） 可编排能力的结构化失败结果。 */
export const TOOLCHAIN_FAILURE_CODES = Object.freeze([
  "missing_materials",
  "missing_crafting_table",
  "crafting_table_unavailable",
  "recipe_not_found",
  "runtime_craft_failed",
  "runtime_mine_failed",
  "drop_not_obtained",
  "missing_crafting_table_item",
  "no_placeable_position",
  "place_failed",
  "cached_position_invalid",
  "cannot_place",
  "missing_item",
  "runtime_equip_failed",
  "not_equipped",
  "resource_not_found",
  "unsafe_path",
  "unreachable_target",
  "inventory_full",
  "world_mismatch",
  "unsupported_capability",
] as const);

/** 工具链能力失败码联合类型。 */
export type ToolchainFailureCode = (typeof TOOLCHAIN_FAILURE_CODES)[number];

/** 工具链能力失败结果。 */
export interface ToolchainFailure {
  /** 结构化失败码。 */
  readonly code: ToolchainFailureCode;
  /** 失败发生阶段；用于 sandbox（沙箱） 后续上下文与 replan（重新规划）。 */
  readonly failure_stage?: string;
  /** 面向 diagnostics（诊断） 与 replan（重新规划） 的短消息。 */
  readonly message: string;
  /** 当前世界键；必须来自 currentWorld（当前世界）/ResourceService（资源服务） 既有接口。 */
  readonly world_key: string | null;
  /** 失败时 Bot（机器人） 当前位置摘要。 */
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
  /** 失败时背包摘要。 */
  readonly inventory?: Readonly<Record<string, unknown>>;
  /** 失败时装备摘要。 */
  readonly equipment?: Readonly<Record<string, unknown>>;
  /** 失败时目标完成度摘要。 */
  readonly progress?: Readonly<Record<string, unknown>>;
  /** 可选补充上下文，不承载手写 Minecraft（我的世界） 事实。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 工具链 ensure（确保） 内部执行过的可审计动作摘要。 */
export interface ToolchainActionSummary {
  /** 被调用的通用能力名。 */
  readonly action: ToolchainCapabilityName | SkillName;
  /** 动作目标。 */
  readonly target: string;
  /** 动作请求数量；不适用时为 1。 */
  readonly requested_count: number;
  /** 动作完成数量；失败或不可得时为 0。 */
  readonly completed_count: number;
  /** 动作结果状态。 */
  readonly status: "completed" | "skipped" | "failed";
  /** 底层能力返回的当前世界键。 */
  readonly world_key?: string | null;
  /** 可选结构化原因。 */
  readonly reason?: string;
}

/** 工具链能力成功结果。 */
export interface ToolchainCapabilitySuccess<TData extends object> {
  /** 固定成功标记。 */
  readonly ok: true;
  /** 能力返回数据。 */
  readonly data: TData;
}

/** 工具链能力失败结果。 */
export interface ToolchainCapabilityFailure {
  /** 固定失败标记。 */
  readonly ok: false;
  /** 结构化失败。 */
  readonly error: ToolchainFailure;
}

/** 工具链能力统一返回结构。 */
export type ToolchainCapabilityResult<TData extends object> =
  | ToolchainCapabilitySuccess<TData>
  | ToolchainCapabilityFailure;

/** sandbox（沙箱） 工具链能力名；当前仅作契约声明，未注册为 Phase 1（第一阶段） 可执行技能。 */
export const TOOLCHAIN_CAPABILITY_NAMES = Object.freeze([
  "craft",
  "place",
  "placeCraftingTable",
  "equip",
  "mine",
  "ensureLogs",
  "ensureCraftingTablePlaced",
  "ensureWoodenPickaxeEquipped",
  "ensureCobblestone",
  "ensureStonePickaxeEquipped",
] as const);

/** 禁止出现的一键 demo（演示） 能力名。 */
export const FORBIDDEN_TOOLCHAIN_DEMO_NAMES = Object.freeze(["demoMineIron"] as const);

/** sandbox（沙箱） 工具链能力名联合类型。 */
export type ToolchainCapabilityName = (typeof TOOLCHAIN_CAPABILITY_NAMES)[number];

/** 禁止的一键 demo（演示） 能力名联合类型。 */
export type ForbiddenToolchainDemoName = (typeof FORBIDDEN_TOOLCHAIN_DEMO_NAMES)[number];

/** `craft`（合成） 工具链参数。 */
export interface CraftCapabilityParams {
  /** 目标物品标准名称。 */
  readonly itemName: string;
  /** 期望合成数量。 */
  readonly count: number;
}

/** `place`（放置） 工具链参数。 */
export interface PlaceCapabilityParams {
  /** 目标方块标准名称。 */
  readonly blockName: string;
  /** 可选放置参考点；省略时由 runtime（运行时） 在当前世界选择安全候选。 */
  readonly near?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}

/** `ensureLogs`（确保原木） 参数。 */
export interface EnsureLogsCapabilityParams {
  /** 期望背包中至少存在的原木数量。 */
  readonly count: number;
}

/** `ensureCobblestone`（确保圆石） 参数。 */
export interface EnsureCobblestoneCapabilityParams {
  /** 期望背包中至少存在的圆石数量。 */
  readonly count: number;
}

/** 无参数 ensure（确保） 能力参数。 */
export type EmptyEnsureCapabilityParams = Readonly<Record<string, never>>;

/** 工具链能力参数映射。 */
export interface ToolchainCapabilityParamsByName {
  /** `craft`（合成） 参数。 */
  readonly craft: CraftCapabilityParams;
  /** `place`（放置） 参数。 */
  readonly place: PlaceCapabilityParams;
  /** `placeCraftingTable`（放置工作台） 无参数快捷入口。 */
  readonly placeCraftingTable: EmptyEnsureCapabilityParams;
  /** `equip`（装备） 复用技能参数。 */
  readonly equip: EquipSkillParams;
  /** `mine`（挖掘） 复用技能参数。 */
  readonly mine: MineSkillParams;
  /** `ensureLogs`（确保原木） 参数。 */
  readonly ensureLogs: EnsureLogsCapabilityParams;
  /** `ensureCraftingTablePlaced`（确保工作台已放置） 参数。 */
  readonly ensureCraftingTablePlaced: EmptyEnsureCapabilityParams;
  /** `ensureWoodenPickaxeEquipped`（确保木镐已装备） 参数。 */
  readonly ensureWoodenPickaxeEquipped: EmptyEnsureCapabilityParams;
  /** `ensureCobblestone`（确保圆石） 参数。 */
  readonly ensureCobblestone: EnsureCobblestoneCapabilityParams;
  /** `ensureStonePickaxeEquipped`（确保石镐已装备） 参数。 */
  readonly ensureStonePickaxeEquipped: EmptyEnsureCapabilityParams;
}

/** 工具链能力通用成功数据。 */
export interface ToolchainCapabilityData {
  /** 当前世界键。 */
  readonly world_key: string | null;
  /** 完成数量；不适用时为 1。 */
  readonly completed_count: number;
  /** 目标完成数量；ensure（确保） 能力用于表达最终目标。 */
  readonly target_count?: number;
  /** 关键产物或目标标准名称。 */
  readonly item_name?: string;
  /** 关键方块标准名称。 */
  readonly block_name?: string;
  /** 可选方块位置；必须来自当前 runtime（运行时） 世界交互结果。 */
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
  /** ensure（确保） 能力的动作摘要。 */
  readonly actions?: readonly ToolchainActionSummary[];
}

/** 工具链能力结果映射。 */
export type ToolchainCapabilityResultByName = {
  readonly [TName in ToolchainCapabilityName]: ToolchainCapabilityResult<ToolchainCapabilityData>;
};

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

/** 判断值是否为 `collect`（捡拾） 可用中心点。 */
function isCollectCenter(value: unknown): value is NonNullable<CollectSkillParams["center"]> {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ["x", "y", "z"])) {
    return false;
  }

  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
}

/** 判断值是否为工具链 `place`（放置） 可用参考点。 */
function isPlaceNear(value: unknown): value is NonNullable<PlaceCapabilityParams["near"]> {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ["x", "y", "z"])) {
    return false;
  }

  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
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
  if (
    !isRecord(params) ||
    !hasOnlyAllowedKeys(params, ["itemName", "center", "radius", "timeoutMs"])
  ) {
    return false;
  }

  return (
    (params.itemName === undefined || isNonEmptyString(params.itemName)) &&
    (params.center === undefined || isCollectCenter(params.center)) &&
    (params.radius === undefined ||
      (isPositiveInteger(params.radius) &&
        params.radius >= COLLECT_EXPLICIT_MIN_RADIUS &&
        params.radius <= COLLECT_MAX_RADIUS)) &&
    (params.timeoutMs === undefined || isPositiveInteger(params.timeoutMs))
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

/** 校验 `place`（放置） 工具链参数。 */
export function isPlaceCapabilityParams(params: unknown): params is PlaceCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["blockName", "near"])) {
    return false;
  }

  return (
    isNonEmptyString(params.blockName) && (params.near === undefined || isPlaceNear(params.near))
  );
}

/** 校验 `craft`（合成） 工具链参数。 */
export function isCraftCapabilityParams(params: unknown): params is CraftCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["itemName", "count"])) {
    return false;
  }

  return isNonEmptyString(params.itemName) && isPositiveInteger(params.count);
}

/** 校验 `ensureLogs`（确保原木） 工具链参数。 */
export function isEnsureLogsCapabilityParams(
  params: unknown,
): params is EnsureLogsCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["count"])) {
    return false;
  }

  return isPositiveInteger(params.count);
}

/** 校验 `ensureCobblestone`（确保圆石） 工具链参数。 */
export function isEnsureCobblestoneCapabilityParams(
  params: unknown,
): params is EnsureCobblestoneCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["count"])) {
    return false;
  }

  return isPositiveInteger(params.count);
}

/** 校验无参数 ensure（确保） 工具链参数。 */
export function isEmptyEnsureCapabilityParams(
  params: unknown,
): params is EmptyEnsureCapabilityParams {
  return isRecord(params) && hasOnlyAllowedKeys(params, []);
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
      summary: "按物品名与中心点执行范围内掉落物清扫",
      parameterKeys: ["itemName", "center", "radius"],
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
  /** 当前世界 / 维度键。 */
  readonly world_key: string | null;
  /** 预期进入背包的掉落物标准名称。 */
  readonly collected_item_name: string | null;
  /** 已确认进入背包的目标掉落物数量。 */
  readonly collected_count: number;
  /** 实际完成的挖掘数量。 */
  readonly mined_count: number;
  /** 执行诊断。 */
  readonly diagnostics: readonly string[];
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: number;
}

/** `collect`（捡拾） 技能执行结果。 */
export interface CollectSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "collect";
  /** 目标物品标准名称。 */
  readonly item_name: string | null;
  /** 本次清扫中心点。 */
  readonly center: NonNullable<CollectSkillParams["center"]>;
  /** 使用的搜索半径。 */
  readonly radius: number;
  /** 已确认进入背包的物品差异。 */
  readonly collected: readonly CollectSkillCollectedItem[];
  /** 本次跳过或失败的掉落物实体。 */
  readonly skipped: readonly CollectSkillSkippedItem[];
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: number;
}

/** `cutTree`（砍树） 单簇执行摘要。 */
export interface CutTreeSkillClusterExecution {
  /** 来源树木簇标识。 */
  readonly cluster_id: string;
  /** 具体原木方块名。 */
  readonly log_block_name: string;
  /** 该簇预估原木数量。 */
  readonly estimated_log_count: number;
  /** 本轮推荐挖掘目标。 */
  readonly target: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
  /** 本轮背包实际增长数量。 */
  readonly collected_count: number;
}

/** `cutTree`（砍树） 技能执行结果。 */
export interface CutTreeSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "cutTree";
  /** 用户请求的原木数量。 */
  readonly requested_count: number;
  /** 当前世界 / 维度键。 */
  readonly world_key: string | null;
  /** 实际进入背包的原木数量。 */
  readonly collected_count: number;
  /** 是否已按背包增量满足请求。 */
  readonly completed: boolean;
  /** 执行终态。 */
  readonly status: "completed" | "insufficient";
  /** 已尝试的树木簇。 */
  readonly clusters: readonly CutTreeSkillClusterExecution[];
  /** 执行诊断。 */
  readonly diagnostics: readonly string[];
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: number;
}

/** `collect`（捡拾） 执行结果中的物品增量。 */
export interface CollectSkillCollectedItem {
  /** 物品标准名称。 */
  readonly name: string;
  /** 背包中增长的数量。 */
  readonly count: number;
}

/** `collect`（捡拾） 执行结果中的跳过记录。 */
export interface CollectSkillSkippedItem {
  /** 掉落物实体标识。 */
  readonly entityId: number | string;
  /** 跳过原因。 */
  readonly reason:
    | "despawned_or_collected_by_other"
    | "inventory_full"
    | "not_found"
    | "timeout"
    | "unreachable";
}

/** `equip`（装备） 技能执行结果。 */
export interface EquipSkillExecutionResult {
  /** 已执行的技能名。 */
  readonly skill: "equip";
  /** 已装备的物品标准名称。 */
  readonly item_name: string;
  /** 实际装备槽位。 */
  readonly destination: NonNullable<EquipSkillParams["destination"]> | "hand";
  /** 装备结果状态。 */
  readonly status: "already_equipped" | "equipped";
  /** 当前最小执行器的步骤数。 */
  readonly total_steps: 0 | 1;
}

/** 技能执行结果联合。 */
export type SkillExecutionResult =
  | GoToSkillExecutionResult
  | MineSkillExecutionResult
  | CutTreeSkillExecutionResult
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
  mine(params: Readonly<MineSkillExecutionRequest>): Promise<MineSkillExecutionResult>;
}

/** `collect`（捡拾） 技能执行适配器。 */
export interface CollectSkillAdapter {
  /** 按物品标准名称执行最小真实捡拾。 */
  collect(params: Readonly<SkillParamsByName["collect"]>): Promise<CollectSkillExecutionResult>;
}

/** `cutTree`（砍树） 技能执行适配器。 */
export interface CutTreeSkillAdapter {
  /** 按背包增量执行确定性树木资源簇消费。 */
  cutTree(params: Readonly<SkillParamsByName["cutTree"]>): Promise<CutTreeSkillExecutionResult>;
}

/** `equip`（装备） 技能执行适配器。 */
export interface EquipSkillAdapter {
  /** 将指定物品装备到目标槽位；失败必须显式抛错。 */
  equip(params: Readonly<SkillParamsByName["equip"]>): Promise<EquipSkillExecutionResult>;
}

/** `craft`（合成） 工具链执行适配器。 */
export interface CraftToolchainAdapter {
  /** 合成当前阶段允许的工具链物品。 */
  craft(
    params: Readonly<CraftCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
}

/** `place`（放置） 工具链执行适配器。 */
export interface PlaceToolchainAdapter {
  /** 放置当前阶段允许的工具链方块。 */
  place(
    params: Readonly<PlaceCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
}

/** ensure（确保） 工具链执行适配器集合。 */
export interface ToolchainEnsureAdapter {
  /** 确保背包中有足够原木。 */
  ensureLogs?(
    params: Readonly<EnsureLogsCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
  /** 确保当前世界存在可用工作台。 */
  ensureCraftingTablePlaced?(
    params: Readonly<EmptyEnsureCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
  /** 确保木镐已装备到主手。 */
  ensureWoodenPickaxeEquipped?(
    params: Readonly<EmptyEnsureCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
  /** 确保背包中有足够圆石。 */
  ensureCobblestone?(
    params: Readonly<EnsureCobblestoneCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
  /** 确保石镐已装备到主手。 */
  ensureStonePickaxeEquipped?(
    params: Readonly<EmptyEnsureCapabilityParams>,
  ): Promise<ToolchainCapabilityResult<ToolchainCapabilityData>>;
}

/** 技能执行器依赖集合。 */
export interface SkillExecutionDependencies
  extends MineSkillAdapter,
    CollectSkillAdapter,
    EquipSkillAdapter,
    CraftToolchainAdapter,
    PlaceToolchainAdapter,
    ToolchainEnsureAdapter {
  /** `goTo`（前往坐标） 移动适配器。 */
  readonly goToMovement: GoToMovementAdapter;
  /** `cutTree`（砍树） 在真实 app（应用）装配时注入；未注入时保持禁用。 */
  readonly cutTree?: CutTreeSkillAdapter["cutTree"];
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
  outcome: {
    readonly world_key?: string | null;
    readonly collected_item_name?: string | null;
    readonly collected_count?: number;
    readonly mined_count?: number;
    readonly diagnostics?: readonly string[];
    readonly total_steps?: number;
  } = {},
): MineSkillExecutionResult {
  return Object.freeze({
    skill: "mine" as const,
    block_name: params.blockName,
    world_key: outcome.world_key ?? null,
    collected_item_name: outcome.collected_item_name ?? null,
    collected_count: outcome.collected_count ?? outcome.mined_count ?? params.count,
    mined_count: outcome.mined_count ?? params.count,
    diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    total_steps: outcome.total_steps ?? outcome.mined_count ?? params.count,
  });
}

/** 创建冻结的 `collect`（捡拾） 技能执行结果。 */
export function createCollectSkillExecutionResult(
  params: Readonly<CollectSkillParams>,
  outcome: {
    readonly center?: NonNullable<CollectSkillParams["center"]>;
    readonly collected?: readonly CollectSkillCollectedItem[];
    readonly skipped?: readonly CollectSkillSkippedItem[];
    readonly total_steps?: number;
  } = {},
): CollectSkillExecutionResult {
  return Object.freeze({
    skill: "collect" as const,
    item_name: params.itemName ?? null,
    center: Object.freeze({
      x: outcome.center?.x ?? params.center?.x ?? 0,
      y: outcome.center?.y ?? params.center?.y ?? 0,
      z: outcome.center?.z ?? params.center?.z ?? 0,
    }),
    radius: params.radius ?? COLLECT_DEFAULT_RADIUS,
    collected: Object.freeze(
      (outcome.collected ?? []).map((item) =>
        Object.freeze({
          name: item.name,
          count: item.count,
        }),
      ),
    ),
    skipped: Object.freeze(
      (outcome.skipped ?? []).map((item) =>
        Object.freeze({
          entityId: item.entityId,
          reason: item.reason,
        }),
      ),
    ),
    total_steps: outcome.total_steps ?? 1,
  });
}

/** 创建冻结的 `cutTree`（砍树） 技能执行结果。 */
export function createCutTreeSkillExecutionResult(
  params: Readonly<CutTreeSkillParams>,
  outcome: {
    readonly world_key?: string | null;
    readonly collected_count?: number;
    readonly completed?: boolean;
    readonly status?: CutTreeSkillExecutionResult["status"];
    readonly clusters?: readonly CutTreeSkillClusterExecution[];
    readonly diagnostics?: readonly string[];
    readonly total_steps?: number;
  } = {},
): CutTreeSkillExecutionResult {
  const collectedCount = outcome.collected_count ?? 0;
  const completed = outcome.completed ?? collectedCount >= params.count;

  return Object.freeze({
    skill: "cutTree" as const,
    requested_count: params.count,
    world_key: outcome.world_key ?? null,
    collected_count: collectedCount,
    completed,
    status: outcome.status ?? (completed ? "completed" : "insufficient"),
    clusters: Object.freeze(
      (outcome.clusters ?? []).map((cluster) =>
        Object.freeze({
          cluster_id: cluster.cluster_id,
          log_block_name: cluster.log_block_name,
          estimated_log_count: cluster.estimated_log_count,
          target: Object.freeze({
            x: cluster.target.x,
            y: cluster.target.y,
            z: cluster.target.z,
          }),
          collected_count: cluster.collected_count,
        }),
      ),
    ),
    diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    total_steps: outcome.total_steps ?? 0,
  });
}

/** 创建冻结的 `equip`（装备） 技能执行结果。 */
export function createEquipSkillExecutionResult(
  params: Readonly<EquipSkillParams>,
  outcome: {
    readonly status?: EquipSkillExecutionResult["status"];
    readonly total_steps?: EquipSkillExecutionResult["total_steps"];
  } = {},
): EquipSkillExecutionResult {
  return Object.freeze({
    skill: "equip" as const,
    item_name: params.itemName,
    destination: params.destination ?? "hand",
    status: outcome.status ?? "equipped",
    total_steps: outcome.total_steps ?? 1,
  });
}
