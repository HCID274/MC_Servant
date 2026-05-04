import { eq } from "drizzle-orm";

import { TaskHistoryStatus } from "../core-ports/tasking.js";
import {
  type PersistedTaskHistoryAcceptedRecord,
  type PersistedTaskHistoryStartedPatch,
  type PersistedTaskHistoryTerminalPatch,
  taskHistoryTable,
} from "../data/index.js";

type TaskHistoryInsertRow = typeof taskHistoryTable.$inferInsert;

interface TaskHistoryInsertResult extends PromiseLike<unknown> {
  onConflictDoNothing?: () => Promise<unknown> | unknown;
}

interface TaskHistoryInsertQuery {
  values(row: TaskHistoryInsertRow): TaskHistoryInsertResult;
}

interface TaskHistoryUpdateQuery {
  set(values: unknown): {
    where(condition: unknown): Promise<unknown> | unknown;
  };
}

interface TaskHistoryDatabase {
  insert(table: typeof taskHistoryTable): TaskHistoryInsertQuery;
  update(table: typeof taskHistoryTable): TaskHistoryUpdateQuery;
}

/** task_history（任务历史） 在线持久化端口。 */
export interface PostgresTaskHistoryStore {
  /** 写入 accepted（已接受） 初始行。 */
  insertAccepted(record: PersistedTaskHistoryAcceptedRecord): Promise<unknown>;
  /** 更新 started（已开始） 状态。 */
  markStarted(patch: PersistedTaskHistoryStartedPatch): Promise<unknown>;
  /** 更新 completed / failed / interrupted（完成 / 失败 / 中断） 终态。 */
  markTerminal(patch: PersistedTaskHistoryTerminalPatch): Promise<unknown>;
  /** 更新 discarded（已丢弃） 状态。 */
  markDiscarded(input: { readonly id: string; readonly discarded_at: string }): Promise<unknown>;
}

/** 创建 task_history（任务历史） PostgreSQL（关系型数据库） 持久化端口。 */
export function createPostgresTaskHistoryStore(input: {
  readonly db: unknown;
}): PostgresTaskHistoryStore {
  return Object.freeze({
    async insertAccepted(record: PersistedTaskHistoryAcceptedRecord): Promise<unknown> {
      const result = asTaskHistoryDatabase(input.db)
        .insert(taskHistoryTable)
        .values({
          id: record.id,
          botId: record.bot_id,
          type: record.type,
          intentEpoch: record.intent_epoch,
          status: record.status,
          ...(record.type === "skill_call"
            ? {
                skill: record.skill,
                params: record.params,
              }
            : {
                codeRef: record.code_ref,
              }),
          logRef: record.log_ref,
          snapshotTs: record.snapshot_ts,
          messageId: record.message_id,
          createdAt: new Date(record.created_at),
        });

      return result.onConflictDoNothing === undefined ? result : result.onConflictDoNothing();
    },

    async markStarted(patch: PersistedTaskHistoryStartedPatch): Promise<unknown> {
      return asTaskHistoryDatabase(input.db)
        .update(taskHistoryTable)
        .set({
          status: patch.status,
          startedAt: new Date(patch.started_at),
        })
        .where(eq(taskHistoryTable.id, patch.id));
    },

    async markTerminal(patch: PersistedTaskHistoryTerminalPatch): Promise<unknown> {
      return asTaskHistoryDatabase(input.db)
        .update(taskHistoryTable)
        .set({
          status: patch.status,
          finishedAt: new Date(patch.finished_at),
          durationMs: patch.duration_ms,
          totalSteps: patch.total_steps,
          ...(patch.status === TaskHistoryStatus.Failed ? { error: patch.error } : {}),
          ...(patch.status === TaskHistoryStatus.Interrupted
            ? {
                interruptSource: patch.interrupt_source,
              }
            : {}),
        })
        .where(eq(taskHistoryTable.id, patch.id));
    },

    async markDiscarded(discarded: {
      readonly id: string;
      readonly discarded_at: string;
    }): Promise<unknown> {
      return asTaskHistoryDatabase(input.db)
        .update(taskHistoryTable)
        .set({
          status: TaskHistoryStatus.Discarded,
          finishedAt: new Date(discarded.discarded_at),
        })
        .where(eq(taskHistoryTable.id, discarded.id));
    },
  });
}

function asTaskHistoryDatabase(db: unknown): TaskHistoryDatabase {
  const candidate = db as { readonly insert?: unknown; readonly update?: unknown };

  if (typeof candidate.insert !== "function" || typeof candidate.update !== "function") {
    throw new Error("Postgres db does not support task_history persistence");
  }

  return candidate as TaskHistoryDatabase;
}
