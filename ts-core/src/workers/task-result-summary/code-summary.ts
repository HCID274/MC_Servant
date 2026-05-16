import { ExecutionTaskKind } from "../../core-ports/foundation.js";
import type { RuntimeSandboxExecutionResult } from "../../core-ports/sandbox.js";
import { type TaskResultSummary, createTaskResultSummary } from "../../core-ports/task-result.js";
import { type CodeJob, TaskHistoryStatus } from "../../core-ports/tasking.js";
import { createTaskResultSummaryFromGoalResult, readReportedGoalResult } from "./goal-summary.js";
import { readSandboxSkillResult } from "./sandbox-skill-summary.js";
import {
  type SummaryOptions,
  createDurationField,
  createFailureSummary,
  createInventoryDelta,
  readRequestedCount,
  readToolchainSuccessData,
} from "./summary-facts.js";
import { createSandboxTerminalResultSummary } from "./terminal-failure.js";

/** 从 code（代码）执行结果创建任务结果摘要。 */
export function createTaskResultSummaryFromCodeResult(
  job: CodeJob,
  result: RuntimeSandboxExecutionResult,
  options: SummaryOptions = {},
): TaskResultSummary {
  const reportedGoal = readReportedGoalResult(result);
  if (reportedGoal !== null) {
    return createTaskResultSummaryFromGoalResult(job, reportedGoal, options);
  }

  if (result.status !== TaskHistoryStatus.Completed) {
    return createSandboxTerminalResultSummary(job, result, options);
  }

  const lastStep = [...result.step_results].reverse().find((step) => step.status === "ok");
  const resultRecord = lastStep?.result;
  const toolchainData = readToolchainSuccessData(resultRecord);
  if (toolchainData !== null) {
    const target = toolchainData.item_name ?? toolchainData.block_name;
    const requestedCount = readRequestedCount(lastStep?.params);
    const inventoryDelta = createInventoryDelta(target ?? null, toolchainData.completed_count);
    return createTaskResultSummary({
      task_type: ExecutionTaskKind.Code,
      operation: lastStep?.action ?? "code",
      ...(target === undefined ? {} : { target }),
      ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
      completed_count: toolchainData.completed_count,
      ...(inventoryDelta === undefined ? {} : { inventory_delta: inventoryDelta }),
      world_key: toolchainData.world_key,
      ...createDurationField(options),
      details: { total_steps: result.summary.total_steps },
    });
  }

  const skillResult = readSandboxSkillResult(resultRecord);
  if (skillResult !== null) {
    return createTaskResultSummary({
      ...skillResult,
      ...createDurationField(options),
    });
  }

  const operation = lastStep?.action ?? "code";
  const details = Object.freeze({
    code: "unknown_completion",
    reason: "completed sandbox result lacks report/toolchain/skill completion proof",
    operation,
    total_steps: result.summary.total_steps,
  });
  return createTaskResultSummary({
    task_type: job.type,
    operation,
    status: "failed",
    completed_count: 0,
    ...createDurationField(options),
    failure: createFailureSummary({
      code: "unknown_completion",
      stage: operation,
      message: "sandbox result lacks completion proof",
      recoverable: false,
      details,
    }),
    details,
  });
}

export const createTaskResultSummaryFromSandboxResult = createTaskResultSummaryFromCodeResult;
