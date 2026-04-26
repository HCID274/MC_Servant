import { createConversationReply } from "../../../conversation/chat.js";
import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import { ConversationLlmChatError } from "../../../conversation/llm.js";
import type { MessageTriage } from "../../../core-ports/foundation.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import { appendLlmDiagnosticEvent } from "../events.js";
import {
  createConversationStateContextFromProjection,
  normalizeGeneratedReply,
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
    const generatedReply = normalizeGeneratedReply(
      (await input.dependencies.replyGenerator?.({
        task: input.task,
        triage: input.triage,
        route: input.route,
        ...(stateContext === undefined ? {} : { state_context: stateContext }),
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
