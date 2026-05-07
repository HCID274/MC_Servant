import { renderConversationBrainContext } from "../../../conversation/brain-context.js";
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
import { type FailureCapsule, classifyFailureCode } from "../../../core-ports/task-result.js";
import { type ExecJob, TaskHistoryStatus } from "../../../core-ports/tasking.js";
import { createProductionMetricEventJsonlLine } from "../../../diagnostics/index.js";
import { type ConversationWorkerTask, createBotWorkerTask } from "../../contracts.js";
import { tryEnqueueConversationFactCandidate } from "../brain-facts.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  createPlanningFailureReply,
  createSkillNotEnabledReply,
  normalizeMemoryContext,
  toBullmqPriority,
} from "../helpers.js";
import { createPlanPromptSnapshotContext } from "../shared-context.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";

/** 处理 plan_exec（规划执行） 路由。 */
export async function handlePlanExecRoute(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
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
  let brainContext: string | undefined;
  let recentContext: string | undefined;
  let continuationFailureCapsule: FailureCapsule | null = null;
  let inventoryChangeContext: string | undefined;
  let ownerPositionAtMessage = input.task.message.owner_position_at_message;
  try {
    const recentContextInfo = await readRecentContextInfo(input);
    const continuation = createContinuationDecision({
      message: input.task.message.content,
      failure_capsule: recentContextInfo.failure_capsule,
    });
    continuationFailureCapsule =
      continuation.kind === "none" ? null : recentContextInfo.failure_capsule;
    if (
      continuation.kind === "implementation_blocker" &&
      recentContextInfo.failure_capsule !== null
    ) {
      await pushPlanningFailure(
        input,
        "implementation_blocker",
        `上次失败是实现阻塞：${recentContextInfo.failure_capsule.failure_code}，${recentContextInfo.failure_capsule.hint}，已停止喵~`,
        {
          failure_capsule: recentContextInfo.failure_capsule,
        },
      );
      return;
    }
    recentContext = recentContextInfo.recent_context;
    memoryContext = await readMemoryContext(input);
    brainContext = await readBrainContext(input);
    resourceContext = await readResourceContext(input);
    const promptContext = await createPlanPromptSnapshotContext({
      task: input.task,
      dependencies: input.dependencies,
      ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
    });
    inventoryChangeContext = promptContext.inventory_change_context;
    ownerPositionAtMessage ??= promptContext.owner_position_at_message;
    const planSearchTool =
      input.route.needs_memory_search === true ? input.dependencies.brainSearchTool : undefined;

    try {
      plan = await input.dependencies.planner({
        task: input.task,
        triage: input.route.triage,
        route: input.route,
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
        ...(brainContext === undefined ? {} : { brain_context: brainContext }),
        ...(planSearchTool === undefined ? {} : { search_tool: planSearchTool }),
        ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
        ...(promptContext.snapshot_context === undefined
          ? {}
          : { snapshot_context: promptContext.snapshot_context }),
        ...(inventoryChangeContext === undefined
          ? {}
          : { inventory_change_context: inventoryChangeContext }),
      });
    } finally {
      promptContext.advanceInventoryBaseline();
    }
  } catch (error) {
    if (isConversationLlmSkillNotEnabledError(error)) {
      await pushPlanningFailure(input, "skill_not_enabled", createSkillNotEnabledReply().reply, {
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
        ...(brainContext === undefined ? {} : { brain_context: brainContext }),
        ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
        ...(inventoryChangeContext === undefined
          ? {}
          : { inventory_change_context: inventoryChangeContext }),
        ...(error.diagnostics === undefined ? {} : { llm_diagnostics: error.diagnostics }),
      });
      return;
    }
    const diagnostics = getPlanErrorDiagnostics(error);
    await pushPlanningFailure(input, "planner_failed", plannerFailureReply.reply, {
      ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
      ...(brainContext === undefined ? {} : { brain_context: brainContext }),
      ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
      ...(inventoryChangeContext === undefined
        ? {}
        : { inventory_change_context: inventoryChangeContext }),
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

  const repeatedFailure = detectRepeatedFailurePlan({
    exec_job: execJob,
    failure_capsule: continuationFailureCapsule,
  });
  if (repeatedFailure !== null) {
    await pushPlanningFailure(
      input,
      "retry_guard_repeated",
      `上次这个动作已经失败：${repeatedFailure.retry_guard}，我不会原样重复，已停止喵~`,
      {
        failure_capsule: repeatedFailure,
        ...(plan.diagnostics === undefined ? {} : { llm_diagnostics: plan.diagnostics }),
      },
    );
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
        reason: input.route.triage.reason,
      },
    });
  }

  if (input.suppressPlanReply !== true) {
    input.dependencies.recentContextStore?.appendOwnerMessage({
      message_id: input.task.message.message_id,
      text: input.task.message.content,
    });
  }
  input.dependencies.recentContextStore?.appendSandboxCode({
    message_id: input.task.message.message_id,
    code: execJob.code,
  });

  const botTask = createBotWorkerTask({
    bot_id: input.task.bot_id,
    exec_job: execJob,
    owner_text: input.task.message.content,
    ...(ownerPositionAtMessage === undefined
      ? {}
      : { owner_position_at_message: ownerPositionAtMessage }),
  });
  await input.dependencies.enqueueExecTaskSink({
    task: botTask,
    priority: toBullmqPriority(execJob.priority),
  });
  await emitPlanAcceptedMetric({
    input,
    task_id: execJob.message_id,
  });
  input.events.push(
    Object.freeze({
      type: "task.accepted",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      exec_type: execJob.type,
      priority: execJob.priority,
    }),
  );
  await tryEnqueueConversationFactCandidate({
    task: input.task,
    dependencies: input.dependencies,
    events: input.events,
    route_kind: "plan_exec",
    ...(ownerPositionAtMessage === undefined
      ? {}
      : { owner_position_at_message: ownerPositionAtMessage }),
  });
}

