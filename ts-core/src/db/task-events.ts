import { type TaskEventDraft, taskEventsTable } from "../data/index.js";

type TaskEventInsertRow = typeof taskEventsTable.$inferInsert;

interface TaskEventInsertQuery {
  values(row: TaskEventInsertRow): Promise<unknown> | unknown;
}

interface TaskEventInsertDatabase {
  insert(table: typeof taskEventsTable): TaskEventInsertQuery;
}

/** 创建 task_events（任务事件） PostgreSQL（关系型数据库） 持久化端口。 */
export function createPostgresTaskEventPersister(input: {
  readonly db: unknown;
}): (draft: TaskEventDraft) => Promise<unknown> {
  return async (draft) =>
    asTaskEventInsertDatabase(input.db)
      .insert(taskEventsTable)
      .values({
        id: draft.id,
        taskId: draft.task_id,
        botId: draft.bot_id,
        messageId: draft.message_id,
        ownerText: draft.owner_text,
        taskCard: draft.task_card,
        ...(draft.takeaway === undefined ? {} : { takeaway: draft.takeaway }),
        embedding: [...draft.embedding],
        ...(draft.log_ref === undefined ? {} : { logRef: draft.log_ref }),
        createdAt: new Date(draft.created_at),
      });
}

function asTaskEventInsertDatabase(db: unknown): TaskEventInsertDatabase {
  const candidate = db as { readonly insert?: unknown };

  if (typeof candidate.insert !== "function") {
    throw new Error("Postgres db does not support task_events insert");
  }

  return candidate as TaskEventInsertDatabase;
}
