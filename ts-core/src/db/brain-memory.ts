import { eq } from "drizzle-orm";

import {
  type BotRollingSummaryRecord,
  type BotRollingSummaryWrite,
  botRollingSummaryTable,
  countRollingSummaryChars,
  createBotRollingSummaryRecord,
  createBotRollingSummaryWrite,
  taskEventsTable,
} from "../data/index.js";

type BotRollingSummaryRow = typeof botRollingSummaryTable.$inferSelect;

interface BrainMemorySelectQuery<T> {
  from(table: unknown): {
    where(condition: unknown): {
      limit(count: number): Promise<T[]> | T[];
    };
  };
}

interface BrainMemoryInsertQuery<T> {
  values(row: T): {
    onConflictDoUpdate(input: unknown): Promise<unknown> | unknown;
  };
}

interface BrainMemoryUpdateQuery {
  set(values: unknown): {
    where(condition: unknown): Promise<unknown> | unknown;
  };
}

interface BrainMemoryDatabase {
  select(): BrainMemorySelectQuery<BotRollingSummaryRow>;
  insert(
    table: typeof botRollingSummaryTable,
  ): BrainMemoryInsertQuery<typeof botRollingSummaryTable.$inferInsert>;
  update(table: typeof taskEventsTable | typeof botRollingSummaryTable): BrainMemoryUpdateQuery;
}

/** BrainWorker（大脑工作线程） 写入 A.5/B 层所需的 PostgreSQL（关系型数据库） 端口。 */
export interface PostgresBrainMemoryStore {
  /** 读取某个 Bot（机器人） 的滚动摘要。 */
  loadRollingSummary(botId: string): Promise<BotRollingSummaryRecord | undefined>;
  /** upsert（插入或更新） 某个 Bot（机器人） 的滚动摘要。 */
  writeRollingSummary(write: BotRollingSummaryWrite): Promise<unknown>;
  /** 更新 task_events.takeaway（任务事件要点）。 */
  updateTaskEventTakeaway(input: {
    readonly event_id: string;
    readonly takeaway: string;
    readonly updated_at: string;
  }): Promise<unknown>;
}

/** 创建 BrainWorker（大脑工作线程） PostgreSQL（关系型数据库） 记忆写端口。 */
export function createPostgresBrainMemoryStore(input: {
  readonly db: unknown;
}): PostgresBrainMemoryStore {
  return Object.freeze({
    async loadRollingSummary(botId: string): Promise<BotRollingSummaryRecord | undefined> {
      const db = asBrainMemoryDatabase(input.db);
      const rows = await db
        .select()
        .from(botRollingSummaryTable)
        .where(eq(botRollingSummaryTable.botId, botId))
        .limit(1);
      const row = rows[0];

      return row === undefined ? undefined : createRollingSummaryRecordFromRow(row);
    },

    async writeRollingSummary(write: BotRollingSummaryWrite): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);
      const normalized = createBotRollingSummaryWrite(write);
      const updatedAt = new Date(normalized.updated_at);

      return db
        .insert(botRollingSummaryTable)
        .values({
          botId: normalized.bot_id,
          content: normalized.content,
          charCount: countRollingSummaryChars(normalized.content),
          ...(normalized.llm_model === undefined ? {} : { llmModel: normalized.llm_model }),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: botRollingSummaryTable.botId,
          set: {
            content: normalized.content,
            charCount: countRollingSummaryChars(normalized.content),
            llmModel: normalized.llm_model ?? null,
            updatedAt,
          },
        });
    },

    async updateTaskEventTakeaway(takeawayInput: {
      readonly event_id: string;
      readonly takeaway: string;
      readonly updated_at: string;
    }): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);

      return db
        .update(taskEventsTable)
        .set({
          takeaway: takeawayInput.takeaway,
        })
        .where(eq(taskEventsTable.id, takeawayInput.event_id));
    },
  });
}

function createRollingSummaryRecordFromRow(row: BotRollingSummaryRow): BotRollingSummaryRecord {
  return createBotRollingSummaryRecord({
    bot_id: row.botId,
    content: row.content,
    char_count: row.charCount,
    ...(row.llmModel === null ? {} : { llm_model: row.llmModel }),
    updated_at: row.updatedAt.toISOString(),
  });
}

function asBrainMemoryDatabase(db: unknown): BrainMemoryDatabase {
  const candidate = db as {
    readonly select?: unknown;
    readonly insert?: unknown;
    readonly update?: unknown;
  };

  if (typeof candidate.select !== "function") {
    throw new Error("Postgres db does not support brain memory select");
  }
  if (typeof candidate.insert !== "function") {
    throw new Error("Postgres db does not support brain memory insert");
  }
  if (typeof candidate.update !== "function") {
    throw new Error("Postgres db does not support brain memory update");
  }

  return candidate as BrainMemoryDatabase;
}