async function readRecentContextInfo(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<{
  readonly recent_context?: string;
  readonly failure_capsule: FailureCapsule | null;
}> {
  try {
    const projection = await input.dependencies.actorStateProjectionProvider?.({
      task: input.task,
    });
    const failureCapsule = input.dependencies.recentContextStore?.getLatestFailureCapsule() ?? null;
    const continuation = createContinuationDecision({
      message: input.task.message.content,
      failure_capsule: failureCapsule,
    });
    const recentContext = input.dependencies.recentContextStore?.render({
      ...(projection?.recent_events === undefined
        ? {}
        : { actorRecentEvents: projection.recent_events }),
      currentMessageId: input.task.message.message_id,
      roundLimit: 5,
      latestFailureCapsuleOnly: continuation.kind !== "none",
    });

    return Object.freeze({
      ...(recentContext === undefined ? {} : { recent_context: recentContext }),
      failure_capsule: failureCapsule,
    });
  } catch {
    return Object.freeze({ failure_capsule: null });
  }
}

async function readBrainContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  try {
    const context = await input.dependencies.brainContextProvider?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      include_skill: true,
    });

    return renderConversationBrainContext({
      ...(context === null || context === undefined ? {} : { context }),
      includeSkill: true,
    });
  } catch {
    return undefined;
  }
}

/** 按规划类 route（路由） 读取 ResourceService（世界感知资源服务） 摘要；provider（提供器） 失败时降级为空上下文。 */
async function readResourceContext(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
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
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
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

function createContinuationDecision(input: {
  readonly message: string;
  readonly failure_capsule: FailureCapsule | null;
}): { readonly kind: "none" | "recoverable" | "implementation_blocker" | "unknown" } {
  if (input.failure_capsule === null || !isContinuationMessage(input.message)) {
    return Object.freeze({ kind: "none" });
  }

  const failureClass = classifyFailureCode(input.failure_capsule.failure_code);
  if (failureClass === "implementation_blocker") {
    return Object.freeze({ kind: "implementation_blocker" });
  }
  if (failureClass === "recoverable") {
    return Object.freeze({ kind: "recoverable" });
  }

  return Object.freeze({ kind: "unknown" });
}

function isContinuationMessage(message: string): boolean {
  const normalized = message.toLowerCase().split(" ").join("").trim();
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }

  return CONTINUATION_PHRASES.some((phrase) => normalized.includes(phrase));
}

