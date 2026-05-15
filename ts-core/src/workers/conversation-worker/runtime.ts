import { renderConversationBrainContext } from "../../conversation/brain-context.js";
import { createCancelTemplateReply, createConversationReply } from "../../conversation/chat.js";
import type { ConversationCompositeTriage } from "../../conversation/contracts.js";
import { createConversationInventoryDiffCache } from "../../conversation/inventory-diff-cache.js";
import { createConversationRecentContextStore } from "../../conversation/recent-context.js";
import {
  createConversationRouteDecision,
  createMessageTriage,
  normalizeConversationCompositeTriageForMessage,
} from "../../conversation/triage.js";
import { ConversationPriority } from "../../core-ports/foundation.js";
import type { InterruptSignal } from "../../core-ports/runtime.js";
import { handleCancelInterruptRoute } from "./handlers/cancel-interrupt.js";
import { handleChatReplyRoute } from "./handlers/chat-reply.js";
import { handlePlanExecRoute } from "./handlers/plan-exec.js";
import {
  cloneWorkerTask,
  createDefaultConversationWorker,
  createDefaultTriage,
} from "./helpers.js";
import type {
  ConversationBullmqWorkerLike,
  ConversationWorkerRuntime,
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
  ConversationWorkerRuntimeQueue,
} from "./types.js";

export function createConversationWorkerRuntime(input: {
  /** 待消费的消息队列。 */
  readonly queue: ConversationWorkerRuntimeQueue;
  /** 运行时依赖注入。 */
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): ConversationWorkerRuntime {
  let worker: ConversationBullmqWorkerLike | null = null;
  const events: ConversationWorkerRuntimeEvent[] = [];
  const dependencies: ConversationWorkerRuntimeDependencies = Object.freeze({
    ...input.dependencies,
    recentContextStore:
      input.dependencies.recentContextStore ?? createConversationRecentContextStore(),
    inventoryDiffCache:
      input.dependencies.inventoryDiffCache ?? createConversationInventoryDiffCache(),
  });
  const createWorker = dependencies.createWorker ?? createDefaultConversationWorker;

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    const task = cloneWorkerTask(job.data);
    await dependencies.ownerMessageActivitySink?.({
      bot_id: task.bot_id,
      message_id: task.message.message_id,
      at: new Date(task.message.snapshot_ts),
    });
    const brainContext = await readBrainContext({
      task,
      dependencies,
      events,
      includeSkill: false,
    });
    const rawTriage = await (dependencies.triage?.({
      task,
      ...(brainContext === undefined ? {} : { brain_context: brainContext }),
    }) ?? createDefaultTriage());
    const triage = normalizeConversationCompositeTriageForMessage({
      triage: rawTriage,
      message: task.message.content,
    });
    await handleCompositeTriage({
      task,
      triage,
      dependencies,
      events,
    });
  };

  return Object.freeze({
    queue_name: input.queue.name,
    async start(): Promise<void> {
      if (worker !== null) {
        return;
      }

      worker = createWorker({
        queueName: input.queue.name,
        connection: input.queue.connection,
        processor: processTask,
      });
    },
    async close(): Promise<void> {
      const currentWorker = worker;
      worker = null;
      await currentWorker?.close();
    },
    getEvents(): readonly ConversationWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}

async function readBrainContext(input: {
  readonly task: ReturnType<typeof cloneWorkerTask>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
  readonly includeSkill: boolean;
}): Promise<string | undefined> {
  try {
    const context = await input.dependencies.brainContextProvider?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      include_skill: input.includeSkill,
    });

    return renderConversationBrainContext({
      ...(context === null || context === undefined ? {} : { context }),
      includeSkill: input.includeSkill,
    });
  } catch (error) {
    input.events.push(
      Object.freeze({
        type: "conversation.context_provider_failed",
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        route_kind: "triage",
        provider: "brain",
        error_summary: summarizeError(error),
      }),
    );
    return undefined;
  }
}

