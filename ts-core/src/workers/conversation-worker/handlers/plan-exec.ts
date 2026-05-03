import { createConversationReply } from "../../../conversation/chat.js";
import type {
  ConversationPlanDraft,
  ConversationRouteDecision,
} from "../../../conversation/contracts.js";
import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import {
  ConversationLlmPlanError,
  isConversationLlmSkillNotEnabledError,
} from "../../../conversation/llm/errors.js";
import { createExecJobFromPlan } from "../../../conversation/planning.js";
import { ExecutionTaskKind } from "../../../core-ports/foundation.js";
import { SKILL_DIRECTORY } from "../../../core-ports/skills.js";
import { TaskHistoryStatus } from "../../../core-ports/tasking.js";
import { type ConversationWorkerTask, createBotWorkerTask } from "../../contracts.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  createPlanningFailureReply,
  createSkillNotEnabledReply,
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
    await pushPlanningFailure(input, "planner_unavailable", plannerFailureReply.reply, {});
    return;
  }

  let plan: ConversationPlanDraft & { readonly diagnostics?: ConversationLlmDiagnosticRecord };
  let memoryContext: string | undefined;
  let resourceContext: string | undefined;
  let recentContext: string | undefined;
  try {
    recentContext = await readRecentContext(input);
    memoryContext = await readMemoryContext(input);
    resourceContext = await readResourceContext(input);
    plan = await input.dependencies.planner({
      task: input.task,
      triage: input.route.triage,
      route: input.route,
      ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
      ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
    });
  } catch (error) {
    if (isConversationLlmSkillNotEnabledError(error)) {
      await pushPlanningFailure(input, "skill_not_enabled", createSkillNotEnabledReply().reply, {
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
        ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
        ...(error.diagnostics === undefined ? {} : { llm_diagnostics: error.diagnostics }),
      });
      return;
    }

    const diagnostics = getPlanErrorDiagnostics(error);
    await pushPlanningFailure(input, "planner_failed", plannerFailureReply.reply, {
      ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
      ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
      ...(diagnostics === undefined ? {} : { llm_diagnostics: diagnostics }),
    });
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

  if (
    execJob.type === ExecutionTaskKind.SkillCall &&
    execJob.skill !== SKILL_DIRECTORY.goTo &&
    execJob.skill !== SKILL_DIRECTORY.collect
  ) {
    await pushPlanningFailure(input, "skill_not_enabled", createSkillNotEnabledReply().reply, {
      ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
      ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
      ...(plan.diagnostics === undefined ? {} : { llm_diagnostics: plan.diagnostics }),
    });
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
    await appendConversationReplyLog({
      task: input.task,
      route: input.route,
      dependencies: input.dependencies,
      reply_mode: reply.mode,
      reply: reply.reply,
      contexts: {
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
        ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
      },
      ...(plan.diagnostics === undefined ? {} : { llm_diagnostics: plan.diagnostics }),
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

  if (input.suppressPlanReply !== true) {
    input.dependencies.recentContextStore?.appendOwnerMessage({
      message_id: input.task.message.message_id,
      text: input.task.message.content,
    });
    input.dependencies.recentContextStore?.appendBotReply({
      message_id: input.task.message.message_id,
      text: plan.reply,
    });
  }
  if (execJob.type === ExecutionTaskKind.SandboxCode) {
    input.dependencies.recentContextStore?.appendSandboxCode({
      message_id: input.task.message.message_id,
      code: execJob.code,
    });
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
      ...(execJob.type === ExecutionTaskKind.SkillCall ? { skill: execJob.skill } : {}),
      ...(execJob.type === ExecutionTaskKind.SandboxCode ? { exec_type: execJob.type } : {}),
      priority: execJob.priority,
    }),
  );
}

async function readRecentContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  try {
    const projection = await input.dependencies.actorStateProjectionProvider?.({
      task: input.task,
    });

    return input.dependencies.recentContextStore?.render({
      ...(projection?.recent_events === undefined
        ? {}
        : { actorRecentEvents: projection.recent_events }),
      currentMessageId: input.task.message.message_id,
    });
  } catch {
    return undefined;
  }
}

/** 按规划类 route（路由） 读取 ResourceService（世界感知资源服务） 摘要；provider（提供器） 失败时降级为空上下文。 */
async function readResourceContext(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  if (input.dependencies.resourceContextProvider === undefined) {
    return undefined;
  }

  try {
    const context = await input.dependencies.resourceContextProvider({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      message_content: input.task.message.content,
      route_kind: input.route.kind,
    });

    return normalizeMemoryContext(context);
  } catch {
    return undefined;
  }
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
    readonly route?: Extract<
      ConversationRouteDecision,
      { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
    >;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
    readonly events: ConversationWorkerRuntimeEvent[];
  },
  reason: "planner_unavailable" | "planner_failed" | "skill_not_enabled",
  reply: string,
  contexts: {
    readonly memory_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
    readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
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
      ...(contexts.resource_context === undefined
        ? {}
        : { resource_context: contexts.resource_context }),
      ...(contexts.recent_context === undefined ? {} : { recent_context: contexts.recent_context }),
    },
    ...(contexts.llm_diagnostics === undefined
      ? {}
      : { llm_diagnostics: contexts.llm_diagnostics }),
    ...(input.route === undefined ? {} : { route: input.route }),
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

async function appendConversationReplyLog(input: {
  readonly task: ConversationWorkerTask;
  readonly route?: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly reply_mode: "llm" | "template";
  readonly reply: string;
  readonly contexts: {
    readonly memory_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
  };
  readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
}): Promise<void> {
  try {
    await input.dependencies.conversationReplyLogSink?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      created_at: new Date().toISOString(),
      owner_message: input.task.message.content,
      route_kind: input.route?.kind ?? "plan_exec",
      reply_mode: input.reply_mode,
      reply: input.reply,
      ...(input.route === undefined ? {} : { triage: input.route.triage }),
      contexts: input.contexts,
      ...(input.llm_diagnostics === undefined ? {} : { llm_diagnostics: input.llm_diagnostics }),
    });
  } catch {
    // conversation（对话）本地日志是旁路诊断，不能阻断实服回复。
  }
}

function getPlanErrorDiagnostics(error: unknown): ConversationLlmDiagnosticRecord | undefined {
  return error instanceof ConversationLlmPlanError ? error.diagnostics : undefined;
}
