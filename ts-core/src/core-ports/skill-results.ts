/** 技能执行结果与严格结果工厂。 */

import {
  COLLECT_DEFAULT_RADIUS,
  type CollectSkillParams,
  type CutTreeSkillParams,
  type EquipSkillParams,
  type GoToSkillParams,
  type MineSkillParams,
} from "./skill-catalog.js";

/** `goTo` 技能执行结果。 */
export interface GoToSkillExecutionResult {
  readonly skill: "goTo";
  readonly target: Readonly<GoToSkillParams>;
  readonly world_key: string | null;
  readonly reached: true;
  readonly total_steps: number;
  readonly diagnostics?: readonly string[];
}

/** `mine` 技能执行结果。 */
export interface MineSkillExecutionResult {
  readonly skill: "mine";
  readonly block_name: string;
  readonly world_key: string | null;
  readonly collected_item_name: string;
  readonly collected_count: number;
  readonly mined_count: number;
  readonly diagnostics: readonly string[];
  readonly total_steps: number;
}

/** `collect` 技能执行结果中的物品增量。 */
export interface CollectSkillCollectedItem {
  readonly name: string;
  readonly count: number;
}

/** `collect` 技能执行结果中的跳过记录。 */
export interface CollectSkillSkippedItem {
  readonly entityId: number | string;
  readonly reason:
    | "despawned_or_collected_by_other"
    | "inventory_full"
    | "not_found"
    | "timeout"
    | "unreachable";
}

/** `collect` 技能执行结果。 */
export interface CollectSkillExecutionResult {
  readonly skill: "collect";
  readonly item_name: string | null;
  readonly world_key: string | null;
  readonly center: NonNullable<CollectSkillParams["center"]>;
  readonly radius: number;
  readonly collected: readonly CollectSkillCollectedItem[];
  readonly skipped: readonly CollectSkillSkippedItem[];
  readonly total_steps: number;
}

/** `cutTree` 单簇执行摘要。 */
export interface CutTreeSkillClusterExecution {
  readonly cluster_id: string;
  readonly log_block_name: string;
  readonly estimated_log_count: number;
  readonly target: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }>;
  readonly collected_count: number;
}

/** `cutTree` 技能执行结果。 */
export interface CutTreeSkillExecutionResult {
  readonly skill: "cutTree";
  readonly requested_count: number;
  readonly world_key: string | null;
  readonly collected_count: number;
  readonly completed: boolean;
  readonly status: "completed" | "insufficient";
  readonly clusters: readonly CutTreeSkillClusterExecution[];
  readonly diagnostics: readonly string[];
  readonly total_steps: number;
}

/** `equip` 技能执行结果。 */
export interface EquipSkillExecutionResult {
  readonly skill: "equip";
  readonly item_name: string;
  readonly world_key: string | null;
  readonly destination: NonNullable<EquipSkillParams["destination"]> | "hand";
  readonly status: "already_equipped" | "equipped";
  readonly total_steps: 0 | 1;
}

/** 技能执行结果联合。 */
export type SkillExecutionResult =
  | GoToSkillExecutionResult
  | MineSkillExecutionResult
  | CutTreeSkillExecutionResult
  | CollectSkillExecutionResult
  | EquipSkillExecutionResult;

export interface SkillCompletionProofErrorDetails {
  readonly code: "unknown_completion";
  readonly skill: "mine" | "cutTree" | "collect";
  readonly requested_count?: number;
  readonly known_fields: readonly string[];
  readonly missing_fields: readonly string[];
  readonly diagnostics: readonly string[];
}

/** 缺真实完成证明时抛出的结构化错误；sandbox 会保留 error_code 与 details。 */
export class SkillCompletionProofError extends Error {
  readonly error_code = "unknown_completion";
  readonly details: SkillCompletionProofErrorDetails;

