/**
 * BotWorker（机器人工作线程） 执行结果到 TaskResultSummary（任务结果摘要）的纯转换。
 */

import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import { ExecutionTaskKind } from "../core-ports/foundation.js";
import type { RuntimeSandboxExecutionResult } from "../core-ports/sandbox.js";
import type { SkillExecutionResult } from "../core-ports/skills.js";
import {
  type TaskResultInventoryDelta,
  type TaskResultSummary,
  createTaskResultSummary,
} from "../core-ports/task-result.js";
import type { ExecJob, SandboxCodeJob, SkillCallJob } from "../core-ports/tasking.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";

/** 从 skill（技能） 执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromSkillResult(
  job: SkillCallJob,
  result: SkillExecutionResult,
): TaskResultSummary {
  switch (result.skill) {
    case "goTo":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SkillCall,
        operation: result.skill,
        target: `${result.target.x},${result.target.y},${result.target.z}`,
        completed_count: 1,
      });
    case "mine": {
      const inventoryDelta = createInventoryDelta(
        result.collected_item_name,
        result.collected_count,
      );
      const requestedCount = job.skill === "mine" ? job.params.count : undefined;
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SkillCall,
        operation: result.skill,
        target: result.block_name,
        ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
        completed_count: result.collected_count,
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        world_key: result.world_key,
        details: { mined_count: result.mined_count },
      });
    }
    case "cutTree": {
      const itemName = result.clusters.find(
        (cluster) => cluster.collected_count > 0,
      )?.log_block_name;
      const inventoryDelta = createInventoryDelta(itemName ?? "logs", result.collected_count);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SkillCall,
        operation: result.skill,
        target: itemName ?? result.clusters[0]?.log_block_name ?? "logs",
        requested_count: result.requested_count,
        completed_count: result.collected_count,
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        world_key: result.world_key,
        details: {
          cluster_count: result.clusters.length,
          status: result.status,
        },
      });
    }
    case "collect":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SkillCall,
        operation: result.skill,
        target: result.item_name ?? "all_items",
        completed_count: result.collected.reduce((sum, item) => sum + item.count, 0),
        inventory_delta: result.collected.map((item) => ({
          item_name: item.name,
          count: item.count,
        })),
        details: { skipped_count: result.skipped.length },
      });
    case "equip":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SkillCall,
        operation: result.skill,
        target: result.item_name,
        completed_count: 1,
        details: {
          destination: result.destination,
          status: result.status,
        },
      });
  }
}

/** 从 sandbox（沙箱） 执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromSandboxResult(
  job: SandboxCodeJob,
  result: RuntimeSandboxExecutionResult,
): TaskResultSummary {
  if (result.status !== TaskHistoryStatus.Completed) {
    return createSandboxTerminalResultSummary(job, result);
  }

  const lastStep = [...result.step_results].reverse().find((step) => step.status === "ok");
  const resultRecord = lastStep?.result;
  const toolchainData = readToolchainSuccessData(resultRecord);
  if (toolchainData !== null) {
    const target = toolchainData.item_name ?? toolchainData.block_name;
    const requestedCount = readRequestedCount(lastStep?.params);
    const inventoryDelta = createInventoryDelta(target ?? null, toolchainData.completed_count);
    return createTaskResultSummary({
      task_type: ExecutionTaskKind.SandboxCode,
      operation: lastStep?.action ?? "sandbox_code",
      ...(target === undefined ? {} : { target }),
      ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
      completed_count: toolchainData.completed_count,
      ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
      world_key: toolchainData.world_key,
      details: { total_steps: result.summary.total_steps },
    });
  }

  const skillResult = readSandboxSkillResult(resultRecord);
  if (skillResult !== null) {
    return skillResult;
  }

  return createTaskResultSummary({
    task_type: job.type,
    operation: lastStep?.action ?? "sandbox_code",
    completed_count: result.status === TaskHistoryStatus.Completed ? result.summary.total_steps : 0,
    details: { total_steps: result.summary.total_steps },
  });
}

function createSandboxTerminalResultSummary(
  job: SandboxCodeJob,
  result: RuntimeSandboxExecutionResult,
): TaskResultSummary {
  const failedStep = [...result.step_results].reverse().find((step) => step.status !== "ok");
  const errorRecord = "error" in result ? asRecord(result.error) : null;
  const stepErrorRecord = asRecord(failedStep?.error);
  const details = asRecord(errorRecord?.details) ?? asRecord(stepErrorRecord?.details);
  const targetProgress = asRecord(details?.target_progress);
  const failedParams = asRecord(failedStep?.params);
  const operation =
    readOptionalString(failedStep?.action) ??
    readOptionalString(errorRecord?.method) ??
    readOptionalString(details?.failure_stage) ??
    "sandbox_code";
  const target =
    readOptionalString(failedParams?.itemName) ??
    readOptionalString(failedParams?.blockName) ??
    readOptionalString(targetProgress?.target) ??
    readOptionalString(details?.target_item_name) ??
    readOptionalString(details?.item_name) ??
    readOptionalString(details?.block_name);
  const requestedCount =
    readRequestedCount(failedParams) ??
    readNumber(targetProgress?.requested_count) ??
    readNumber(details?.target_count);
  const worldKey = readOptionalString(details?.world_key);

  return createTaskResultSummary({
    task_type: job.type,
    operation,
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    completed_count: 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    details: {
      ...(details ?? {}),
      total_steps: result.summary.total_steps,
    },
  });
}

/** 从执行异常创建失败任务结果摘要。 */
export function createTaskFailureResultSummary(
  job: ExecJob,
  error: TaskFailedErrorSnapshot,
): TaskResultSummary {
  const details = error.details ?? {};
  const target = job.type === ExecutionTaskKind.SkillCall ? readSkillTarget(job) : undefined;
  const requestedCount =
    job.type === ExecutionTaskKind.SkillCall ? readSkillRequestedCount(job) : undefined;
  const worldKey = readOptionalString(details.world_key);
  return createTaskResultSummary({
    task_type: job.type,
    operation: job.type === ExecutionTaskKind.SkillCall ? job.skill : "sandbox_code",
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    completed_count: 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    details,
  });
}

