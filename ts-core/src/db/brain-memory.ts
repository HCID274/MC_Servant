import { eq } from "drizzle-orm";

import {
  type BotMemoryRecord,
  type BotMemorySnapshot,
  type BotRollingSummaryRecord,
  type BotRollingSummaryWrite,
  type MemoryAuditDraft,
  type MemoryCandidateDraft,
  botMemoryTable,
  botRollingSummaryTable,
  countBotMemoryChars,
  countRollingSummaryChars,
  createBotMemoryRecord,
  createBotRollingSummaryRecord,
  createBotRollingSummaryWrite,
  createEmptyBotMemorySnapshot,
  createMemoryAuditDraft,
  createMemoryCandidateDraft,
  memoryAuditTable,
  memoryCandidatesTable,
  taskEventsTable,
} from "../data/index.js";

type BotRollingSummaryRow = typeof botRollingSummaryTable.$inferSelect;
type BotMemoryRow = typeof botMemoryTable.$inferSelect;

interface BrainMemorySelectQuery<T> {
  from(table: unknown): {
    where(condition: unknown): {
      limit(count: number): Promise<T[]> | T[];
    };
  };
}

interface BrainMemoryInsertResult extends PromiseLike<unknown> {
  onConflictDoUpdate?: (input: unknown) => Promise<unknown> | unknown;
}

interface BrainMemoryInsertQuery<T> {
  values(row: T): BrainMemoryInsertResult;
}

interface BrainMemoryUpdateQuery {
  set(values: unknown): {
    where(condition: unknown): Promise<unknown> | unknown;
  };
}

interface BrainMemoryDatabase {
  select(): BrainMemorySelectQuery<unknown>;
  insert(
    table:
      | typeof botRollingSummaryTable
      | typeof botMemoryTable
      | typeof memoryCandidatesTable
      | typeof memoryAuditTable,
  ): BrainMemoryInsertQuery<unknown>;
  update(
    table: typeof taskEventsTable | typeof botRollingSummaryTable | typeof memoryCandidatesTable,
  ): BrainMemoryUpdateQuery;
}

/** BrainWorker（大脑工作线程） 写入 A.5/B 层所需的 PostgreSQL（关系型数据库） 端口。 */
export interface PostgresBrainMemoryStore {
  /** 读取某个 Bot（机器人） 的滚动摘要。 */
  loadRollingSummary(botId: string): Promise<BotRollingSummaryRecord | undefined>;
  /** upsert（插入或更新） 某个 Bot（机器人） 的滚动摘要。 */
  writeRollingSummary(write: BotRollingSummaryWrite): Promise<unknown>;
  /** 读取某个 Bot（机器人） 的 C 层长期记忆。 */
  loadBotMemory(botId: string): Promise<BotMemorySnapshot>;
  /** upsert（插入或更新） 某个 kind（类别） 的长期记忆。 */
  writeBotMemory(input: {
    readonly bot_id: string;
    readonly kind: BotMemoryRecord["kind"];
    readonly content: string;
    readonly updated_at: string;
  }): Promise<unknown>;
  /** 写入 memory_candidates（记忆候选）。 */
  insertMemoryCandidate(draft: MemoryCandidateDraft): Promise<unknown>;
  /** 更新 memory_candidates.status（候选状态）。 */
  decideMemoryCandidate(input: {
    readonly candidate_id: string;
    readonly status: MemoryCandidateDraft["status"];
    readonly decided_at: string;
  }): Promise<unknown>;
  /** 写入 memory_audit（记忆审计）。 */
  appendMemoryAudit(draft: MemoryAuditDraft): Promise<unknown>;
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