  constructor(message: string, details: SkillCompletionProofErrorDetails) {
    super(message);
    this.name = "SkillCompletionProofError";
    this.details = Object.freeze({
      code: details.code,
      skill: details.skill,
      ...(details.requested_count === undefined
        ? {}
        : { requested_count: details.requested_count }),
      known_fields: Object.freeze([...details.known_fields]),
      missing_fields: Object.freeze([...details.missing_fields]),
      diagnostics: Object.freeze([...details.diagnostics]),
    });
  }
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownOutcomeFields(outcome: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.freeze(
    Object.keys(outcome)
      .filter((key) => outcome[key] !== undefined)
      .sort(),
  );
}

function createUnknownCompletionError(input: {
  readonly skill: SkillCompletionProofErrorDetails["skill"];
  readonly message: string;
  readonly requestedCount?: number | undefined;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly missingFields: readonly string[];
  readonly diagnostics?: readonly string[] | undefined;
}): SkillCompletionProofError {
  return new SkillCompletionProofError(input.message, {
    code: "unknown_completion",
    skill: input.skill,
    ...(input.requestedCount === undefined ? {} : { requested_count: input.requestedCount }),
    known_fields: knownOutcomeFields(input.outcome),
    missing_fields: Object.freeze([...input.missingFields]),
    diagnostics: Object.freeze([...(input.diagnostics ?? [])]),
  });
}

function requireNonNegativeIntegerField(input: {
  readonly skill: SkillCompletionProofErrorDetails["skill"];
  readonly field: string;
  readonly value: unknown;
  readonly requestedCount?: number | undefined;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly diagnostics?: readonly string[] | undefined;
}): number {
  if (isFiniteNonNegativeInteger(input.value)) {
    return input.value;
  }

  throw createUnknownCompletionError({
    skill: input.skill,
    message: `${input.skill} result lacks numeric ${input.field} completion proof`,
    requestedCount: input.requestedCount,
    outcome: input.outcome,
    missingFields: [input.field],
    diagnostics: input.diagnostics,
  });
}

function requireArrayField<TItem>(input: {
  readonly skill: SkillCompletionProofErrorDetails["skill"];
  readonly field: string;
  readonly value: unknown;
  readonly requestedCount?: number | undefined;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly diagnostics?: readonly string[] | undefined;
}): readonly TItem[] {
  if (Array.isArray(input.value)) {
    return input.value as readonly TItem[];
  }

  throw createUnknownCompletionError({
    skill: input.skill,
    message: `${input.skill} result lacks ${input.field} completion proof`,
    requestedCount: input.requestedCount,
    outcome: input.outcome,
    missingFields: [input.field],
    diagnostics: input.diagnostics,
  });
}

/** 创建冻结的 `goTo` 技能执行结果。 */
export function createGoToSkillExecutionResult(
  params: Readonly<GoToSkillParams>,
  outcome: {
    readonly world_key?: string | null;
    readonly total_steps?: number;
    readonly diagnostics?: readonly string[];
  } = {},
): GoToSkillExecutionResult {
  return Object.freeze({
    skill: "goTo" as const,
    target: Object.freeze({
      x: params.x,
      y: params.y,
      z: params.z,
    }),
    world_key: outcome.world_key ?? null,
    reached: true as const,
    total_steps: outcome.total_steps ?? 1,
    ...(outcome.diagnostics === undefined
      ? {}
      : { diagnostics: Object.freeze([...outcome.diagnostics]) }),
  });
}

/** 创建冻结的 `mine` 技能执行结果；缺背包增量 proof 必须显式失败。 */
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
  const collectedCount = requireNonNegativeIntegerField({
    skill: "mine",
    field: "collected_count",
    value: outcome.collected_count,
    requestedCount: params.count,
    outcome,
    diagnostics: outcome.diagnostics,
  });
  const minedCount = requireNonNegativeIntegerField({
    skill: "mine",
    field: "mined_count",
    value: outcome.mined_count,
    requestedCount: params.count,
    outcome,
    diagnostics: outcome.diagnostics,
  });

  if (!isNonEmptyString(outcome.collected_item_name)) {
    throw createUnknownCompletionError({
      skill: "mine",
      message: "mine result lacks collected item proof",
      requestedCount: params.count,
      outcome,
      missingFields: ["collected_item_name"],
      diagnostics: outcome.diagnostics,
    });
  }

