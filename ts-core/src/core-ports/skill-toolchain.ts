/** 工具链 ensure 与 sandbox 可编排能力契约。 */

import type { EquipSkillParams, MineSkillParams } from "./skill-catalog.js";
import type { SkillName } from "./skill-catalog.js";

/** 工具链能力失败码；用于 sandbox 可编排能力的结构化失败结果。 */
export const TOOLCHAIN_FAILURE_CODES = Object.freeze([
  "missing_materials",
  "missing_crafting_table",
  "crafting_table_required",
  "crafting_table_unavailable",
  "recipe_not_found",
  "runtime_craft_failed",
  "craft_failed",
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
  "condition_not_met",
  "unknown_completion",
  "unsupported_capability",
] as const);

/** 工具链能力失败码联合类型。 */
export type ToolchainFailureCode = (typeof TOOLCHAIN_FAILURE_CODES)[number];

/** 工具链能力失败结果。 */
export interface ToolchainFailure {
  readonly code: ToolchainFailureCode;
  readonly failure_stage?: string;
  readonly message: string;
  readonly world_key: string | null;
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
  readonly inventory?: Readonly<Record<string, unknown>>;
  readonly equipment?: Readonly<Record<string, unknown>>;
  readonly progress?: Readonly<Record<string, unknown>>;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 工具链 ensure 可读取的背包物品摘要。 */
export interface ToolchainEnsureInventoryItem {
  readonly item_name: string;
  readonly count: number;
}

/** ensure 可用于补物料的事实来源动作。 */
export type ToolchainMaterialSource =
  | Readonly<{
      readonly action: "mine";
      readonly itemName: string;
      readonly blockName: string;
    }>
  | Readonly<{
      readonly action: "cutTree";
      readonly itemName: string;
      readonly blockName?: string;
    }>;

/** ensure 只读事实端口；实现必须来自 runtime / minecraft-data 事实源。 */
export interface ToolchainEnsureFacts {
  resolveRequiredEquipment(input: {
    readonly failure: EnsureActionFailureSnapshot;
    readonly inventory: readonly ToolchainEnsureInventoryItem[];
  }): string | null;
  resolveMaterialSource(input: { readonly itemName: string }): ToolchainMaterialSource | null;
  canCraft(input: { readonly itemName: string }): boolean;
  resolveCraftingTableBlockName(): string | null;
  resolveBlockDropItemNames(input: { readonly blockName: string }): readonly string[];
  countInventoryItemsByTag(input: {
    readonly tagName: string;
    readonly inventory: readonly ToolchainEnsureInventoryItem[];
  }): number;
}

/** 工具链 ensure 内部执行过的可审计动作摘要。 */
export interface ToolchainActionSummary {
  readonly action: ToolchainCapabilityName | SkillName;
  readonly target: string;
  readonly requested_count: number;
  readonly completed_count: number;
  readonly status: "completed" | "skipped" | "failed";
  readonly world_key?: string | null;
  readonly reason?: string;
}

/** 工具链能力成功结果。 */
export interface ToolchainCapabilitySuccess<TData extends object> {
  readonly ok: true;
  readonly data: TData;
}

/** 工具链能力失败结果。 */
export interface ToolchainCapabilityFailure {
  readonly ok: false;
  readonly error: ToolchainFailure;
}

/** 工具链能力统一返回结构。 */
export type ToolchainCapabilityResult<TData extends object> =
  | ToolchainCapabilitySuccess<TData>
  | ToolchainCapabilityFailure;

/** sandbox 工具链能力名；当前仅作契约声明，未注册为 Phase 1 可执行技能。 */
export const TOOLCHAIN_CAPABILITY_NAMES = Object.freeze([
  "craft",
  "place",
  "equip",
  "mine",
  "ensure",
] as const);

/** 禁止出现的一键 demo 能力名。 */
export const FORBIDDEN_TOOLCHAIN_DEMO_NAMES = Object.freeze(["demoMineIron"] as const);

/** sandbox 工具链能力名联合类型。 */
export type ToolchainCapabilityName = (typeof TOOLCHAIN_CAPABILITY_NAMES)[number];

/** 禁止的一键 demo 能力名联合类型。 */
export type ForbiddenToolchainDemoName = (typeof FORBIDDEN_TOOLCHAIN_DEMO_NAMES)[number];

/** `craft` 工具链参数。 */
export interface CraftCapabilityParams {
  readonly itemName: string;
  readonly count: number;
}

/** `place` 工具链参数。 */
export interface PlaceCapabilityParams {
  readonly blockName: string;
  readonly near?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}

/** ensure 支持的完成条件。 */
export type EnsureCondition =
  | Readonly<{
      readonly kind: "gained";
      readonly itemName: string;
      readonly count: number;
    }>
  | Readonly<{
      readonly kind: "gainedTag";
      readonly tagName: string;
      readonly count: number;
    }>
  | Readonly<{
      readonly kind: "gainedDropOf";
      readonly blockName: string;
      readonly count: number;
    }>
  | Readonly<{
      readonly kind: "has";
      readonly itemName: string;
      readonly count: number;
    }>
  | Readonly<{
      readonly kind: "equipped";
      readonly itemName: string;
    }>
  | Readonly<{
      readonly kind: "placed";
      readonly blockName: string;
    }>;

/** ensure 从失败动作恢复所需的结构化失败快照。 */
export interface EnsureActionFailureSnapshot {
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly code: ToolchainFailureCode | string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 通用 ensure 依赖解析输入。 */
export interface EnsureDependencyParams {
  readonly failure: EnsureActionFailureSnapshot;
  readonly condition: EnsureCondition;
}

/** ensure 条件检查所需的真实状态快照。 */
export interface EnsureConditionStateSnapshot {
  readonly world_key: string | null;
  readonly inventory: readonly ToolchainEnsureInventoryItem[];
  readonly main_hand_item_name?: string | null;
  readonly nearby_block_names?: readonly string[];
}

/** ensure 条件检查结果。 */
export interface EnsureConditionEvaluation {
  readonly ok: boolean;
  readonly condition: EnsureCondition;
  readonly completed_count: number;
  readonly target_count: number;
  readonly missing_count: number;
  readonly resolved_targets: readonly string[];
  readonly baseline: EnsureConditionStateSnapshot;
  readonly current: EnsureConditionStateSnapshot;
}

/** 工具链能力参数映射。 */
export interface ToolchainCapabilityParamsByName {
  readonly craft: CraftCapabilityParams;
  readonly place: PlaceCapabilityParams;
  readonly equip: EquipSkillParams;
  readonly mine: MineSkillParams;
  readonly ensure: EnsureDependencyParams;
}

/** 工具链能力通用成功数据。 */
export interface ToolchainCapabilityData {
  readonly world_key: string | null;
  readonly completed_count: number;
  readonly target_count?: number;
  readonly item_name?: string;
  readonly block_name?: string;
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
  readonly actions?: readonly ToolchainActionSummary[];
}

/** 工具链能力结果映射。 */
export type ToolchainCapabilityResultByName = {
  readonly [TName in ToolchainCapabilityName]: ToolchainCapabilityResult<ToolchainCapabilityData>;
};

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

function isPlaceNear(value: unknown): value is NonNullable<PlaceCapabilityParams["near"]> {
  if (!isRecord(value) || !hasOnlyAllowedKeys(value, ["x", "y", "z"])) {
    return false;
  }

  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
}

/** 校验 `place` 工具链参数。 */
export function isPlaceCapabilityParams(params: unknown): params is PlaceCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["blockName", "near"])) {
    return false;
  }

  return (
    isNonEmptyString(params.blockName) && (params.near === undefined || isPlaceNear(params.near))
  );
}