      return row === undefined
        ? undefined
        : createRollingSummaryRecordFromRow(row as BotRollingSummaryRow);
    },

    async writeRollingSummary(write: BotRollingSummaryWrite): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);
      const normalized = createBotRollingSummaryWrite(write);
      const updatedAt = new Date(normalized.updated_at);

      return upsertWithRequiredConflictHandler(
        db.insert(botRollingSummaryTable).values({
          botId: normalized.bot_id,
          content: normalized.content,
          charCount: countRollingSummaryChars(normalized.content),
          ...(normalized.llm_model === undefined ? {} : { llmModel: normalized.llm_model }),
          updatedAt,
        }),
        {
          target: botRollingSummaryTable.botId,
          set: {
            content: normalized.content,
            charCount: countRollingSummaryChars(normalized.content),
            llmModel: normalized.llm_model ?? null,
            updatedAt,
          },
        },
      );
    },

    async loadBotMemory(botId: string): Promise<BotMemorySnapshot> {
      const db = asBrainMemoryDatabase(input.db);
      const rows = await db
        .select()
        .from(botMemoryTable)
        .where(eq(botMemoryTable.botId, botId))
        .limit(3);

      const records = (rows as BotMemoryRow[]).map((row) => createBotMemoryRecordFromRow(row));

      return createEmptyBotMemorySnapshot(
        Object.fromEntries(records.map((row) => [row.kind, row.content])),
      );
    },

    async writeBotMemory(memoryInput: {
      readonly bot_id: string;
      readonly kind: BotMemoryRecord["kind"];
      readonly content: string;
      readonly updated_at: string;
    }): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);
      const updatedAt = new Date(memoryInput.updated_at);

      return upsertWithRequiredConflictHandler(
        db.insert(botMemoryTable).values({
          botId: memoryInput.bot_id,
          kind: memoryInput.kind,
          content: memoryInput.content,
          charCount: countBotMemoryChars(memoryInput.content),
          updatedAt,
        }),
        {
          target: [botMemoryTable.botId, botMemoryTable.kind],
          set: {
            content: memoryInput.content,
            charCount: countBotMemoryChars(memoryInput.content),
            updatedAt,
          },
        },
      );
    },

    async insertMemoryCandidate(draft: MemoryCandidateDraft): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);
      const normalized = createMemoryCandidateDraft(draft);

      return db.insert(memoryCandidatesTable).values({
        id: normalized.id,
        botId: normalized.bot_id,
        sourceEventId: normalized.source_event_id,
        kind: normalized.kind,
        content: normalized.content,
        confidence: normalized.confidence,
        ...(normalized.reason === undefined ? {} : { reason: normalized.reason }),
        status: normalized.status,
        createdAt: new Date(normalized.created_at),
        ...(normalized.decided_at === undefined
          ? {}
          : { decidedAt: new Date(normalized.decided_at) }),
      });
    },

    async decideMemoryCandidate(decisionInput: {
      readonly candidate_id: string;
      readonly status: MemoryCandidateDraft["status"];
      readonly decided_at: string;
    }): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);

      return db
        .update(memoryCandidatesTable)
        .set({
          status: decisionInput.status,
          decidedAt: new Date(decisionInput.decided_at),
        })
        .where(eq(memoryCandidatesTable.id, decisionInput.candidate_id));
    },

    async appendMemoryAudit(draft: MemoryAuditDraft): Promise<unknown> {
      const db = asBrainMemoryDatabase(input.db);
      const normalized = createMemoryAuditDraft(draft);

      return db.insert(memoryAuditTable).values({
        id: normalized.id,
        botId: normalized.bot_id,
        kind: normalized.kind,
        op: normalized.op,
        ...(normalized.before_content === undefined
          ? {}
          : { beforeContent: normalized.before_content }),
        ...(normalized.after_content === undefined
          ? {}
          : { afterContent: normalized.after_content }),
        ...(normalized.candidate_id === undefined ? {} : { candidateId: normalized.candidate_id }),
        ...(normalized.reason === undefined ? {} : { reason: normalized.reason }),
        createdAt: new Date(normalized.created_at),
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

function createBotMemoryRecordFromRow(row: BotMemoryRow): BotMemoryRecord {
  return createBotMemoryRecord({
    bot_id: row.botId,
    kind: row.kind,
    content: row.content,
    char_count: row.charCount,
    updated_at: row.updatedAt.toISOString(),
  });
}

function upsertWithRequiredConflictHandler(
  query: BrainMemoryInsertResult,
  conflictInput: unknown,
): Promise<unknown> | unknown {
  if (query.onConflictDoUpdate === undefined) {
    throw new Error("Postgres db does not support brain memory upsert");
  }

  return query.onConflictDoUpdate(conflictInput);
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
