import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOGS_BASE_DIR,
  EVENT_LOG_RETENTION_DAYS,
  ExecutionTaskKind,
  JSONL_DIRECTORY_POLICIES,
  JSONL_RETENTION_DAYS,
  MC_SERVANT_SCHEMA_NAME,
  MC_SERVANT_TABLE_NAMES,
  PERSISTED_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  SESSIONS_TOKEN_INDEX_CONTRACT,
  SESSION_SUMMARIES_GENERATED_COLUMNS,
  SESSION_SUMMARIES_SEARCH_INDEXES,
  TASK_HISTORY_STATUS_VALUES,
  TASK_SUMMARIES_GENERATED_COLUMNS,
  TASK_SUMMARIES_SEARCH_INDEXES,
  TaskHistoryStatus,
  createDatedStorageRef,
  eventLogTable,
  isValidStorageRef,
  mcServantTables,
  taskHistoryTable,
} from "../index.js";

describe("data 持久化契约", () => {
  it("应声明 mc_servant 核心表结构出口", () => {
    expect(MC_SERVANT_SCHEMA_NAME).toBe("mc_servant");
    expect(MC_SERVANT_TABLE_NAMES).toHaveLength(9);
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
    expect(TASK_HISTORY_STATUS_VALUES).toEqual([
      TaskHistoryStatus.Accepted,
      TaskHistoryStatus.Started,
      TaskHistoryStatus.Completed,
      TaskHistoryStatus.Failed,
      TaskHistoryStatus.Interrupted,
      TaskHistoryStatus.Discarded,
    ]);
    expect(ExecutionTaskKind.SkillCall).toBe("skill_call");
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
    expect(EVENT_LOG_RETENTION_DAYS).toBe(30);
    expect(JSONL_RETENTION_DAYS.tasks).toBe(90);
    expect(JSONL_RETENTION_DAYS.llm).toBe(30);
    expect(JSONL_DIRECTORY_POLICIES.sandbox.refFields).toEqual(["log_ref", "code_ref"]);
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
});
