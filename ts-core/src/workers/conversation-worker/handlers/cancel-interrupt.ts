import { createCancelTemplateReply } from "../../../conversation/chat.js";
import type { ConversationRouteDecision } from "../../../conversation/contracts.js";
import { type ConversationWorkerTask, createConversationWorkerActions } from "../../contracts.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";

/** 处理 cancel_interrupt（取消中断） 路由。 */
export async function handleCancelInterruptRoute(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "cancel_interrupt" }>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
}): Promise<void> {
  for (const action of createConversationWorkerActions({
    bot_id: input.task.bot_id,
    route: input.route,
    intent_epoch: input.task.message.intent_epoch,
    reply: createCancelTemplateReply(),
  })) {
    switch (action.type) {
      case "interrupt_runtime":
        if (input.dependencies.interruptRuntimeSink === undefined) {
          throw new Error("cancel route requires interruptRuntimeSink");
        }

        await input.dependencies.interruptRuntimeSink({
          bot_id: action.bot_id,
          signal: action.signal,
        });
        break;
      case "broadcast_reply":
        await input.dependencies.broadcastReplySink({
          message_id: input.task.message.message_id,
          content: action.reply.reply,
        });
        input.dependencies.recentContextStore?.appendOwnerMessage({
          message_id: input.task.message.message_id,
          text: input.task.message.content,
        });
        input.dependencies.recentContextStore?.appendBotReply({
          message_id: input.task.message.message_id,
          text: action.reply.reply,
        });
        await appendConversationReplyLog({
          task: input.task,
          route: input.route,
          dependencies: input.dependencies,
          reply: action.reply.reply,
        });
        input.events.push(
          Object.freeze({
            type: "chat.reply",
            bot_id: input.task.bot_id,
            message_id: input.task.message.message_id,
            content: action.reply.reply,
          }),
        );
        break;
      default:
        throw new Error(`cancel route produced unsupported action: ${action.type}`);
    }
  }

  input.events.push(
    Object.freeze({
      type: "cancel.logged",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      reason: input.route.triage.reason,
    }),
  );
}

async function appendConversationReplyLog(input: {
  readonly task: ConversationWorkerTask;
  readonly route: Extract<ConversationRouteDecision, { readonly kind: "cancel_interrupt" }>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly reply: string;
}): Promise<void> {
  try {
    await input.dependencies.conversationReplyLogSink?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      created_at: new Date().toISOString(),
      owner_message: input.task.message.content,
      route_kind: input.route.kind,
      reply_mode: "template",
      reply: input.reply,
      triage: input.route.triage,
      contexts: {},
    });
  } catch {
    // conversation（对话）本地日志是旁路诊断，不能阻断实服回复。
  }
}
