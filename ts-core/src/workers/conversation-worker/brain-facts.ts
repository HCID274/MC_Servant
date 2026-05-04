import type { SnapshotPosition } from "../../core-ports/observation.js";
import { createBrainDiagnosticLogRef } from "../../diagnostics/index.js";
import {
  type BrainConversationFactRouteKind,
  type ConversationWorkerTask,
  createBrainConversationFactWorkerTask,
} from "../contracts.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "./types.js";

/** 创建 BullMQ（任务队列） 安全的 conversation_fact（对话事实） jobId（任务编号）。 */
export function createBrainConversationFactJobId(messageId: string): string {
  const trimmed = messageId.trim();

  if (trimmed.length === 0) {
    throw new Error("conversation fact jobId requires message_id");
  }

  return `conversation-fact-${trimmed.replace(/[:;]/gu, "_")}`;
}

/** 将 Chat / Plan 对话事实候选统一送入 BrainWorker（大脑工作线程） 侧 rubric（评分规则）。 */
export async function enqueueConversationFactCandidate(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly route_kind: BrainConversationFactRouteKind;
  readonly bot_reply?: string;
  readonly owner_position_at_message?: SnapshotPosition;
}): Promise<void> {
  if (input.dependencies.enqueueBrainFactSink === undefined) {
    return;
  }

  await input.dependencies.enqueueBrainFactSink({
    task: createBrainConversationFactWorkerTask({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      intent_epoch: input.task.message.intent_epoch,
      snapshot_ts: input.task.message.snapshot_ts,
      owner_text: input.task.message.content,
      route_kind: input.route_kind,
      ...(input.bot_reply === undefined ? {} : { bot_reply: input.bot_reply }),
      ...(input.owner_position_at_message === undefined
        ? {}
        : { owner_position_at_message: input.owner_position_at_message }),
    }),
  });
}

/** best-effort（尽力而为） 入队 conversation_fact（对话事实），失败只写诊断，不阻断 Chat / Plan（闲聊/规划）主路径。 */
export async function tryEnqueueConversationFactCandidate(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
  readonly route_kind: BrainConversationFactRouteKind;
  readonly bot_reply?: string;
  readonly owner_position_at_message?: SnapshotPosition;
}): Promise<void> {
  try {
    await enqueueConversationFactCandidate(input);
  } catch (error) {
    const errorSnapshot = createErrorSnapshot(error);
    input.events.push(
      Object.freeze({
        type: "brain.fact.enqueue_failed" as const,
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        route_kind: input.route_kind,
        error_summary: errorSnapshot.message,
      }),
    );
    try {
      await appendBrainFactEnqueueFailedDiagnostic({
        task: input.task,
        dependencies: input.dependencies,
        route_kind: input.route_kind,
        error: errorSnapshot,
      });
    } catch (diagnosticError) {
      const diagnosticErrorSnapshot = createErrorSnapshot(diagnosticError);
      input.events.push(
        Object.freeze({
          type: "brain.fact.diagnostic_failed" as const,
          bot_id: input.task.bot_id,
          message_id: input.task.message.message_id,
          route_kind: input.route_kind,
          enqueue_error_summary: errorSnapshot.message,
          diagnostic_error_summary: diagnosticErrorSnapshot.message,
        }),
      );
    }
  }
}

async function appendBrainFactEnqueueFailedDiagnostic(input: {
  readonly task: ConversationWorkerTask;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly route_kind: BrainConversationFactRouteKind;
  readonly error: Readonly<{ readonly name?: string; readonly message: string }>;
}): Promise<void> {
  const sink = input.dependencies.brainDiagnosticSink;

  if (sink === undefined) {
    return;
  }

  const now = new Date();
  await sink({
    log_ref: createBrainDiagnosticLogRef({
      date: now.toISOString().slice(0, 10),
      kind: "fact-enqueue-failed",
      message_id: input.task.message.message_id,
    }),
    lines: [
      Object.freeze({
        t: now.getTime() / 1000,
        event: "brain.fact.enqueue_failed" as const,
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        route_kind: input.route_kind,
        error: input.error,
      }),
    ],
  });
}

function createErrorSnapshot(
  error: unknown,
): Readonly<{ readonly name?: string; readonly message: string }> {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name,
      message: error.message,
    });
  }

  return Object.freeze({
    message: String(error),
  });
}