/** 校验 `craft` 工具链参数。 */
export function isCraftCapabilityParams(params: unknown): params is CraftCapabilityParams {
  if (!isRecord(params) || !hasOnlyAllowedKeys(params, ["itemName", "count"])) {
    return false;
  }

  return isNonEmptyString(params.itemName) && isPositiveInteger(params.count);
}

/** 校验 ensure 完成条件。 */
export function isEnsureCondition(value: unknown): value is EnsureCondition {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    return false;
  }

  switch (value.kind) {
    case "gained":
    case "has":
      return (
        hasOnlyAllowedKeys(value, ["kind", "itemName", "count"]) &&
        isNonEmptyString(value.itemName) &&
        isPositiveInteger(value.count)
      );
    case "gainedTag":
      return (
        hasOnlyAllowedKeys(value, ["kind", "tagName", "count"]) &&
        isNonEmptyString(value.tagName) &&
        isPositiveInteger(value.count)
      );
    case "gainedDropOf":
      return (
        hasOnlyAllowedKeys(value, ["kind", "blockName", "count"]) &&
        isNonEmptyString(value.blockName) &&
        isPositiveInteger(value.count)
      );
    case "equipped":
      return hasOnlyAllowedKeys(value, ["kind", "itemName"]) && isNonEmptyString(value.itemName);
    case "placed":
      return hasOnlyAllowedKeys(value, ["kind", "blockName"]) && isNonEmptyString(value.blockName);
    default:
      return false;
  }
}

/** 校验 ensure 动作失败快照。 */
export function isEnsureActionFailureSnapshot(
  value: unknown,
): value is EnsureActionFailureSnapshot {
  return (
    isRecord(value) &&
    hasOnlyAllowedKeys(value, ["action", "params", "code", "message", "details"]) &&
    isNonEmptyString(value.action) &&
    isRecord(value.params) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.message) &&
    (value.details === undefined || isRecord(value.details))
  );
}

/** 校验通用 ensure 依赖解析参数。 */
export function isEnsureDependencyParams(value: unknown): value is EnsureDependencyParams {
  return (
    isRecord(value) &&
    hasOnlyAllowedKeys(value, ["failure", "condition"]) &&
    isEnsureActionFailureSnapshot(value.failure) &&
    isEnsureCondition(value.condition)
  );
}
