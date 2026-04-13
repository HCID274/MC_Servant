import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

import type { MessageTriage } from "../domain/contracts.js";
import type { TaskStatusEventPayload } from "../runtime/events.js";
import type { SkillCallJob } from "../runtime/tasking.js";
import {
  CHAT_MESSAGE_ROLES,
  MC_SERVANT_SCHEMA_NAME,
  PERSISTED_MESSAGE_SOURCES,
  type PersistedEventPayload,
  type PersistedEventType,
  type PersistedInterruptSource,
  TASK_HISTORY_STATUS_VALUES,
  TASK_HISTORY_TASK_TYPES,
  TASK_SUMMARY_STATUS_VALUES,
} from "./contracts.js";

/** 向量列的维度常量。 */
export const EMBEDDING_DIMENSIONS = 1024 as const;

/** mc_servant schema 命名空间。 */
export const mcServantSchema = pgSchema(MC_SERVANT_SCHEMA_NAME);

/** 部分索引的契约描述。 */
export interface PartialIndexContract {
  /** 索引名。 */
  name: string;
  /** 索引列名。 */
  columns: readonly string[];
  /** 部分索引谓词。 */
  where: string;
}

/** 生成列的契约描述。 */
export interface GeneratedColumnContract {
  /** 列名。 */
  name: string;
  /** 底层数据类型。 */
  dataType: string;
  /** 生成表达式。 */
  expression: string;
  /** 是否为存储生成列。 */
  stored: true;
}

/** 检索索引的契约描述。 */
export interface SearchIndexContract {
  /** 索引名。 */
  name: string;
  /** 索引方法。 */
  method: "btree" | "gin" | "hnsw";
  /** 目标列名。 */
  columns: readonly string[];
  /** 操作符类。 */
  operatorClass?: string;
  /** 索引参数。 */
  with?: Readonly<Record<string, number>>;
}

/** sessions 表的 token 部分索引契约。 */
export const SESSIONS_TOKEN_INDEX_CONTRACT = {
  name: "idx_sessions_token",
  columns: ["token"],
  where: "expires_at > now()",
} as const satisfies PartialIndexContract;

/** task_summaries 表的生成列契约。 */
export const TASK_SUMMARIES_GENERATED_COLUMNS = [
  {
    name: "summary_tsv",
    dataType: "tsvector",
    expression: "to_tsvector('simple', summary)",
    stored: true,
  },
] as const satisfies readonly GeneratedColumnContract[];

/** task_summaries 表的检索索引契约。 */
export const TASK_SUMMARIES_SEARCH_INDEXES = [
  {
    name: "idx_summary_fts",
    method: "gin",
    columns: ["summary_tsv"],
  },
  {
    name: "idx_summary_embedding",
    method: "hnsw",
    columns: ["embedding"],
    operatorClass: "vector_cosine_ops",
    with: {
      m: 16,
      ef_construction: 64,
    },
  },
] as const satisfies readonly SearchIndexContract[];

/** session_summaries 表的生成列契约。 */
export const SESSION_SUMMARIES_GENERATED_COLUMNS = [
  {
    name: "summary_tsv",
    dataType: "tsvector",
    expression: "to_tsvector('simple', summary)",
    stored: true,
  },
] as const satisfies readonly GeneratedColumnContract[];

/** session_summaries 表的检索索引契约。 */
export const SESSION_SUMMARIES_SEARCH_INDEXES = [
  {
    name: "idx_session_summary_fts",
    method: "gin",
    columns: ["summary_tsv"],
  },
  {
    name: "idx_session_summary_emb",
    method: "hnsw",
    columns: ["embedding"],
    operatorClass: "vector_cosine_ops",
    with: {
      m: 16,
      ef_construction: 64,
    },
  },
] as const satisfies readonly SearchIndexContract[];

/** owners 表定义。 */
export const ownersTable = mcServantSchema.table("owners", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** bots 表定义。 */
export const botsTable = mcServantSchema.table("bots", {
  id: text("id").primaryKey(),
  botName: text("bot_name").notNull().unique(),
  persona: text("persona").notNull().default("catmaid"),
  mcServer: text("mc_server").notNull(),
  config: jsonb("config").$type<Readonly<Record<string, unknown>>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** owner_bots 表定义。 */
export const ownerBotsTable = mcServantSchema.table(
  "owner_bots",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => ownersTable.id),
    botId: text("bot_id")
      .notNull()
      .references(() => botsTable.id),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.botId] }),
    uniqueIndex("idx_owner_bots_owner").on(table.ownerId),
    uniqueIndex("idx_owner_bots_bot").on(table.botId),
  ],
);

