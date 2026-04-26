import { createCancelTemplateReply, createConversationReply } from "../../conversation/chat.js";
import type { ConversationCompositeTriage } from "../../conversation/contracts.js";
import {
  createConversationRouteDecision,
  createMessageTriage,
  isMessageTriageOutput,
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
  const createWorker = input.dependencies.createWorker ?? createDefaultConversationWorker;

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    const task = cloneWorkerTask(job.data);
    const triage = await (input.dependencies.triage?.({ task }) ?? createDefaultTriage());
    if (!isMessageTriageOutput(triage)) {
      await handleCompositeTriage({
        task,
        triage,
        dependencies: input.dependencies,
        events,
      });

      return;
    }

    const route = createConversationRouteDecision({
      triage,
      message: task.message.content,
      has_active_task: input.dependencies.hasActiveTask?.() ?? false,
    });

    switch (route.kind) {
      case "chat_reply":
        await handleChatReplyRoute({
          task,
          triage,
          route,
          dependencies: input.dependencies,
          events,
        });
        break;
      case "cancel_interrupt":
        await handleCancelInterruptRoute({
          task,
          route,
          dependencies: input.dependencies,
          events,
        });
        break;
      case "plan_exec":
      case "modify_interrupt_then_plan":
        await handlePlanExecRoute({
          task,
          route,
          dependencies: input.dependencies,
          events,
        });
        break;
    }
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

/** 按 cancel（取消）→reply（回复）→action（动作） 顺序派发复合分诊结果。 */
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

  if (input.triage.reply !== undefined) {
    if (input.triage.reply.content === undefined) {
      await handleGeneratedCompositeReply(input);
    } else {
      await broadcastCompositeReply(input, input.triage.reply.content, "llm");
    }
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

async function handleGeneratedCompositeReply(input: {
  readonly task: ReturnType<typeof cloneWorkerTask>;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
}): Promise<void> {
  const triage = createMessageTriage({
    intent: "chat",
    priority: ConversationPriority.Normal,
    reason: "composite_reply",
  });
  const route = createConversationRouteDecision({
    triage,
    message: input.task.message.content,
    has_active_task: false,
  });

  if (route.kind !== "chat_reply") {
    throw new Error(`composite reply produced unsupported route: ${route.kind}`);
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
  input.events.push(
    Object.freeze({
      type: "chat.reply",
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      content: reply.reply,
    }),
  );
}
