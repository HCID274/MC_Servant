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
