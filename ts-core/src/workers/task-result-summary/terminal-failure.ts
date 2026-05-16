import type { TaskFailedErrorSnapshot } from "../../core-ports/events.js";
import type { RuntimeSandboxExecutionResult } from "../../core-ports/sandbox.js";
import {
  type TaskResultSummary,
  createTaskResultSummary,
  resolveFailureRecoverable,
} from "../../core-ports/task-result.js";
import { type CodeJob, type ExecJob, TaskHistoryStatus } from "../../core-ports/tasking.js";
import {
  type SummaryOptions,
  asRecord,
  createDurationField,
  createFailureSummary,
  readBoolean,
  readFailureCodeFromMessage,
  readNumber,
  readOptionalString,
  readRequestedCount,
  readTargetProgressCompletedCount,
} from "./summary-facts.js";

export function createSandboxTerminalResultSummary(
  job: CodeJob,
  result: RuntimeSandboxExecutionResult,
  options: SummaryOptions,
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
    "code";
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
  const failureCode =
    readOptionalString(errorRecord?.error_code) ??
    readOptionalString(stepErrorRecord?.error_code) ??
    "facade_call_failed";
  const failure = createFailureSummary({
    code: failureCode,
    stage: readOptionalString(details?.failure_stage) ?? operation,
    message:
      readOptionalString(errorRecord?.message) ??
      readOptionalString(stepErrorRecord?.message) ??
      "code terminal failure",
    recoverable:
      readBoolean(errorRecord?.recoverable) ??
      readBoolean(stepErrorRecord?.recoverable) ??
      resolveFailureRecoverable(failureCode),
    details,
  });

  return createTaskResultSummary({
    task_type: job.type,
    operation,
    status: result.status === TaskHistoryStatus.Interrupted ? "interrupted" : "failed",
    ...(target === undefined ? {} : { target }),
    ...(requestedCount === undefined ? {} : { requested_count: requestedCount }),
    completed_count: readNumber(targetProgress?.completed_count) ?? 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...createDurationField(options),
    failure,
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
  options: SummaryOptions & { readonly status?: "failed" | "interrupted" } = {},
): TaskResultSummary {
  const details = createFailureDetailsForJob(job, error.details ?? {});
  const failureCode = error.error_code ?? readFailureCodeFromMessage(error.message);
  const worldKey = readOptionalString(details.world_key);
  return createTaskResultSummary({
    task_type: job.type,
    operation: "code",
    status: options.status ?? "failed",
    completed_count: readTargetProgressCompletedCount(details) ?? 0,
    ...(worldKey === undefined ? {} : { world_key: worldKey }),
    ...createDurationField(options),
    failure: createFailureSummary({
      code: failureCode,
      stage: readOptionalString(details.failure_stage) ?? "code",
      message: error.message,
      recoverable: readBoolean(details.recoverable) ?? resolveFailureRecoverable(failureCode),
      details,
    }),
    details,
  });
}

function createFailureDetailsForJob(
  job: ExecJob,
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  void job;
  return details;
}
