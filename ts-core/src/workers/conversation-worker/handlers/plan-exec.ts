import { createPlanningFailureReply } from "../helpers.js";
import {
  appendContextProviderDiagnosticEvents,
  readLatestFailureContext,
  readPlanningContext,
} from "../plan-exec/context.js";
import {
  createContinuationDecision,
  createImplementationBlockerRecoveryContext,
  createPlanRecoveryContext,
  detectRepeatedFailurePlan,
} from "../plan-exec/continuation.js";
import { dispatchPlannedExecution, pushPlanningFailure } from "../plan-exec/dispatch.js";
import { createPlannedExecJob } from "../plan-exec/job.js";
import { invokeConversationPlanner } from "../plan-exec/planner.js";
import type { PlanExecHandlerInput, PlanningContextSnapshot } from "../plan-exec/types.js";

/** 处理 plan_exec（规划执行） 路由。 */
export async function handlePlanExecRoute(input: PlanExecHandlerInput): Promise<void> {
  const plannerFailureReply = createPlanningFailureReply().reply;

  if (input.dependencies.planner === undefined) {
    await pushPlanningFailure(input, "planner_unavailable", plannerFailureReply, {});
    return;
  }

  const latestFailure = readLatestFailureContext(input);
  const continuation = createContinuationDecision({
    message: input.task.message.content,
    failure_capsule: latestFailure.recent_failure.failure_capsule,
  });
  const context = await readPlanningContext({
    task: input.task,
    route: input.route,
    dependencies: input.dependencies,
    latest_failure_capsule_only: continuation.kind !== "none",
    initial_diagnostics: latestFailure.diagnostics,
  });
  appendContextProviderDiagnosticEvents({
    events: input.events,
    diagnostics: context.provider_diagnostics,
  });

  if (
    continuation.kind === "implementation_blocker" &&
    latestFailure.recent_failure.failure_capsule !== null
  ) {
    const recoveryContext = createImplementationBlockerRecoveryContext({
      task: input.task,
      recent_failure: latestFailure.recent_failure,
    });
    await pushPlanningFailure(
      input,
      "implementation_blocker",
      `上次失败是实现阻塞：${latestFailure.recent_failure.failure_capsule.failure_code}，${latestFailure.recent_failure.failure_capsule.hint}，已停止喵~`,
      {
        ...createFailureLogContext(context),
        failure_capsule: latestFailure.recent_failure.failure_capsule,
        ...recoveryContext,
      },
    );
    return;
  }

  const planResult = await invokeConversationPlanner({
    request: input,
    context,
    planner_failure_reply: plannerFailureReply,
  });
  if (!planResult.ok) {
    await pushPlanningFailure(input, planResult.reason, planResult.reply, {
      ...createFailureLogContext(context),
      ...(planResult.diagnostics === undefined ? {} : { llm_diagnostics: planResult.diagnostics }),
    });
    return;
  }

  const recoveryContext = createPlanRecoveryContext({
    task: input.task,
    continuation,
    recent_failure: latestFailure.recent_failure,
  });
  const plannedJob = createPlannedExecJob({
    request: input,
    plan: planResult.plan,
    recovery_context: recoveryContext,
  });
  const repeatedFailure = detectRepeatedFailurePlan({
    exec_job: plannedJob.exec_job,
    failure_capsule:
      continuation.kind === "none" ? null : latestFailure.recent_failure.failure_capsule,
  });
  if (repeatedFailure !== null) {
    await pushPlanningFailure(
      input,
      "retry_guard_repeated",
      `上次这个动作已经失败：${repeatedFailure.retry_guard}，我不会原样重复，已停止喵~`,
      {
        failure_capsule: repeatedFailure,
        ...(recoveryContext === null
          ? {}
          : {
              recovery_chain_id: recoveryContext.recovery_chain_id,
              recovery_class: recoveryContext.recovery_class,
              replan_count: recoveryContext.replan_count,
            }),
        ...(planResult.plan.diagnostics === undefined
          ? {}
          : { llm_diagnostics: planResult.plan.diagnostics }),
      },
    );
    return;
  }

  await dispatchPlannedExecution({
    request: input,
    planned_job: plannedJob,
    context,
    recovery_context: recoveryContext,
  });
}

function createFailureLogContext(context: PlanningContextSnapshot) {
  return {
    ...(context.memory_context === undefined ? {} : { memory_context: context.memory_context }),
    ...(context.brain_context === undefined ? {} : { brain_context: context.brain_context }),
    ...(context.resource_context === undefined
      ? {}
      : { resource_context: context.resource_context }),
    ...(context.recent_context === undefined ? {} : { recent_context: context.recent_context }),
    ...(context.inventory_change_context === undefined
      ? {}
      : { inventory_change_context: context.inventory_change_context }),
  };
}
