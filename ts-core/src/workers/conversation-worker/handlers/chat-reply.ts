import { createConversationReply } from "../../../conversation/chat.js";
import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import { ConversationLlmChatError } from "../../../conversation/llm.js";
import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import type { MessageTriage } from "../../../core-ports/foundation.js";
import type { BotActorStateProjection } from "../../../core-ports/runtime.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import { appendLlmDiagnosticEvent } from "../events.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  createConversationStateContextFromProjection,
  normalizeGeneratedReply,
  normalizeMemoryContext,
} from "../helpers.js";
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
    });
    const memoryContext = await readMemoryContext(input);
    const generatedReply = normalizeGeneratedReply(
      (await input.dependencies.replyGenerator?.({
        task: input.task,
        triage: input.triage,
        route: input.route,
        ...(stateContext === undefined ? {} : { state_context: stateContext }),
        ...(recentContext === undefined ? {} : { recent_context: recentContext }),
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
      })) ?? `收到：${input.task.message.content}`,
    );
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
        ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
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
  } catch (error) {
    if (error instanceof ConversationLlmChatError) {
      appendLlmDiagnosticEvent(input.events, input.task.bot_id, error.diagnostics);
    }
    throw error;
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
    readonly memory_context?: string;
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
