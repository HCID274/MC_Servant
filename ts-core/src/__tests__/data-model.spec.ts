import { readFileSync } from "node:fs";

import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  BOT_MEMORY_KIND_VALUES,
  DEFAULT_LOGS_BASE_DIR,
  DEFAULT_UNCLOSED_TASK_LIMIT,
  EVENT_LOG_RETENTION_DAYS,
  ExecutionTaskKind,
  JSONL_DIRECTORY_POLICIES,
  JSONL_RETENTION_DAYS,
  MC_SERVANT_SCHEMA_NAME,
  MC_SERVANT_TABLE_NAMES,
  MEMORY_AUDIT_OP_VALUES,
  MEMORY_CANDIDATE_STATUS_VALUES,
  PERSISTED_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  SESSIONS_TOKEN_INDEX_CONTRACT,
  SESSION_SUMMARIES_GENERATED_COLUMNS,
  SESSION_SUMMARIES_SEARCH_INDEXES,
  TASK_EVENTS_GENERATED_COLUMNS,
  TASK_EVENTS_SEARCH_INDEXES,
  TASK_HISTORY_STATUS_VALUES,
  TASK_PERSISTENCE_WRITE_SEQUENCE,
  TASK_PROGRESS_EVENT_TYPE,
  TASK_PROGRESS_STATUSES,
  TASK_SUMMARIES_GENERATED_COLUMNS,
  TASK_SUMMARIES_SEARCH_INDEXES,
  TaskHistoryStatus,
  createDatedStorageRef,
  createDeterministicTaskSummaryText,
  createMemoryContextFromTaskSummaries,
  createTaskSummaryDraft,
  createTaskSummarySource,
  eventLogTable,
  isValidStorageRef,
  mcServantTables,
  taskHistoryTable,
} from "../index.js";

