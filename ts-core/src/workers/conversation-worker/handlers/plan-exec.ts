import { createConversationReply } from "../../../conversation/chat.js";
import type {
  ConversationPlanDraft,
  ConversationRouteDecision,
} from "../../../conversation/contracts.js";
import { createExecJobFromPlan } from "../../../conversation/planning.js";
import { TaskHistoryStatus } from "../../../core-ports/tasking.js";
import { type ConversationWorkerTask, createBotWorkerTask } from "../../contracts.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  createPlanningFailureReply,
  normalizeMemoryContext,
  toBullmqPriority,
} from "../helpers.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";

/** 处理 plan_exec（规划执行） 与 modify_interrupt_then_plan（修改后规划） 路由。 */
export async function handlePlanExecRoute(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
  readonly suppressPlanReply?: boolean;
}): Promise<void> {
  const plannerFailureReply = createPlanningFailureReply();

  if (input.dependencies.planner === undefined) {
    await pushPlanningFailure(input, "planner_unavailable", plannerFailureReply.reply);
    return;
  }

  let plan: ConversationPlanDraft;
  try {
    const memoryContext = await readMemoryContext(input);
    plan = await input.dependencies.planner({
      task: input.task,
      triage: input.route.triage,
      route: input.route,
      ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
    });
  } catch {
    await pushPlanningFailure(input, "planner_failed", plannerFailureReply.reply);
    return;
  }

  if (input.dependencies.enqueueExecTaskSink === undefined) {
    throw new Error("planning route requires enqueueExecTaskSink");
  }

  const execJob = createExecJobFromPlan({
    plan,
    message_id: input.task.message.message_id,
    intent_epoch: input.task.message.intent_epoch,
    snapshot_ts: input.task.message.snapshot_ts,
    priority: input.route.exec_priority,
  });

  if (execJob.type !== "skill_call") {
    await pushPlanningFailure(input, "planner_failed", plannerFailureReply.reply);
    return;
  }

  if (input.route.requires_interrupt) {
    if (input.dependencies.interruptRuntimeSink === undefined) {
      throw new Error("planning route requires interruptRuntimeSink");
    }

    await input.dependencies.interruptRuntimeSink({
      bot_id: input.task.bot_id,
      signal: {
        source: {
          type: "triage",
          intent_epoch: input.task.message.intent_epoch,
        },
        reason:
          input.route.kind === "modify_interrupt_then_plan" ? "modify" : input.route.triage.reason,
      },
    });
  }

  if (input.suppressPlanReply !== true) {
    const reply = createConversationReply({ mode: "llm", reply: plan.reply });
    await input.dependencies.broadcastReplySink({
      message_id: input.task.message.message_id,
      content: reply.reply,
    });
    input.events.push(
      Object.freeze({
        type: "chat.reply",
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        content: reply.reply,
      }),
    );
  }

  const botTask = createBotWorkerTask({
    bot_id: input.task.bot_id,
    exec_job: execJob,
  });
  await input.dependencies.enqueueExecTaskSink({
    task: botTask,
    priority: toBullmqPriority(execJob.priority),
  });
  input.events.push(
    Object.freeze({
      type: "task.accepted",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      skill: execJob.skill,
      priority: execJob.priority,
    }),
  );
}

/** 按规划类 route（路由） 读取 memory（记忆）；provider（提供器） 失败时降级为空上下文。 */
async function readMemoryContext(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  if (input.dependencies.memoryContextProvider === undefined) {
    return undefined;
  }

  try {
    return normalizeMemoryContext(
      await input.dependencies.memoryContextProvider({
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        intent_epoch: input.task.message.intent_epoch,
        message_content: input.task.message.content,
        route_kind: input.route.kind,
        query_reason: input.route.triage.reason,
        limit: CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
        char_budget: CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
      }),
    );
  } catch {
    return undefined;
  }
}

/** 记录规划失败并广播模板回复。 */
async function pushPlanningFailure(
  input: {
    readonly task: ConversationWorkerTask;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
    readonly events: ConversationWorkerRuntimeEvent[];
  },
  reason: "planner_unavailable" | "planner_failed",
  reply: string,
): Promise<void> {
  await input.dependencies.broadcastReplySink({
    message_id: input.task.message.message_id,
    content: reply,
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
}