function createInventoryDelta(
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

function readToolchainSuccessData(value: unknown): {
  readonly world_key: string | null;
  readonly completed_count: number;
  readonly item_name?: string;
  readonly block_name?: string;
} | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) {
    return null;
  }

  const data = value.data;
  return Object.freeze({
    world_key: typeof data.world_key === "string" ? data.world_key : null,
    completed_count: typeof data.completed_count === "number" ? data.completed_count : 1,
    ...(typeof data.item_name === "string" ? { item_name: data.item_name } : {}),
    ...(typeof data.block_name === "string" ? { block_name: data.block_name } : {}),
  });
}

function readSandboxSkillResult(value: unknown): TaskResultSummary | null {
  if (!isRecord(value) || typeof value.skill !== "string") {
    return null;
  }

  switch (value.skill) {
    case "mine": {
      const target = readOptionalString(value.block_name);
      const completedCount = readNumber(value.collected_count);
      const worldKey = readOptionalString(value.world_key);
      const inventoryDelta = createInventoryDelta(
        readOptionalString(value.collected_item_name),
        completedCount ?? 0,
      );
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "mine",
        ...(target === undefined ? {} : { target }),
        ...(completedCount === undefined ? {} : { completed_count: completedCount }),
        ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
        ...(worldKey === undefined ? {} : { world_key: worldKey }),
      });
    }
    case "collect": {
      const completedCount = readCollectedCount(value.collected);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "collect",
        target: readOptionalString(value.item_name) ?? "all_items",
        ...(completedCount === undefined ? {} : { completed_count: completedCount }),
      });
    }
    case "equip": {
      const target = readOptionalString(value.item_name);
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "equip",
        ...(target === undefined ? {} : { target }),
        completed_count: 1,
      });
    }
    case "goTo":
      return createTaskResultSummary({
        task_type: ExecutionTaskKind.SandboxCode,
        operation: "goTo",
        completed_count: 1,
      });
    default:
      return null;
  }
}

function readSkillTarget(job: SkillCallJob): string | undefined {
  switch (job.skill) {
    case "goTo":
      return `${job.params.x},${job.params.y},${job.params.z}`;
    case "mine":
      return job.params.blockName;
    case "collect":
      return job.params.itemName;
    case "equip":
      return job.params.itemName;
    case "cutTree":
      return "logs";
  }
}

function readSkillRequestedCount(job: SkillCallJob): number | undefined {
  switch (job.skill) {
    case "mine":
    case "cutTree":
      return job.params.count;
    default:
      return undefined;
  }
}

function readRequestedCount(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readNumber(value.count) ?? readNumber(value.requested_count);
}

function readCollectedCount(value: unknown): number | undefined {
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}
