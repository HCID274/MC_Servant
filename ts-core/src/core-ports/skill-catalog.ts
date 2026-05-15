/** 技能目录、参数与参数校验契约。 */

/** Phase 1 技能标识目录。 */
export const SKILL_DIRECTORY = Object.freeze({
  goTo: "goTo",
  mine: "mine",
  cutTree: "cutTree",
  collect: "collect",
  equip: "equip",
} as const);

/** Phase 1 技能名联合类型。 */
export type SkillName = (typeof SKILL_DIRECTORY)[keyof typeof SKILL_DIRECTORY];

/** Phase 1 技能名有序列表。 */
export const PHASE1_SKILL_NAMES = Object.freeze([
  SKILL_DIRECTORY.goTo,
  SKILL_DIRECTORY.mine,
  SKILL_DIRECTORY.cutTree,
  SKILL_DIRECTORY.collect,
  SKILL_DIRECTORY.equip,
] as const);

/** `collect` 面向规划层的建议最小搜索半径。 */
export const COLLECT_MIN_RADIUS = 32;

/** `collect` 显式调用允许的最小搜索半径。 */
export const COLLECT_EXPLICIT_MIN_RADIUS = 1;

/** `collect` 默认搜索半径。 */
export const COLLECT_DEFAULT_RADIUS = 32;

/** `collect` 允许的最大搜索半径。 */
export const COLLECT_MAX_RADIUS = 64;

/** `equip` 技能允许的目标槽位。 */
export const EQUIP_DESTINATIONS = Object.freeze(["hand"] as const);

/** `equip` 技能的目标槽位联合类型。 */
export type EquipDestination = (typeof EQUIP_DESTINATIONS)[number];

/** `goTo` 技能参数。 */
export interface GoToSkillParams {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** `mine` 技能参数。 */
export interface MineSkillParams {
  readonly blockName: string;
  readonly count: number;
}

/** `mine` 内部执行目标候选；只能由 ResourceService 或 runtime 事实源注入。 */
export interface MineSkillTargetCandidate {
  readonly block_name: string;
  readonly position: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
}

/** `mine` 内部执行请求；公共 sandbox 仍只暴露 MineSkillParams。 */
export interface MineSkillExecutionRequest extends MineSkillParams {
  readonly worldKey?: string | null;
  readonly targets?: readonly MineSkillTargetCandidate[];
}

/** `cutTree` 技能参数。 */
export interface CutTreeSkillParams {
  readonly count: number;
}

/** `collect` 技能参数。 */
export interface CollectSkillParams {
  readonly itemName?: string;
  readonly center?: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
  readonly radius?: number;
  readonly timeoutMs?: number;
}

/** `equip` 技能参数。 */
export interface EquipSkillParams {
  readonly itemName: string;
  readonly destination?: EquipDestination;
}

/** Phase 1 技能参数映射表。 */
export interface SkillParamsByName {
  readonly goTo: GoToSkillParams;
  readonly mine: MineSkillParams;
  readonly cutTree: CutTreeSkillParams;
  readonly collect: CollectSkillParams;
  readonly equip: EquipSkillParams;
}

/** 单技能调用的只读桥接结构。 */
export interface SkillCall<TName extends SkillName = SkillName> {
  readonly skill: TName;
  readonly params: Readonly<SkillParamsByName[TName]>;
}

/** 所有合法技能调用输入的判别联合。 */
export type SkillCallInput = {
  [TName in SkillName]: SkillCall<TName>;
}[SkillName];

/** 技能元信息分类。 */
export type SkillCategory = "movement" | "resource" | "inventory";

/** 技能元信息结构。 */
export interface SkillMetadata {
  readonly category: SkillCategory;
  readonly summary: string;
  readonly parameterKeys: readonly string[];
}

/** 技能定义结构，当前阶段仅承载元信息与参数校验边界。 */
export interface SkillDefinition<TName extends SkillName = SkillName> {
  readonly name: TName;
  readonly metadata: SkillMetadata;
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
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

/** 判断值是否为 `collect` 可用中心点。 */
function isCollectCenter(value: unknown): value is NonNullable<CollectSkillParams["center"]> {
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

/** 校验 `goTo` 技能参数。 */
export function isGoToSkillParams(params: unknown): params is GoToSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["x", "y", "z"])) {
    return false;
  }

  return isFiniteNumber(params.x) && isFiniteNumber(params.y) && isFiniteNumber(params.z);
}

/** 校验 `mine` 技能参数。 */
export function isMineSkillParams(params: unknown): params is MineSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["blockName", "count"])) {
    return false;
  }

  return isNonEmptyString(params.blockName) && isPositiveInteger(params.count);
}

/** 校验 `cutTree` 技能参数。 */
export function isCutTreeSkillParams(params: unknown): params is CutTreeSkillParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["count"])) {
    return false;
  }

  return isPositiveInteger(params.count);
}

/** 校验 `collect` 技能参数。 */
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

/** 校验 `equip` 技能参数。 */
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

/** Phase 1 默认技能定义目录。 */
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
