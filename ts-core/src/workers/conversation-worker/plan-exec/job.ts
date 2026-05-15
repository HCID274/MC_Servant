import { createExecJobFromPlan } from "../../../conversation/planning.js";
import { createBotWorkerTask } from "../../contracts.js";
import { toBullmqPriority } from "../helpers.js";
import type {
  PlanExecHandlerInput,
  PlanRecoveryContext,
  PlanWithDiagnostics,
  PlannedExecJob,
  PlanningContextSnapshot,
} from "./types.js";

export function createPlannedExecJob(input: {
  readonly request: PlanExecHandlerInput;
  readonly plan: PlanWithDiagnostics;
  readonly recovery_context: PlanRecoveryContext | null;
}): PlannedExecJob {
  const execJob = createExecJobFromPlan({
    plan: input.plan,
    message_id: input.request.task.message.message_id,
    intent_epoch: input.request.task.message.intent_epoch,
    snapshot_ts: input.request.task.message.snapshot_ts,
    priority: input.request.route.exec_priority,
    ...(input.recovery_context === null
      ? {}
      : {
          recovery_chain_id: input.recovery_context.recovery_chain_id,
          replan_count: input.recovery_context.replan_count,
        }),
  });

  return Object.freeze({ plan: input.plan, exec_job: execJob });
}

export async function enqueuePlannedExecJob(input: {
  readonly request: PlanExecHandlerInput;
  readonly planned_job: PlannedExecJob;
  readonly context: PlanningContextSnapshot;
}): Promise<void> {
  if (input.request.dependencies.enqueueExecTaskSink === undefined) {
    throw new Error("planning route requires enqueueExecTaskSink");
  }

  const ownerPositionAtMessage =
    input.request.task.message.owner_position_at_message ?? input.context.owner_position_at_message;
  const botTask = createBotWorkerTask({
    bot_id: input.request.task.bot_id,
    exec_job: input.planned_job.exec_job,
    owner_text: input.request.task.message.content,
    ...(ownerPositionAtMessage === undefined
      ? {}
      : { owner_position_at_message: ownerPositionAtMessage }),
  });
  await input.request.dependencies.enqueueExecTaskSink({
    task: botTask,
    priority: toBullmqPriority(input.planned_job.exec_job.priority),
  });
}
