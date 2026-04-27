import { createConversationReply } from "../../../conversation/chat.js";
import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import { ConversationLlmChatError } from "../../../conversation/llm.js";
import type { MessageTriage } from "../../../core-ports/foundation.js";
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
    const stateContext = await readStateContext(input);
    const memoryContext = await readMemoryContext(input);
    const generatedReply = normalizeGeneratedReply(
      (await input.dependencies.replyGenerator?.({
        task: input.task,
        triage: input.triage,
        route: input.route,
        ...(stateContext === undefined ? {} : { state_context: stateContext }),
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
async function readStateContext(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): Promise<string | undefined> {
  try {
    return createConversationStateContextFromProjection(
      await input.dependencies.actorStateProjectionProvider?.({
        task: input.task,
      }),
    );
  } catch {
    return undefined;
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
