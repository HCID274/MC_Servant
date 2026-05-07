/**
 * 任务终态结果摘要契约。
 *
 * 该契约只描述 BotWorker（机器人工作线程） 已完成的事实，供 realtime（实时推送）、
 * game chat（游戏聊天） 与 task history（任务历史） 共享，不承载执行决策。
 */

import { assertNonEmptyString } from "../domain/invariants.js";
import type { ExecutionTaskKind } from "./foundation.js";

/** 技能结果中可展示的关键背包增量。 */
export interface SkillResultInventoryDelta {
  /** 物品标准名称。 */
  readonly item_name: string;
  /** 背包增长数量。 */
  readonly count: number;
}

/** 失败时当前位置摘要。 */
export interface SkillResultPositionSummary {
  /** X 坐标。 */
  readonly x: number;
  /** Y 坐标。 */
  readonly y: number;
  /** Z 坐标。 */
  readonly z: number;
}

/** 失败时目标完成度摘要。 */
export interface SkillResultTargetProgress {
  /** 执行动作。 */
  readonly action?: string | null;
  /** 目标物品 / 方块 / 坐标摘要。 */
  readonly target?: string | null;
  /** 请求数量。 */
  readonly requested_count?: number | null;
  /** 已完成数量。 */
  readonly completed_count?: number | null;
  /** 目标总量；ensure（确保） 能力用于表达最终背包目标。 */
  readonly target_count?: number | null;
}

/** Failure Capsule（失败胶囊） 只允许进入 prompt（提示词） 的最小字段。 */
export interface FailureCapsule {
  /** 用户目标摘要。 */
  readonly goal: string;
  /** 失败动作。 */
  readonly failed_action: string;
  /** 结构化失败码。 */
  readonly failure_code: string;
  /** 目标进度。 */
  readonly progress: string;
  /** 不得原样重复的动作。 */
  readonly retry_guard: string;
  /** 一个可执行提示。 */
  readonly hint: string;
}

/** 失败码恢复分类全集。 */
export const FAILURE_RECOVERY_CLASSES = [
  "recoverable",
  "implementation_blocker",
  "unknown",
] as const;

/** 失败码恢复分类。 */
export type FailureRecoveryClass = (typeof FAILURE_RECOVERY_CLASSES)[number];

/** 技能失败统一摘要。 */
export interface SkillFailureSummary {
  /** 结构化失败码。 */
  readonly failure_code: string;
  /** 失败阶段。 */
  readonly failure_stage: string;
  /** 失败消息。 */
  readonly message: string;
  /** 是否可由后续计划恢复。 */
  readonly recoverable: boolean | null;
  /** 当前位置摘要。 */
  readonly current_position?: SkillResultPositionSummary | null;
  /** 背包摘要。 */
  readonly inventory_summary?: Readonly<Record<string, unknown>> | null;
  /** 装备摘要。 */
  readonly equipment_summary?: Readonly<Record<string, unknown>> | null;
  /** 目标完成度。 */
  readonly target_progress?: SkillResultTargetProgress | null;
}

