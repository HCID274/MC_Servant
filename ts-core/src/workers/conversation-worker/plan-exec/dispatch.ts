import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import type { FailureCapsule } from "../../../core-ports/task-result.js";
import { TaskHistoryStatus } from "../../../core-ports/tasking.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import { tryEnqueueConversationFactCandidate } from "../brain-facts.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";
import { enqueuePlannedExecJob } from "./job.js";
import { emitPlanAcceptedMetric, emitPlanDiscardedMetric } from "./metrics.js";
import type {
  PlanExecHandlerInput,
  PlanRecoveryContext,
  PlannedExecJob,
  PlanningContextSnapshot,
  PlanningFailureReason,
} from "./types.js";

export async function dispatchPlannedExecution(input: {
  readonly request: PlanExecHandlerInput;
  readonly planned_job: PlannedExecJob;
  readonly context: PlanningContextSnapshot;
  readonly recovery_context: PlanRecoveryContext | null;
}): Promise<void> {
  if (input.request.route.requires_interrupt) {
    if (input.request.dependencies.interruptRuntimeSink === undefined) {
      throw new Error("planning route requires interruptRuntimeSink");
    }

    await input.request.dependencies.interruptRuntimeSink({
      bot_id: input.request.task.bot_id,
      signal: {
        source: {
          type: "triage",
          intent_epoch: input.request.task.message.intent_epoch,
        },
        reason: input.request.route.triage.reason,
      },
    });
  }

  if (input.request.suppressPlanReply !== true) {
    input.request.dependencies.recentContextStore?.appendOwnerMessage({
      message_id: input.request.task.message.message_id,
      text: input.request.task.message.content,
    });
  }
  input.request.dependencies.recentContextStore?.appendSandboxCode({
    message_id: input.request.task.message.message_id,
    code: input.planned_job.exec_job.code,
  });

  await enqueuePlannedExecJob({
    request: input.request,
    planned_job: input.planned_job,
    context: input.context,
  });

  await emitPlanAcceptedMetric({
    request: input.request,
    task_id: input.planned_job.exec_job.message_id,
    ...(input.recovery_context === null
      ? {}
      : {
          recovery_chain_id: input.recovery_context.recovery_chain_id,
          recovery_class: input.recovery_context.recovery_class,
          replan_count: input.recovery_context.replan_count,
        }),
  });
  input.request.events.push(
    Object.freeze({
      type: "task.accepted",
      bot_id: input.request.task.bot_id,
      message_id: input.request.task.message.message_id,
      exec_type: input.planned_job.exec_job.type,
      priority: input.planned_job.exec_job.priority,
    }),
  );

  const ownerPositionAtMessage =
    input.request.task.message.owner_position_at_message ?? input.context.owner_position_at_message;
  await tryEnqueueConversationFactCandidate({
    task: input.request.task,
    dependencies: input.request.dependencies,
    events: input.request.events,
    route_kind: "plan_exec",
    ...(ownerPositionAtMessage === undefined
      ? {}
      : { owner_position_at_message: ownerPositionAtMessage }),
  });
}

/** 记录规划失败并广播模板回复。 */
export async function pushPlanningFailure(
  input: Pick<PlanExecHandlerInput, "task" | "route" | "dependencies" | "events">,
  reason: PlanningFailureReason,
  reply: string,
  contexts: {
    readonly memory_context?: string;
    readonly brain_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
    readonly inventory_change_context?: string;
    readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
    readonly failure_capsule?: FailureCapsule;
    readonly recovery_chain_id?: string;
    readonly recovery_class?: "recoverable" | "implementation_blocker" | "unknown";
    readonly replan_count?: number;
  },
): Promise<void> {
  await input.dependencies.broadcastReplySink({
    message_id: input.task.message.message_id,
    content: reply,
  });
  input.dependencies.recentContextStore?.appendOwnerMessage({
    message_id: input.task.message.message_id,
    text: input.task.message.content,
  });
  input.dependencies.recentContextStore?.appendBotReply({
    message_id: input.task.message.message_id,
    text: reply,
  });
  await appendConversationReplyLog({
    task: input.task,
    dependencies: input.dependencies,
    reply_mode: "template",
    reply,
    contexts: {
      ...(contexts.memory_context === undefined ? {} : { memory_context: contexts.memory_context }),
      ...(contexts.brain_context === undefined ? {} : { brain_context: contexts.brain_context }),
      ...(contexts.resource_context === undefined
        ? {}
        : { resource_context: contexts.resource_context }),
      ...(contexts.recent_context === undefined ? {} : { recent_context: contexts.recent_context }),
      ...(contexts.inventory_change_context === undefined
        ? {}
        : { inventory_change_context: contexts.inventory_change_context }),
    },
    ...(contexts.llm_diagnostics === undefined
      ? {}
      : { llm_diagnostics: contexts.llm_diagnostics }),
    route: input.route,
  });
  input.events.push(
    Object.freeze({
      type: "chat.reply",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      content: reply,
    }),
  );
  input.events.push(
    Object.freeze({
      type: "task.discarded",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      status: TaskHistoryStatus.Discarded,
      reason,
    }),
  );
  await emitPlanDiscardedMetric({
    request: input,
    reason,
    ...(contexts.recovery_chain_id === undefined
      ? {}
      : { recovery_chain_id: contexts.recovery_chain_id }),
    ...(contexts.recovery_class === undefined ? {} : { recovery_class: contexts.recovery_class }),
    ...(contexts.replan_count === undefined ? {} : { replan_count: contexts.replan_count }),
  });
}

async function appendConversationReplyLog(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly reply_mode: "llm" | "template";
  readonly reply: string;
  readonly contexts: {
    readonly memory_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
    readonly inventory_change_context?: string;
    readonly brain_context?: string;
  };
  readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
}): Promise<void> {
  try {
    await input.dependencies.conversationReplyLogSink?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      created_at: new Date().toISOString(),
      owner_message: input.task.message.content,
      route_kind: input.route.kind,
      reply_mode: input.reply_mode,
      reply: input.reply,
      triage: input.route.triage,
      contexts: input.contexts,
      ...(input.llm_diagnostics === undefined ? {} : { llm_diagnostics: input.llm_diagnostics }),
    });
  } catch {
    // conversation（对话）本地日志是旁路诊断，不能阻断实服回复。
  }
}
