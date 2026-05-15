import type {
  ToolchainActionSummary,
  ToolchainFailure,
  ToolchainFailureCode,
} from "../../core-ports/skills.js";
import type { EnsureResult, ToolchainEnsureDependencies } from "./types.js";

export function createEnsureSuccess(input: {
  readonly itemName?: string;
  readonly blockName?: string;
  readonly completedCount: number;
  readonly targetCount?: number;
  readonly actions: readonly ToolchainActionSummary[];
  readonly worldKey?: string | null;
  readonly position?: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>;
}): EnsureResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      world_key: input.worldKey ?? null,
      completed_count: input.completedCount,
      ...(input.targetCount === undefined ? {} : { target_count: input.targetCount }),
      ...(input.itemName === undefined ? {} : { item_name: input.itemName }),
      ...(input.blockName === undefined ? {} : { block_name: input.blockName }),
      ...(input.position === undefined ? {} : { position: input.position }),
      actions: freezeActions(input.actions),
    }),
  });
}

export function createEnsureFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly actions: readonly ToolchainActionSummary[];
  readonly details?: Readonly<Record<string, unknown>>;
}): EnsureResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: input.code,
      message: input.message,
      world_key: input.worldKey,
      failure_stage: "ensure",
      details: Object.freeze({
        ...(input.details ?? {}),
        actions: freezeActions(input.actions),
      }),
    }),
  });
}

export function createEnsureFailureFromToolchain(
  failure: ToolchainFailure,
  actions: readonly ToolchainActionSummary[],
): EnsureResult {
  return createEnsureFailure({
    code: failure.code,
    message: failure.message,
    worldKey: failure.world_key,
    actions,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  });
}

export function createActionSummary(input: {
  readonly action: ToolchainActionSummary["action"];
  readonly target: string;
  readonly requestedCount: number;
  readonly completedCount: number;
  readonly status: ToolchainActionSummary["status"];
  readonly worldKey?: string | null;
  readonly reason?: string;
}): ToolchainActionSummary {
  return Object.freeze({
    action: input.action,
    target: input.target,
    requested_count: input.requestedCount,
    completed_count: input.completedCount,
    status: input.status,
    ...(input.worldKey === undefined ? {} : { world_key: input.worldKey }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

export function freezeActions(
  actions: readonly ToolchainActionSummary[],
): readonly ToolchainActionSummary[] {
  return Object.freeze(actions.map((action) => Object.freeze({ ...action })));
}

export function readWorldKeyFromActions(actions: readonly ToolchainActionSummary[]): string | null {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const worldKey = actions[index]?.world_key;
    if (worldKey !== undefined && worldKey !== null) {
      return worldKey;
    }
  }

  return null;
}

export function readCurrentWorldKey(dependencies: ToolchainEnsureDependencies): string | null {
  return dependencies.readCurrentWorldKey?.() ?? null;
}

export function readSkillWorldKey(result: Record<string, unknown>): string | undefined {
  return typeof result.world_key === "string" ? result.world_key : undefined;
}

export function classifySkillFailure(message: string): ToolchainFailureCode {
  if (message.includes("not_equipped")) {
    return "not_equipped";
  }
  if (message.includes("resource_not_found")) {
    return "resource_not_found";
  }
  if (message.includes("unsafe_path")) {
    return "unsafe_path";
  }
  if (message.includes("drop_not_obtained")) {
    return "drop_not_obtained";
  }
  if (message.includes("runtime_mine_failed")) {
    return "runtime_mine_failed";
  }

  return "unsupported_capability";
}

export function normalizeFailureCode(code: string): ToolchainFailureCode {
  switch (code) {
    case "missing_materials":
    case "missing_crafting_table":
    case "crafting_table_required":
    case "crafting_table_unavailable":
    case "recipe_not_found":
    case "runtime_craft_failed":
    case "craft_failed":
    case "runtime_mine_failed":
    case "drop_not_obtained":
    case "missing_crafting_table_item":
    case "no_placeable_position":
    case "place_failed":
    case "cached_position_invalid":
    case "cannot_place":
    case "missing_item":
    case "runtime_equip_failed":
    case "not_equipped":
    case "resource_not_found":
    case "unsafe_path":
    case "unreachable_target":
    case "inventory_full":
    case "world_mismatch":
    case "condition_not_met":
    case "unknown_completion":
    case "unsupported_capability":
      return code;
    default:
      return "unsupported_capability";
  }
}

export function normalizeMinecraftName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("minecraft:", "")
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

export function normalizeOptionalName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? normalizeMinecraftName(value)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