describe("data 持久化契约", () => {
  it("应声明 mc_servant 核心表结构出口", () => {
    expect(MC_SERVANT_SCHEMA_NAME).toBe("mc_servant");
    expect(MC_SERVANT_TABLE_NAMES).toHaveLength(14);
    expect(getTableName(eventLogTable)).toBe("event_log");
    expect(getTableName(taskHistoryTable)).toBe("task_history");
    expect(Object.keys(getTableColumns(mcServantTables.eventLog))).toEqual([
      "seq",
      "botId",
      "sessionId",
      "type",
      "payload",
      "createdAt",
    ]);
    expect(Object.keys(getTableColumns(mcServantTables.taskHistory))).toContain("logRef");
    expect(Object.keys(getTableColumns(mcServantTables.taskHistory))).toContain("codeRef");
  });

  it("应让事件类型与任务状态直接复用现有运行时契约", () => {
    expect(PERSISTED_EVENT_TYPES).toEqual(RUNTIME_EVENT_TYPES);
    expect(TASK_PROGRESS_EVENT_TYPE).toBe("step.progress");
    expect(TASK_PROGRESS_STATUSES).toEqual(["ok", "err", "abort"]);
    expect(TASK_HISTORY_STATUS_VALUES).toEqual([
      TaskHistoryStatus.Accepted,
      TaskHistoryStatus.Started,
      TaskHistoryStatus.Completed,
      TaskHistoryStatus.Failed,
      TaskHistoryStatus.Interrupted,
      TaskHistoryStatus.Discarded,
    ]);
    expect(ExecutionTaskKind.SkillCall).toBe("skill_call");
    expect(BOT_MEMORY_KIND_VALUES).toEqual(["USER", "MEMORY", "SKILL"]);
    expect(MEMORY_CANDIDATE_STATUS_VALUES).toEqual([
      "pending",
      "applied",
      "rejected",
      "superseded",
    ]);
    expect(MEMORY_AUDIT_OP_VALUES).toEqual(["insert", "patch", "merge", "replace", "delete"]);
  });

  it("应只接受安全的相对日志引用", () => {
    const validRef = createDatedStorageRef({
      directory: "tasks",
      date: "2026-04-13",
      fileName: "T-abc123.jsonl",
    });

    expect(validRef).toBe("tasks/2026-04-13/T-abc123.jsonl");
    expect(isValidStorageRef(validRef)).toBe(true);
    expect(isValidStorageRef("/tmp/T-abc123.jsonl")).toBe(false);
    expect(isValidStorageRef("tasks/../../escape.jsonl")).toBe(false);
    expect(() =>
      createDatedStorageRef({
        directory: "tasks",
        date: "2026-04-13",
        fileName: "../escape.jsonl",
      }),
    ).toThrow("Invalid storage ref segment");
  });

  it("应集中暴露冷热日志保留期常量", () => {
    expect(DEFAULT_LOGS_BASE_DIR).toBe("./logs");
    expect(DEFAULT_UNCLOSED_TASK_LIMIT).toBe(5);
    expect(EVENT_LOG_RETENTION_DAYS).toBe(30);
    expect(JSONL_RETENTION_DAYS.tasks).toBe(90);
    expect(JSONL_RETENTION_DAYS.llm).toBe(30);
    expect(JSONL_DIRECTORY_POLICIES.sandbox.refFields).toEqual(["log_ref", "code_ref"]);
  });

  it("应编码任务生命周期写入顺序而不是散落在注释里", () => {
    expect(
      TASK_PERSISTENCE_WRITE_SEQUENCE.map((step) => ({
        order: step.order,
        phase: step.phase,
        target: step.target,
      })),
    ).toEqual([
      { order: 1, phase: "accepted", target: "task_history" },
      { order: 2, phase: "accepted", target: "event_log" },
      { order: 3, phase: "started", target: "task_history" },
      { order: 4, phase: "started", target: "event_log" },
      { order: 5, phase: "progress", target: "event_log" },
      { order: 6, phase: "progress", target: "jsonl" },
      { order: 7, phase: "terminal", target: "task_history" },
      { order: 8, phase: "terminal", target: "event_log" },
      { order: 9, phase: "terminal", target: "brain_queue" },
      { order: 10, phase: "brain_summary", target: "task_summaries" },
    ]);
  });

  it("应暴露 sessions 部分索引与摘要检索契约", () => {
    expect(SESSIONS_TOKEN_INDEX_CONTRACT).toEqual({
      name: "idx_sessions_token",
      columns: ["token"],
      where: "expires_at > now()",
    });
    expect(TASK_SUMMARIES_GENERATED_COLUMNS).toEqual([
      {
        name: "summary_tsv",
        dataType: "tsvector",
        expression: "to_tsvector('simple', summary)",
        stored: true,
      },
    ]);
    expect(TASK_SUMMARIES_SEARCH_INDEXES).toEqual([
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
    ]);
    expect(SESSION_SUMMARIES_GENERATED_COLUMNS).toEqual([
      {
        name: "summary_tsv",
        dataType: "tsvector",
        expression: "to_tsvector('simple', summary)",
        stored: true,
      },
    ]);
    expect(SESSION_SUMMARIES_SEARCH_INDEXES).toEqual([
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
    ]);
  });

  it("应声明 Brain（长期记忆）五表的 Drizzle（数据库 ORM）模型出口", () => {
    expect(MC_SERVANT_TABLE_NAMES).toHaveLength(14);
    expect(MC_SERVANT_TABLE_NAMES).toEqual([
      "owners",
      "bots",
      "owner_bots",
      "sessions",
      "chat_messages",
      "event_log",
      "task_history",
      "task_events",
      "bot_rolling_summary",
      "bot_memory",
      "memory_candidates",
      "memory_audit",
      "task_summaries",
      "session_summaries",
    ]);
    expect(getTableName(mcServantTables.taskEvents)).toBe("task_events");
    expect(Object.keys(getTableColumns(mcServantTables.taskEvents))).toEqual([
      "id",
      "taskId",
      "botId",
      "messageId",
      "ownerText",
      "taskCard",
      "takeaway",
      "embedding",
      "logRef",
      "createdAt",
    ]);
    expect(Object.keys(getTableColumns(mcServantTables.botRollingSummary))).toEqual([
      "botId",
      "content",
      "charCount",
      "llmModel",
      "updatedAt",
    ]);
    expect(Object.keys(getTableColumns(mcServantTables.botMemory))).toEqual([
      "botId",
      "kind",
      "content",
      "charCount",
      "updatedAt",
    ]);
    expect(Object.keys(getTableColumns(mcServantTables.memoryCandidates))).toEqual([
      "id",
      "botId",
      "sourceEventId",
      "kind",
      "content",
      "confidence",
      "reason",
      "status",
      "createdAt",
      "decidedAt",
    ]);
    expect(Object.keys(getTableColumns(mcServantTables.memoryAudit))).toEqual([
      "id",
      "botId",
      "kind",
      "op",
      "beforeContent",
      "afterContent",
      "candidateId",
      "reason",
      "createdAt",
    ]);
  });

  it("应声明 task_events 高级检索列与索引契约", () => {
    expect(TASK_EVENTS_GENERATED_COLUMNS).toEqual([
      {
        name: "search_tsv",
        dataType: "tsvector",
        expression:
          "to_tsvector('simple', coalesce(owner_text, '') || ' ' || coalesce(takeaway, ''))",
        stored: true,
      },
    ]);
    expect(TASK_EVENTS_SEARCH_INDEXES).toEqual([
      {
        name: "idx_task_events_fts",
        method: "gin",
        columns: ["search_tsv"],
      },
      {
        name: "idx_task_events_trgm",
        method: "gin",
        columns: ["owner_text"],
        operatorClass: "gin_trgm_ops",
      },
      {
        name: "idx_task_events_embedding",
        method: "hnsw",
        columns: ["embedding"],
        operatorClass: "vector_cosine_ops",
        with: {
          m: 16,
          ef_construction: 64,
        },
      },
    ]);
  });

  it("应提供包含 Brain（长期记忆）高级 PG（关系型数据库）结构的 migration（迁移） SQL（结构化查询语言）", () => {
    const migrationSql = readFileSync(
      new URL("../db/migrations/0000_brain_schema.sql", import.meta.url),
      "utf8",
    );
    const journal = JSON.parse(
      readFileSync(new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8"),
    );

    expect(journal.entries).toEqual([
      expect.objectContaining({
        idx: 0,
        tag: "0000_brain_schema",
        breakpoints: true,
      }),
    ]);
    for (const tableName of MC_SERVANT_TABLE_NAMES) {
      expect(migrationSql).toContain(`CREATE TABLE "mc_servant"."${tableName}"`);
    }
    expect(migrationSql.indexOf('CREATE TABLE "mc_servant"."owners"')).toBeLessThan(
      migrationSql.indexOf('CREATE TABLE "mc_servant"."owner_bots"'),
    );
    expect(migrationSql.indexOf('CREATE TABLE "mc_servant"."bots"')).toBeLessThan(
      migrationSql.indexOf('CREATE TABLE "mc_servant"."task_history"'),
    );
    expect(migrationSql.indexOf('CREATE TABLE "mc_servant"."task_history"')).toBeLessThan(
      migrationSql.indexOf('CREATE TABLE "mc_servant"."task_events"'),
    );
    expect(migrationSql).toContain('CREATE TABLE "mc_servant"."task_events"');
    expect(migrationSql).toContain('CREATE TABLE "mc_servant"."bot_rolling_summary"');
    expect(migrationSql).toContain('CREATE TABLE "mc_servant"."bot_memory"');
    expect(migrationSql).toContain('CREATE TABLE "mc_servant"."memory_candidates"');
    expect(migrationSql).toContain('CREATE TABLE "mc_servant"."memory_audit"');
    expect(migrationSql).toContain('"search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector');
    expect(migrationSql).toContain(
      'CREATE INDEX "idx_task_events_trgm" ON "mc_servant"."task_events" USING gin ("owner_text" gin_trgm_ops)',
    );
    expect(migrationSql).toContain(
      'CREATE INDEX "idx_task_events_embedding" ON "mc_servant"."task_events" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT "bot_memory_bot_id_kind_pk" PRIMARY KEY("bot_id","kind")',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT "memory_candidates_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1)',
    );
    expect(migrationSql).toContain(
      "CONSTRAINT \"memory_audit_op_check\" CHECK (\"op\" IN ('insert', 'patch', 'merge', 'replace', 'delete'))",
    );
  });

  it("应创建只读 task_summaries（任务摘要） 草案并拒绝 discarded（已丢弃） 与空摘要", () => {
    const draft = createTaskSummaryDraft({
      task_id: "msg-summary-1",
      bot_id: "bot-data",
      message_id: "msg-summary-1",
      intent: "挖掘煤矿",
      status: TaskHistoryStatus.Completed,
      summary: "任务完成，Bot 挖到了目标方块并返回空闲状态。",
      log_ref: "tasks/2026-04-26/msg-summary-1.jsonl",
      embedding: [0.1, 0.2],
      created_at: "2026-04-26T00:00:00.000Z",
    });

    expect(draft.id).toBe("task-summary:bot-data:msg-summary-1");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.embedding)).toBe(true);
    expect(() =>
      createTaskSummaryDraft({
        task_id: "msg-summary-2",
        bot_id: "bot-data",
        message_id: "msg-summary-2",
        intent: "过期任务",
        status: TaskHistoryStatus.Discarded,
        summary: "不应写入",
        created_at: "2026-04-26T00:00:00.000Z",
      }),
    ).toThrow(/completed, failed, or interrupted/);
    expect(() =>
      createTaskSummaryDraft({
        task_id: "msg-summary-3",
        bot_id: "bot-data",
        message_id: "msg-summary-3",
        intent: "空摘要",
        status: TaskHistoryStatus.Failed,
        summary: "   ",
        created_at: "2026-04-26T00:00:00.000Z",
      }),
    ).toThrow(/summary must be a non-empty string/);
  });

  it("应从任务历史和 JSONL（结构化日志） 输入生成确定性兜底摘要", () => {
    const source = createTaskSummarySource({
      bot_id: "bot-data",
      task_id: "msg-source-1",
      message_id: "msg-source-1",
      intent_epoch: 3,
      status: TaskHistoryStatus.Failed,
      intent: "前往坐标",
      log_ref: "sandbox/2026-04-26/msg-source-1.jsonl",
      created_at: "2026-04-26T00:00:00.000Z",
      terminal_detail: "path not found",
      jsonl_excerpt: ["facade_result goTo err", "sandbox_done"],
    });

    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.jsonl_excerpt)).toBe(true);
    expect(createDeterministicTaskSummaryText(source)).toContain(
      "任务 msg-source-1 以 failed 结束",
    );
    expect(createDeterministicTaskSummaryText(source)).toContain("facade_result goTo err");
  });

  it("应按 score（分数） / created_at（创建时间） 稳定拼接 memory（记忆）上下文并支持预算截断", () => {
    const older = createTaskSummaryDraft({
      task_id: "msg-memory-old",
      bot_id: "bot-data",
      message_id: "msg-memory-old",
      intent: "旧任务",
      status: TaskHistoryStatus.Completed,
      summary: "旧摘要",
      created_at: "2026-04-25T00:00:00.000Z",
    });
    const newer = createTaskSummaryDraft({
      task_id: "msg-memory-new",
      bot_id: "bot-data",
      message_id: "msg-memory-new",
      intent: "新任务",
      status: TaskHistoryStatus.Interrupted,
      summary: "新摘要内容较长",
      created_at: "2026-04-26T00:00:00.000Z",
    });

    expect(
      createMemoryContextFromTaskSummaries({
        results: [
          { summary: older, score: 0.5 },
          { summary: newer, score: 0.9 },
        ],
        limit: 1,
        char_budget: 120,
      }),
    ).toBe("[interrupted] 新任务: 新摘要内容较长");
    expect(
      createMemoryContextFromTaskSummaries({
        results: [{ summary: newer, score: 0.9 }],
        limit: 5,
        char_budget: 18,
      }),
    ).toBe("[interrupted] 新任务…");
  });
});
