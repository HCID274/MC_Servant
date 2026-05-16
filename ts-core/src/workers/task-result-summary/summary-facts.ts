import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import {
  type TaskResultInventoryDelta,
  type TaskResultSummary,
  createTaskResultSummary,
  resolveFailureRecoverable,
} from "../../core-ports/task-result.js";

export interface SummaryOptions {
  readonly durationMs?: number;
}

export function createDurationField(options: SummaryOptions): {
  readonly duration_ms?: number;
} {
  return options.durationMs === undefined ? {} : { duration_ms: options.durationMs };
}

export function createInventoryDelta(
  itemName: string | null | undefined,
  count: number,
): readonly TaskResultInventoryDelta[] | undefined {
  if (itemName === undefined || itemName === null || count <= 0) {
    return undefined;
  }

  return Object.freeze([
    Object.freeze({
      item_name: itemName,
      count,
    }),
  ]);
}

export function readInventoryDelta(
  value: unknown,
): readonly TaskResultInventoryDelta[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const deltas = value.flatMap((item): TaskResultInventoryDelta[] => {
    if (!isRecord(item)) {
      return [];
    }
    const itemName = readOptionalString(item.item_name);
    const count = readNumber(item.count);
    if (itemName === undefined || count === undefined || count <= 0) {
      return [];
    }

    return [{ item_name: itemName, count }];
  });

  return deltas.length === 0 ? undefined : Object.freeze(deltas);
}

export function readConditionCount(
  condition: Readonly<Record<string, unknown>> | null,
): number | undefined {
  if (condition === null) {
    return undefined;
  }

  return readNumber(condition.count);
}

export function readConditionTarget(
  condition: Readonly<Record<string, unknown>> | null,
): string | undefined {
  if (condition === null) {
    return undefined;
  }

  return (
    readOptionalString(condition.itemName) ??
    readOptionalString(condition.tagName) ??
    readOptionalString(condition.blockName)
  );
}

export function createFailureSummary(input: {
  readonly code: string;
  readonly stage: string;
  readonly message: string;
  readonly recoverable: boolean | null;
  readonly details?: Readonly<Record<string, unknown>> | null;
}): NonNullable<TaskResultSummary["failure"]> {
  const details = input.details ?? {};
  return Object.freeze({
    failure_code: input.code,
    failure_stage: input.stage,
    message: input.message,
    recoverable: input.recoverable,
    current_position: readPositionSummary(details.current_position) ?? null,
    inventory_summary: readNullableRecord(details.inventory_summary) ?? null,
    equipment_summary: readNullableRecord(details.equipment_summary) ?? null,
    target_progress: readTargetProgress(details.target_progress) ?? null,
  });
}

export function createUnknownCompletionSkillSummary(input: {
  readonly skill: string;
  readonly target?: string | undefined;
  readonly knownFields: readonly string[];
  readonly missingFields: readonly string[];
  readonly worldKey?: string | undefined;
}): TaskResultSummary {
  const details = Object.freeze({
    code: "unknown_completion",
    skill: input.skill,
    known_fields: Object.freeze([...input.knownFields]),
    missing_fields: Object.freeze([...input.missingFields]),
    ...(input.target === undefined ? {} : { target: input.target }),
  });
  return createTaskResultSummary({
    task_type: ExecutionTaskKind.Code,
    operation: input.skill,
    status: "failed",
    ...(input.target === undefined ? {} : { target: input.target }),
    completed_count: 0,
    ...(input.worldKey === undefined ? {} : { world_key: input.worldKey }),
    failure: createFailureSummary({
      code: "unknown_completion",
      stage: input.skill,
      message: `${input.skill} result lacks completion proof`,
      recoverable: resolveFailureRecoverable("unknown_completion"),
      details,
    }),
    details,
  });
}

export function knownRecordFields(value: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.freeze(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(),
  );
}

export function readRequestedCount(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readNumber(value.count) ?? readNumber(value.requested_count);
}

export function readCollectedCount(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.reduce((sum, item) => {
    if (!isRecord(item)) {
      return sum;
    }
    return sum + (readNumber(item.count) ?? 0);
  }, 0);
}

export function readTargetProgressCompletedCount(
  details: Readonly<Record<string, unknown>>,
): number | undefined {
  const targetProgress = asRecord(details.target_progress);
  return readNumber(targetProgress?.completed_count);
}

export function readFailureCodeFromMessage(message: string): string {
  const separatorIndex = message.indexOf(":");
  return separatorIndex <= 0 ? "unknown_error" : message.slice(0, separatorIndex);
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === 0 ? undefined : Object.freeze(strings);
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return readNumber(value);
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

export function readToolchainSuccessData(value: unknown): {
  readonly world_key: string | null;
  readonly completed_count: number;
  readonly item_name?: string;
  readonly block_name?: string;
} | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return null;
  }

  const data = value.data;
  if (typeof data.completed_count !== "number") {
    return null;
  }

  return Object.freeze({
    world_key: typeof data.world_key === "string" ? data.world_key : null,
    completed_count: data.completed_count,
    ...(typeof data.item_name === "string" ? { item_name: data.item_name } : {}),
    ...(typeof data.block_name === "string" ? { block_name: data.block_name } : {}),
  });
}

function readNullableRecord(value: unknown): Readonly<Record<string, unknown>> | null | undefined {
  if (value === null) {
    return null;
  }

  return asRecord(value) ?? undefined;
}

function readPositionSummary(
  value: unknown,
): NonNullable<TaskResultSummary["failure"]>["current_position"] {
  if (!isRecord(value)) {
    return value === null ? null : undefined;
  }

  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const z = readNumber(value.z);
  if (x === undefined || y === undefined || z === undefined) {
    return undefined;
  }

  return Object.freeze({ x, y, z });
}

function readTargetProgress(
  value: unknown,
): NonNullable<TaskResultSummary["failure"]>["target_progress"] {
  if (!isRecord(value)) {
    return value === null ? null : undefined;
  }

  const action = readOptionalString(value.action);
  const target = readOptionalString(value.target);
  const requestedCount = readNullableNumber(value.requested_count);
  const completedCount = readNullableNumber(value.completed_count);
  const targetCount = readNullableNumber(value.target_count);

  return Object.freeze({
    ...(action === undefined ? {} : { action }),
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    ...(completedCount === undefined ? {} : { completed_count: completedCount }),
    ...(targetCount === undefined ? {} : { target_count: targetCount }),
  });
}
