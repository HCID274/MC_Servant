import type { ConversationRecentContextStore } from "../../conversation/recent-context.js";
import { TaskHistoryStatus } from "../../core-ports/tasking.js";
import type { BotWorkerAction } from "../contracts.js";

/** ConversationWorker（对话工作线程） 侧消费 BotWorker（机器人工作线程） 终态动作的 sink（汇点）。 */
export type ConversationBotWorkerActionSink = (action: BotWorkerAction) => Promise<void> | void;

/** 创建 BotWorker（机器人工作线程） 动作到 recent context（最近上下文） 的 conversation（对话）侧 sink（汇点）。 */
export function createConversationBotWorkerActionSink(input: {
  readonly recentContextStore?: ConversationRecentContextStore;
}): ConversationBotWorkerActionSink {
  return (action) => {
    if (input.recentContextStore === undefined) {
      return;
    }

    appendSandboxFinalizeToRecentContext({
      store: input.recentContextStore,
      action,
    });
  };
}

/** 将 sandbox（沙盒） 终态 error.message（错误消息） 收敛到 ConversationWorker（对话工作线程） 最近上下文边界。 */
export function appendSandboxFinalizeToRecentContext(input: {
  readonly store: ConversationRecentContextStore;
  readonly action: BotWorkerAction;
}): void {
  if (input.action.type !== "persist_sandbox_experience") {
    return;
  }

  const experience = input.action.experience;
  if (
    experience.status !== TaskHistoryStatus.Failed &&
    experience.status !== TaskHistoryStatus.Interrupted
  ) {
    return;
  }

  if (experience.error === undefined) {
    return;
  }

  input.store.appendSandboxError({
    message_id: experience.message_id,
    text: experience.error.message,
  });
}
