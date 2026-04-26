import { createConversationRouteDecision } from "../../conversation/triage.js";
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
