/**
 * 数据库 Schema 与 Drizzle ORM 表定义。
 * 
 * 架构职责：
 * 1. 物理模型定义：使用 Drizzle ORM 定义 PostgreSQL 表结构，包括主外键、索引、唯一约束等。
 * 2. 向量化支持：配置 pgvector 相关的向量列与 HNSW 索引，支撑 RAG（检索增强生成）功能。
 * 3. 约束强化：通过 CHECK 约束在数据库层面强制保证枚举值的合法性。
 * 4. 检索优化：定义全文本搜索（FTS）的 tsvector 生成列与 GIN 索引。
 */

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
import type { TaskFailedErrorSnapshot, TaskStatusEventPayload } from "../runtime/events.js";
import type { SkillCallJob } from "../runtime/tasking.js";
import {
  type BotConfigOverlay,
  CHAT_MESSAGE_ROLES,
  DEFAULT_EMBEDDING_DIMENSIONS,
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
export const EMBEDDING_DIMENSIONS = DEFAULT_EMBEDDING_DIMENSIONS;

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

/**
 * 用户（所有者）表。
 * 
 * 架构意图：
 * 承载管理系统的基本身份信息与认证凭证（密码 Hash）。
 */
export const ownersTable = mcServantSchema.table("owners", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 机器人配置表。
 * 
 * 架构意图：
 * 存储 Bot 的核心配置，包括人格模板、目标 Minecraft 服务器以及动态配置覆盖（config 字段）。
 */
export const botsTable = mcServantSchema.table("bots", {
  id: text("id").primaryKey(),
  botName: text("bot_name").notNull().unique(),
  persona: text("persona").notNull().default("catmaid"),
  mcServer: text("mc_server").notNull(),
  config: jsonb("config").$type<BotConfigOverlay>().notNull().default({}),
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

/**
 * 对话消息表。
 * 
 * 架构意图：
 * 记录 Bot 与主人之间的完整对话流，通过 sessionId 关联特定会话，为 LLM 提供长短期记忆背景。
 */
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

/**
 * 事件日志表。
 * 
 * 架构意图：
 * 存储系统运行期间的各类原子事件（状态机迁移、心跳、IO 结果等），用于审计和回溯系统行为。
 */
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

/**
 * 任务历史表。
 * 
 * 架构意图：
 * 记录每一个任务（技能调用或沙箱代码）的详细生命周期，包括状态切换、日志引用（logRef）和耗时统计。
 */
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
    error: jsonb("error").$type<TaskFailedErrorSnapshot>(),
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

/**
 * 任务摘要与向量表。
 * 
 * 架构意图：
 * 存储任务执行完成后的 LLM 总结及其 Embedding 向量，支持基于语义相似度的 RAG 检索。
 */
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

/**
 * 会话摘要与向量表。
 * 
 * 架构意图：
 * 记录一个会话内多个相关任务的聚合总结及其向量表示。
 */
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

/**
 * 生成 SQL CHECK 约束。
 * 
 * 架构意图：
 * 在数据库层面强制文本列的取值范围，弥补 Drizzle ORM 在特定 pg 版本下对文本枚举校验的不足。
 */
function checkInArray<TColumnName extends string>(
  name: string,
  column: { name: TColumnName },
  values: readonly string[],
) {
  return sql.raw(
    `CONSTRAINT "${name}" CHECK ("${column.name}" IN (${values.map((value) => `'${value}'`).join(", ")}))`,
  );
}
