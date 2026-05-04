import { renderConversationBrainContext } from "../../../conversation/brain-context.js";
import { createConversationReply } from "../../../conversation/chat.js";
import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import { ConversationLlmChatError } from "../../../conversation/llm.js";
import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import type { MessageTriage } from "../../../core-ports/foundation.js";
import type { BotActorStateProjection } from "../../../core-ports/runtime.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import { tryEnqueueConversationFactCandidate } from "../brain-facts.js";
import { appendLlmDiagnosticEvent } from "../events.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  createConversationStateContextFromProjection,
  normalizeGeneratedReply,
  normalizeMemoryContext,
} from "../helpers.js";
import { createChatPromptSnapshotContext } from "../shared-context.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";

/** 处理 chat_reply（闲聊回复） 路由。 */
export async function handleChatReplyRoute(input: {
  readonly task: ConversationWorkerTask;
  readonly triage: MessageTriage;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "chat_reply" }>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
}): Promise<void> {
  try {
    const actorProjection = await readActorStateProjection(input);
    const stateContext = createConversationStateContextFromProjection(actorProjection);
    const recentContext = input.dependencies.recentContextStore?.render({
      ...(actorProjection?.recent_events === undefined
        ? {}
        : { actorRecentEvents: actorProjection.recent_events }),
      currentMessageId: input.task.message.message_id,
      roundLimit: 5,
    });
    const memoryContext = await readMemoryContext(input);
    const brainContext = await readBrainContext(input);
    const promptContext =
      input.dependencies.replyGenerator === undefined &&
      input.dependencies.enqueueBrainFactSink === undefined
        ? undefined
        : await createChatPromptSnapshotContext({
            task: input.task,
            dependencies: input.dependencies,
            ...(recentContext === undefined ? {} : { recent_context: recentContext }),
          });
    let generatedReply: ReturnType<typeof normalizeGeneratedReply>;
    try {
      generatedReply = normalizeGeneratedReply(
        (await input.dependencies.replyGenerator?.({
          task: input.task,
          triage: input.triage,
          route: input.route,
          ...(stateContext === undefined ? {} : { state_context: stateContext }),
          ...(recentContext === undefined ? {} : { recent_context: recentContext }),
          ...(promptContext?.snapshot_context === undefined
            ? {}
            : { snapshot_context: promptContext.snapshot_context }),
          ...(promptContext?.inventory_change_context === undefined
            ? {}
            : { inventory_change_context: promptContext.inventory_change_context }),
          ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
          ...(brainContext === undefined ? {} : { brain_context: brainContext }),
          ...(input.dependencies.brainSearchTool === undefined
            ? {}
            : { search_tool: input.dependencies.brainSearchTool }),
        })) ?? `收到：${input.task.message.content}`,
      );
    } finally {
      promptContext?.advanceInventoryBaseline();
    }
    if (generatedReply.diagnostics !== undefined) {
      appendLlmDiagnosticEvent(input.events, input.task.bot_id, generatedReply.diagnostics);
    }
    const reply =
      generatedReply.mode === "llm"
        ? createConversationReply({ mode: "llm", reply: generatedReply.reply })
        : createConversationReply({ mode: "template", reply: generatedReply.reply });

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
    const ownerPositionAtMessage =
      input.task.message.owner_position_at_message ?? promptContext?.owner_position_at_message;
    await appendConversationReplyLog({
      task: input.task,
      route: input.route,
      triage: input.triage,
      dependencies: input.dependencies,
      reply_mode: reply.mode,
      reply: reply.reply,
      contexts: {
        ...(stateContext === undefined ? {} : { state_context: stateContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
        ...(promptContext?.inventory_change_context === undefined
          ? {}
          : { inventory_change_context: promptContext.inventory_change_context }),
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
        ...(brainContext === undefined ? {} : { brain_context: brainContext }),
      },
      ...(generatedReply.diagnostics === undefined
        ? {}
        : { llm_diagnostics: generatedReply.diagnostics }),
    });
    input.events.push(
      Object.freeze({
        type: "chat.reply",
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        content: reply.reply,
      }),
    );
    await tryEnqueueConversationFactCandidate({
      task: input.task,
      dependencies: input.dependencies,
      events: input.events,
      route_kind: "chat_reply",
      bot_reply: reply.reply,
      ...(ownerPositionAtMessage === undefined
        ? {}
        : { owner_position_at_message: ownerPositionAtMessage }),
    });
  } catch (error) {
    if (error instanceof ConversationLlmChatError) {
      appendLlmDiagnosticEvent(input.events, input.task.bot_id, error.diagnostics);
    }
    throw error;
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
      include_skill: false,
    });

    return renderConversationBrainContext({
      ...(context === null || context === undefined ? {} : { context }),
      includeSkill: false,
    });
  } catch {
    return undefined;
  }
}

/** 读取 chat_reply（闲聊回复） 专用状态摘要；失败时降级为无状态闲聊。 */
async function readActorStateProjection(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<BotActorStateProjection | null | undefined> {
  try {
    return input.dependencies.actorStateProjectionProvider?.({
      task: input.task,
    });
  } catch {
    return undefined;
  }
}

async function appendConversationReplyLog(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "chat_reply" }>;
  readonly triage: MessageTriage;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly reply_mode: "llm" | "template";
  readonly reply: string;
  readonly contexts: {
    readonly state_context?: string;
    readonly recent_context?: string;
    readonly inventory_change_context?: string;
    readonly memory_context?: string;
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
      triage: input.triage,
      contexts: input.contexts,
      ...(input.llm_diagnostics === undefined ? {} : { llm_diagnostics: input.llm_diagnostics }),
    });
  } catch {
    // conversation（对话）本地日志是旁路诊断，不能阻断实服回复。
  }
}

/** 按 route（路由） 信号读取 chat（闲聊） memory（记忆）；失败时降级为空上下文。 */
async function readMemoryContext(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "chat_reply" }>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  if (!input.route.needs_memory_search || input.dependencies.memoryContextProvider === undefined) {
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