/** 按 cancel（取消）→chat（闲聊）→action（动作） 顺序派发复合分诊结果。 */
async function handleCompositeTriage(input: {
  readonly task: ReturnType<typeof cloneWorkerTask>;
  readonly triage: ConversationCompositeTriage;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
}): Promise<void> {
  let replyBroadcasted = false;

  if (input.triage.cancel !== undefined) {
    await interruptRuntime(input, {
      source: {
        type: "triage",
        intent_epoch: input.task.message.intent_epoch,
      },
      reason: input.triage.cancel.reason,
    });
    input.events.push(
      Object.freeze({
        type: "cancel.logged",
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        reason: input.triage.cancel.reason,
      }),
    );
  }

  if (input.triage.chat !== undefined) {
    await handleGeneratedCompositeChat(input);
    replyBroadcasted = true;
  } else if (input.triage.cancel !== undefined) {
    await broadcastCompositeReply(input, createCancelTemplateReply().reply, "template");
    replyBroadcasted = true;
  }

  if (input.triage.action !== undefined) {
    const actionTriage = createMessageTriage({
      intent: "task",
      priority: input.triage.action.priority,
      reason: input.triage.action.reason,
    });
    const route = createConversationRouteDecision({
      triage: actionTriage,
      message: input.task.message.content,
      has_active_task:
        input.triage.cancel === undefined && (input.dependencies.hasActiveTask?.() ?? false),
      needs_memory_search: input.triage.action.needs_memory_search === true,
    });

    if (route.kind !== "plan_exec") {
      throw new Error(`composite action produced unsupported route: ${route.kind}`);
    }

    await handlePlanExecRoute({
      task: input.task,
      route,
      dependencies: input.dependencies,
      events: input.events,
      suppressPlanReply: replyBroadcasted,
    });
  }
}

async function interruptRuntime(
  input: {
    readonly task: ReturnType<typeof cloneWorkerTask>;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
  },
  signal: InterruptSignal,
): Promise<void> {
  if (input.dependencies.interruptRuntimeSink === undefined) {
    throw new Error("composite cancel requires interruptRuntimeSink");
  }

  await input.dependencies.interruptRuntimeSink({
    bot_id: input.task.bot_id,
    signal,
  });
}

async function handleGeneratedCompositeChat(input: {
  readonly task: ReturnType<typeof cloneWorkerTask>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
}): Promise<void> {
  const triage = createMessageTriage({
    intent: "chat",
    priority: ConversationPriority.Normal,
    reason: "composite_chat",
  });
  const route = createConversationRouteDecision({
    triage,
    message: input.task.message.content,
    has_active_task: false,
  });

  if (route.kind !== "chat_reply") {
    throw new Error(`composite chat produced unsupported route: ${route.kind}`);
  }

  await handleChatReplyRoute({
    task: input.task,
    triage,
    route,
    dependencies: input.dependencies,
    events: input.events,
  });
}

async function broadcastCompositeReply(
  input: {
    readonly task: ReturnType<typeof cloneWorkerTask>;
    readonly dependencies: ConversationWorkerRuntimeDependencies;
    readonly events: ConversationWorkerRuntimeEvent[];
  },
  content: string,
  mode: "llm" | "template",
): Promise<void> {
  const reply =
    mode === "llm"
      ? createConversationReply({ mode: "llm", reply: content })
      : createConversationReply({ mode: "template", reply: content });

  await input.dependencies.broadcastReplySink({
    message_id: input.task.message.message_id,
    content: reply.reply,
  });
  input.dependencies.recentContextStore?.appendOwnerMessage({
    message_id: input.task.message.message_id,
    text: input.task.message.content,
  });
  input.dependencies.recentContextStore?.appendBotReply({
    message_id: input.task.message.message_id,
    text: reply.reply,
  });
  await appendConversationReplyLog({
    task: input.task,
    dependencies: input.dependencies,
    reply_mode: reply.mode,
    reply: reply.reply,
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

async function appendConversationReplyLog(input: {
  readonly task: ReturnType<typeof cloneWorkerTask>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly reply_mode: "llm" | "template";
  readonly reply: string;
}): Promise<void> {
  try {
    await input.dependencies.conversationReplyLogSink?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      created_at: new Date().toISOString(),
      owner_message: input.task.message.content,
      route_kind: "composite_chat",
      reply_mode: input.reply_mode,
      reply: input.reply,
      contexts: {},
    });
  } catch (error) {
    // conversation（对话）本地日志是旁路诊断，不能阻断实服回复；stderr 是最低可观测记录。
    console.warn("[conversation-worker] reply log sink failed", {
      route_kind: "composite_chat",
      message_id: input.task.message.message_id,
      error_summary: summarizeError(error),
    });
  }
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