/** 技能结果统一摘要。 */
export interface SkillResultSummary {
  /** 代码任务内的操作名或 code（代码）。 */
  readonly skill_name: string;
  /** 执行终态。 */
  readonly status: "completed" | "failed" | "interrupted";
  /** 关键目标物品 / 方块 / 坐标摘要。 */
  readonly target?: string;
  /** 用户或代码请求数量。 */
  readonly requested_count?: number;
  /** 已确认完成数量。 */
  readonly completed_count?: number;
  /** 关键背包增量。 */
  readonly inventory_delta?: readonly SkillResultInventoryDelta[];
  /** 当前世界键；必须由既有 world_key（世界键） 接口上游透传。 */
  readonly world_key?: string | null;
  /** 执行耗时；由 BotWorker（机器人工作线程） 在终态生成时注入。 */
  readonly duration_ms?: number;
  /** 面向诊断的短标签，不直接全量展示给用户。 */
  readonly diagnostics?: readonly string[];
  /** 失败摘要；仅 failed/interrupted 终态携带。 */
  readonly failure?: SkillFailureSummary;
  /** 失败后继续规划使用的短胶囊；完整细节仍只进 diagnostics（诊断）/ JSONL（结构化日志）。 */
  readonly failure_capsule?: FailureCapsule;
  /** 执行补充诊断。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 兼容 task（任务） 终态事件的结果摘要。 */
export interface TaskResultSummary extends SkillResultSummary {
  /** 执行任务类型。 */
  readonly task_type: ExecutionTaskKind;
  /** 旧字段：等价于 skill_name（技能名），保留给历史消费方。 */
  readonly operation: string;
}

/** 任务终态中可展示的关键背包增量。 */
export type TaskResultInventoryDelta = SkillResultInventoryDelta;

/** 创建冻结的任务结果摘要。 */
export function createTaskResultSummary(
  input: Omit<TaskResultSummary, "skill_name" | "status"> & {
    readonly skill_name?: string;
    readonly status?: TaskResultSummary["status"];
  },
): TaskResultSummary {
  assertNonEmptyString(input.operation, "operation");
  const skillName = input.skill_name ?? input.operation;
  const status = input.status ?? (input.failure === undefined ? "completed" : "failed");
  const failure = input.failure === undefined ? undefined : freezeFailureSummary(input.failure);
  const capsule =
    input.failure_capsule ??
    (status === "failed" && failure !== undefined
      ? createFailureCapsuleFromSummaryFields({
          skill_name: skillName,
          operation: input.operation,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.requested_count === undefined
            ? {}
            : { requested_count: input.requested_count }),
          ...(input.completed_count === undefined
            ? {}
            : { completed_count: input.completed_count }),
          failure,
        })
      : undefined);

  return Object.freeze({
    task_type: input.task_type,
    skill_name: skillName,
    operation: input.operation,
    status,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.requested_count === undefined ? {} : { requested_count: input.requested_count }),
    ...(input.completed_count === undefined ? {} : { completed_count: input.completed_count }),
    ...(input.inventory_delta === undefined
      ? {}
      : {
          inventory_delta: Object.freeze(
            input.inventory_delta.map((delta) =>
              Object.freeze({
                item_name: delta.item_name,
                count: delta.count,
              }),
            ),
          ),
        }),
    ...(input.world_key === undefined ? {} : { world_key: input.world_key }),
    ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
    ...(input.diagnostics === undefined
      ? {}
      : { diagnostics: Object.freeze([...input.diagnostics]) }),
    ...(failure === undefined ? {} : { failure }),
    ...(capsule === undefined ? {} : { failure_capsule: freezeFailureCapsule(capsule) }),
    ...(input.details === undefined ? {} : { details: Object.freeze({ ...input.details }) }),
  });
}

/** 集中管理 Failure Capsule（失败胶囊） 使用的失败分类。 */
export function classifyFailureCode(code: string | undefined): FailureRecoveryClass {
  switch (code) {
    case "missing_materials":
    case "not_equipped":
    case "resource_not_found":
    case "missing_crafting_table":
    case "crafting_table_unavailable":
    case "inventory_full":
    case "unsafe_path":
    case "unreachable_target":
    case "drop_not_obtained":
      return "recoverable";
    case "unsupported_capability":
    case "runtime_adapter_error":
    case "world_mismatch":
    case "invalid_runtime_object":
    case "protocol_error":
    case "plugin_unavailable":
      return "implementation_blocker";
    default:
      return "unknown";
  }
}

function createFailureCapsuleFromSummaryFields(input: {
  readonly skill_name: string;
  readonly operation: string;
  readonly target?: string;
  readonly requested_count?: number;
  readonly completed_count?: number;
  readonly failure: SkillFailureSummary;
}): FailureCapsule {
  const progress = input.failure.target_progress;
  const action = progress?.action ?? input.skill_name;
  const target = progress?.target ?? input.target ?? "目标";
  const requestedCount =
    progress?.requested_count ?? progress?.target_count ?? input.requested_count ?? 1;
  const completedCount = progress?.completed_count ?? input.completed_count ?? 0;
  const failureCode = input.failure.failure_code;
  const retrySignature = createRetrySignature({
    action,
    target,
    requested_count: requestedCount,
  });

  return Object.freeze({
    goal: `${action} ${target} x${requestedCount}`,
    failed_action: input.failure.failure_stage || action,
    failure_code: failureCode,
    progress: `${target} ${completedCount}/${requestedCount}`,
    retry_guard: `不要原样重复 ${retrySignature}`,
    hint: createFailureCapsuleHint({
      action,
      target,
      failure_code: failureCode,
    }),
  });
}

