import type { TaskFailedErrorSnapshot } from "../core-ports/events.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import {
  type PersistedInterruptSource,
  createPersistedTaskHistoryAcceptedRecord,
  createPersistedTaskHistoryStartedPatch,
  createPersistedTaskHistoryTerminalPatch,
} from "../data/index.js";
import type { PostgresTaskHistoryStore } from "../db/index.js";
import { createSandboxCodeRef, createSandboxLogRef } from "../diagnostics/index.js";
import type { BotWorkerAction, BotWorkerTask } from "./contracts.js";

/** 将执行任务 accepted（已接受）状态写入 task_history（任务历史）。 */
export async function persistAcceptedTaskHistory(input: {
  readonly bot_id: string;
  readonly task: BotWorkerTask;
  readonly taskHistoryStore?: PostgresTaskHistoryStore;
  readonly now: () => Date;
}): Promise<void> {
  if (input.taskHistoryStore === undefined) {
    return;
  }

  const createdAt = input.now();
  const date = createdAt.toISOString().slice(0, 10);

  await input.taskHistoryStore.insertAccepted(
    createPersistedTaskHistoryAcceptedRecord({
      bot_id: input.bot_id,
      job: input.task.exec_job,
      log_ref: createSandboxLogRef({ date, job_id: input.task.exec_job.message_id }),
      code_ref: createSandboxCodeRef({ date, job_id: input.task.exec_job.message_id }),
      created_at: createdAt.toISOString(),
    }),
  );
}

/** 将 BotWorker（机器人工作线程） 生命周期动作映射为 task_history（任务历史）状态更新。 */
export async function persistTaskHistoryLifecycleAction(input: {
  readonly action: BotWorkerAction;
  readonly taskHistoryStore?: PostgresTaskHistoryStore;
  readonly now: () => Date;
}): Promise<void> {
  if (input.action.type !== "emit_task_lifecycle" || input.taskHistoryStore === undefined) {
    return;
  }

  const lifecycle = input.action.lifecycle;
  const nowIso = input.now().toISOString();

  switch (lifecycle.status) {
    case TaskHistoryStatus.Started:
      await input.taskHistoryStore.markStarted(
        createPersistedTaskHistoryStartedPatch({
          id: lifecycle.payload.job_id,
          started_at: nowIso,
        }),
      );
      return;
    case TaskHistoryStatus.Discarded:
      await input.taskHistoryStore.markDiscarded({
        id: lifecycle.payload.job_id,
        discarded_at: nowIso,
      });
      return;
    case TaskHistoryStatus.Completed: {
      const payload = lifecycle.payload as {
        readonly job_id: string;
        readonly duration_ms: number;
        readonly total_steps: number;
      };
      await input.taskHistoryStore.markTerminal(
        createPersistedTaskHistoryTerminalPatch({
          id: payload.job_id,
          status: TaskHistoryStatus.Completed,
          finished_at: nowIso,
          duration_ms: payload.duration_ms,
          total_steps: payload.total_steps,
        }),
      );
      return;
    }
    case TaskHistoryStatus.Failed: {
      const payload = lifecycle.payload as unknown as {
        readonly job_id: string;
        readonly duration_ms: number;
        readonly total_steps: number;
        readonly error: TaskFailedErrorSnapshot;
      };
      await input.taskHistoryStore.markTerminal(
        createPersistedTaskHistoryTerminalPatch({
          id: payload.job_id,
          status: TaskHistoryStatus.Failed,
          finished_at: nowIso,
          duration_ms: payload.duration_ms,
          total_steps: payload.total_steps,
          error: payload.error,
        }),
      );
      return;
    }
    case TaskHistoryStatus.Interrupted: {
      const payload = lifecycle.payload as unknown as {
        readonly job_id: string;
        readonly duration_ms: number;
        readonly total_steps: number;
        readonly interrupt_source: PersistedInterruptSource;
        readonly reason: string;
      };
      await input.taskHistoryStore.markTerminal(
        createPersistedTaskHistoryTerminalPatch({
          id: payload.job_id,
          status: TaskHistoryStatus.Interrupted,
          finished_at: nowIso,
          duration_ms: payload.duration_ms,
          total_steps: payload.total_steps,
          interrupt_source: payload.interrupt_source,
          reason: payload.reason,
        }),
      );
      return;
    }
  }
}