/** sessions 表定义。 */
export const sessionsTable = mcServantSchema.table(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => ownersTable.id),
    botId: text("bot_id")
      .notNull()
      .references(() => botsTable.id),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [],
);

/** chat_messages 表定义。 */
export const chatMessagesTable = mcServantSchema.table(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => botsTable.id),
    sessionId: text("session_id"),
    role: text("role").$type<(typeof CHAT_MESSAGE_ROLES)[number]>().notNull(),
    content: text("content").notNull(),
    source: text("source").$type<(typeof PERSISTED_MESSAGE_SOURCES)[number]>().notNull(),
    messageId: text("message_id").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chat_bot_session").on(table.botId, table.sessionId, table.createdAt),
    index("idx_chat_bot_recent").on(table.botId, table.createdAt),
    checkInArray("chat_messages_role_check", table.role, CHAT_MESSAGE_ROLES),
    checkInArray("chat_messages_source_check", table.source, PERSISTED_MESSAGE_SOURCES),
  ],
);

/** event_log 表定义。 */
export const eventLogTable = mcServantSchema.table(
  "event_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    botId: text("bot_id").notNull(),
    sessionId: text("session_id"),
    type: text("type").$type<PersistedEventType>().notNull(),
    payload: jsonb("payload").$type<PersistedEventPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_event_log_bot_seq").on(table.botId, table.seq),
    index("idx_event_log_bot_type").on(table.botId, table.type, table.createdAt),
  ],
);

/** task_history 表定义。 */
export const taskHistoryTable = mcServantSchema.table(
  "task_history",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id")
      .notNull()
      .references(() => botsTable.id),
    type: text("type").$type<(typeof TASK_HISTORY_TASK_TYPES)[number]>().notNull(),
    intentEpoch: integer("intent_epoch").notNull(),
    status: text("status").$type<(typeof TASK_HISTORY_STATUS_VALUES)[number]>().notNull(),
    skill: text("skill"),
    params: jsonb("params").$type<SkillCallJob["params"]>(),
    codeRef: text("code_ref"),
    logRef: text("log_ref"),
    snapshotTs: bigint("snapshot_ts", { mode: "number" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    totalSteps: integer("total_steps"),
    error: jsonb("error").$type<Readonly<Record<string, unknown>>>(),
    interruptSource: jsonb("interrupt_source").$type<PersistedInterruptSource>(),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_task_bot_time").on(table.botId, table.createdAt),
    index("idx_task_bot_status").on(table.botId, table.status),
    checkInArray("task_history_type_check", table.type, TASK_HISTORY_TASK_TYPES),
    checkInArray("task_history_status_check", table.status, TASK_HISTORY_STATUS_VALUES),
  ],
);

/** task_summaries 表定义。 */
export const taskSummariesTable = mcServantSchema.table(
  "task_summaries",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskHistoryTable.id),
    botId: text("bot_id").notNull(),
    intent: text("intent").notNull(),
    status: text("status").$type<(typeof TASK_SUMMARY_STATUS_VALUES)[number]>().notNull(),
    summary: text("summary").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    logRef: text("log_ref"),
    triage: jsonb("triage").$type<MessageTriage>(),
    terminalEvent: jsonb("terminal_event").$type<TaskStatusEventPayload>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_summary_bot_time").on(table.botId, table.createdAt),
    checkInArray("task_summaries_status_check", table.status, TASK_SUMMARY_STATUS_VALUES),
  ],
);

/** session_summaries 表定义。 */
export const sessionSummariesTable = mcServantSchema.table(
  "session_summaries",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    summary: text("summary").notNull(),
    taskIds: text("task_ids").array().notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_session_summary_bot").on(table.botId, table.createdAt)],
);

/** mc_servant 表定义集合。 */
export const mcServantTables = {
  owners: ownersTable,
  bots: botsTable,
  ownerBots: ownerBotsTable,
  sessions: sessionsTable,
  chatMessages: chatMessagesTable,
  eventLog: eventLogTable,
  taskHistory: taskHistoryTable,
  taskSummaries: taskSummariesTable,
  sessionSummaries: sessionSummariesTable,
} as const;

function checkInArray<TColumnName extends string>(
  name: string,
  column: { name: TColumnName },
  values: readonly string[],
) {
  return sql.raw(
    `CONSTRAINT "${name}" CHECK ("${column.name}" IN (${values.map((value) => `'${value}'`).join(", ")}))`,
  );
}