function createRetrySignature(input: {
  readonly action: string;
  readonly target: string;
  readonly requested_count: number | null | undefined;
}): string {
  const count = input.requested_count ?? 1;
  switch (input.action) {
    case "mine":
      return `mine("${input.target}", ${count})`;
    case "craft":
      return `craft("${input.target}", ${count})`;
    case "equip":
      return `equip("${input.target}")`;
    case "cutTree":
      return `cutTree(${count})`;
    case "collect":
      return `collect("${input.target}")`;
    default:
      return `${input.action}("${input.target}", ${count})`;
  }
}

function createFailureCapsuleHint(input: {
  readonly action: string;
  readonly target: string;
  readonly failure_code: string;
}): string {
  if (classifyFailureCode(input.failure_code) === "implementation_blocker") {
    return "运行时能力异常，需要查看诊断日志";
  }

  switch (input.failure_code) {
    case "resource_not_found":
      return input.target === "iron_ore"
        ? "可尝试 deepslate_iron_ore 或汇报附近无矿"
        : "可换资源目标、换位置或汇报附近无资源";
    case "missing_materials":
      return input.action === "craft" ? "先补齐缺少材料再合成" : "先补齐缺少材料";
    case "not_equipped":
      return "先调用 equip 或 ensure 工具链准备所需工具";
    case "missing_crafting_table":
    case "crafting_table_unavailable":
      return "先确保可用工作台";
    case "inventory_full":
      return "先整理背包或丢弃低价值物品";
    case "unsafe_path":
    case "unreachable_target":
      return "换安全路线或选择其他目标";
    case "drop_not_obtained":
      return "检查掉落与捡拾结果后换目标重试";
    default:
      return "查看 diagnostics（诊断） 后决定是否换策略";
  }
}

function freezeFailureCapsule(input: FailureCapsule): FailureCapsule {
  assertNonEmptyString(input.goal, "failure_capsule.goal");
  assertNonEmptyString(input.failed_action, "failure_capsule.failed_action");
  assertNonEmptyString(input.failure_code, "failure_capsule.failure_code");
  assertNonEmptyString(input.progress, "failure_capsule.progress");
  assertNonEmptyString(input.retry_guard, "failure_capsule.retry_guard");
  assertNonEmptyString(input.hint, "failure_capsule.hint");

  return Object.freeze({
    goal: input.goal,
    failed_action: input.failed_action,
    failure_code: input.failure_code,
    progress: input.progress,
    retry_guard: input.retry_guard,
    hint: input.hint,
  });
}

function freezeFailureSummary(input: SkillFailureSummary): SkillFailureSummary {
  assertNonEmptyString(input.failure_code, "failure.failure_code");
  assertNonEmptyString(input.failure_stage, "failure.failure_stage");
  assertNonEmptyString(input.message, "failure.message");

  return Object.freeze({
    failure_code: input.failure_code,
    failure_stage: input.failure_stage,
    message: input.message,
    recoverable: input.recoverable,
    ...(input.current_position === undefined
      ? {}
      : {
          current_position:
            input.current_position === null
              ? null
              : Object.freeze({
                  x: input.current_position.x,
                  y: input.current_position.y,
                  z: input.current_position.z,
                }),
        }),
    ...(input.inventory_summary === undefined
      ? {}
      : {
          inventory_summary:
            input.inventory_summary === null ? null : Object.freeze({ ...input.inventory_summary }),
        }),
    ...(input.equipment_summary === undefined
      ? {}
      : {
          equipment_summary:
            input.equipment_summary === null ? null : Object.freeze({ ...input.equipment_summary }),
        }),
    ...(input.target_progress === undefined
      ? {}
      : {
          target_progress:
            input.target_progress === null
              ? null
              : Object.freeze({
                  ...(input.target_progress.action === undefined
                    ? {}
                    : { action: input.target_progress.action }),
                  ...(input.target_progress.target === undefined
                    ? {}
                    : { target: input.target_progress.target }),
                  ...(input.target_progress.requested_count === undefined
                    ? {}
                    : { requested_count: input.target_progress.requested_count }),
                  ...(input.target_progress.completed_count === undefined
                    ? {}
                    : { completed_count: input.target_progress.completed_count }),
                  ...(input.target_progress.target_count === undefined
                    ? {}
                    : { target_count: input.target_progress.target_count }),
                }),
        }),
  });
}