const CONTINUATION_PHRASES = Object.freeze([
  "继续",
  "再试试",
  "想办法",
  "换个办法",
  "你自己解决",
  "继续做",
  "为什么失败了继续做",
] as const);

function detectRepeatedFailurePlan(input: {
  readonly exec_job: ExecJob;
  readonly failure_capsule: FailureCapsule | null;
}): FailureCapsule | null {
  if (input.failure_capsule === null) {
    return null;
  }

  const retrySignature = readRetrySignature(input.failure_capsule.retry_guard);
  if (retrySignature === null) {
    return null;
  }

  return input.exec_job.code.includes(retrySignature) ? input.failure_capsule : null;
}

function readRetrySignature(retryGuard: string): string | null {
  const prefix = "不要原样重复 ";
  return retryGuard.startsWith(prefix) ? retryGuard.slice(prefix.length).trim() : null;
}

/** 记录规划失败并广播模板回复。 */
async function pushPlanningFailure(
  input: {
    readonly task: ConversationWorkerTask;
    readonly route?: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
    readonly events: ConversationWorkerRuntimeEvent[];
  },
  reason:
    | "planner_unavailable"
    | "planner_failed"
    | "skill_not_enabled"
    | "implementation_blocker"
    | "retry_guard_repeated",
  reply: string,
  contexts: {
    readonly memory_context?: string;
    readonly brain_context?: string;
    readonly resource_context?: string;
    readonly recent_context?: string;
    readonly inventory_change_context?: string;
    readonly llm_diagnostics?: ConversationLlmDiagnosticRecord;
    readonly failure_capsule?: FailureCapsule;
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
  await emitPlanDiscardedMetric({ input, reason });
}

async function emitPlanAcceptedMetric(input: {
  readonly input: {
    readonly task: ConversationWorkerTask;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
  };
  readonly task_id: string;
}): Promise<void> {
  try {
    await input.input.dependencies.productionMetricSink?.(
      createProductionMetricEventJsonlLine({
        event_type: "conversation.plan_accepted",
        message_id: input.input.task.message.message_id,
        task_id: input.task_id,
        bot_id: input.input.task.bot_id,
        root_goal_id: null,
        recovery_chain_id: null,
        created_at: new Date().toISOString(),
        source: "conversation_worker",
        prompt_version: null,
        model: null,
        stage: "plan",
        ok: true,
        error_code: null,
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
      }),
    );
  } catch {
    // 生产指标是旁路诊断，不能影响真实规划入队。
  }
}

async function emitPlanDiscardedMetric(input: {
  readonly input: {
    readonly task: ConversationWorkerTask;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
  };
  readonly reason:
    | "planner_unavailable"
    | "planner_failed"
    | "skill_not_enabled"
    | "implementation_blocker"
    | "retry_guard_repeated";
}): Promise<void> {
  try {
    await input.input.dependencies.productionMetricSink?.(
      createProductionMetricEventJsonlLine({
        event_type: "conversation.plan_discarded",
        message_id: input.input.task.message.message_id,
        task_id: null,
        bot_id: input.input.task.bot_id,
        root_goal_id: null,
        recovery_chain_id: null,
        created_at: new Date().toISOString(),
        source: "conversation_worker",
        prompt_version: null,
        model: null,
        stage: "plan",
        ok: false,
        error_code: input.reason,
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
      }),
    );
  } catch {
    // 生产指标是旁路诊断，不能影响真实回复。
  }
}

async function appendConversationReplyLog(input: {
  readonly task: ConversationWorkerTask;
  readonly route?: Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;
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