  return Object.freeze({
    skill: "mine" as const,
    block_name: params.blockName,
    world_key: outcome.world_key ?? null,
    collected_item_name: outcome.collected_item_name,
    collected_count: collectedCount,
    mined_count: minedCount,
    diagnostics: Object.freeze([...(outcome.diagnostics ?? [])]),
    total_steps: outcome.total_steps ?? minedCount,
  });
}

/** 创建冻结的 `collect` 技能执行结果；收集增量必须来自真实背包 diff。 */
export function createCollectSkillExecutionResult(
  params: Readonly<CollectSkillParams>,
  outcome: {
    readonly world_key?: string | null;
    readonly center?: NonNullable<CollectSkillParams["center"]>;
    readonly collected?: readonly CollectSkillCollectedItem[];
    readonly skipped?: readonly CollectSkillSkippedItem[];
    readonly total_steps?: number;
    readonly diagnostics?: readonly string[];
  } = {},
): CollectSkillExecutionResult {
  const collected = requireArrayField<CollectSkillCollectedItem>({
    skill: "collect",
    field: "collected",
    value: outcome.collected,
    outcome,
    diagnostics: outcome.diagnostics,
  });

  return Object.freeze({
    skill: "collect" as const,
    item_name: params.itemName ?? null,
    world_key: outcome.world_key ?? null,
    center: Object.freeze({
      x: outcome.center?.x ?? params.center?.x ?? 0,
      y: outcome.center?.y ?? params.center?.y ?? 0,
      z: outcome.center?.z ?? params.center?.z ?? 0,
    }),
    radius: params.radius ?? COLLECT_DEFAULT_RADIUS,
    collected: Object.freeze(
      collected.map((item) =>
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

/** 创建冻结的 `cutTree` 技能执行结果；不得从缺省值推断完成。 */
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
  const collectedCount = requireNonNegativeIntegerField({
    skill: "cutTree",
    field: "collected_count",
    value: outcome.collected_count,
    requestedCount: params.count,
    outcome,
    diagnostics: outcome.diagnostics,
  });
  const clusters = requireArrayField<CutTreeSkillClusterExecution>({
    skill: "cutTree",
    field: "clusters",
    value: outcome.clusters,
    requestedCount: params.count,
    outcome,
    diagnostics: outcome.diagnostics,
  });

  const missingFields = [
    ...(typeof outcome.completed === "boolean" ? [] : ["completed"]),
    ...(outcome.status === "completed" || outcome.status === "insufficient" ? [] : ["status"]),
  ];
  if (missingFields.length > 0) {
    throw createUnknownCompletionError({
      skill: "cutTree",
      message: "cutTree result lacks explicit completion state proof",
      requestedCount: params.count,
      outcome,
      missingFields,
      diagnostics: outcome.diagnostics,
    });
  }
  const completed = outcome.completed as boolean;
  const status = outcome.status as CutTreeSkillExecutionResult["status"];

  return Object.freeze({
    skill: "cutTree" as const,
    requested_count: params.count,
    world_key: outcome.world_key ?? null,
    collected_count: collectedCount,
    completed,
    status,
    clusters: Object.freeze(
      clusters.map((cluster) =>
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

/** 创建冻结的 `equip` 技能执行结果。 */
export function createEquipSkillExecutionResult(
  params: Readonly<EquipSkillParams>,
  outcome: {
    readonly world_key?: string | null;
    readonly status?: EquipSkillExecutionResult["status"];
    readonly total_steps?: EquipSkillExecutionResult["total_steps"];
  } = {},
): EquipSkillExecutionResult {
  return Object.freeze({
    skill: "equip" as const,
    item_name: params.itemName,
    world_key: outcome.world_key ?? null,
    destination: params.destination ?? "hand",
    status: outcome.status ?? "equipped",
    total_steps: outcome.total_steps ?? 1,
  });
}
