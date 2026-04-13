import sqlite3
import threading
from pathlib import Path
from typing import Optional

from .schema import (
    AGENT_RUN_TABLE_SQL,
    LLM_CALL_TABLE_SQL,
    RUN_EVENT_TABLE_SQL,
    STEP_SUMMARY_TABLE_SQL,
)


class TraceStorageManager:
    """物理层管理：负责 Trace 数据库（SQLite）的连接生命周期、建表自修复与 WAL 性能优化。"""

    def __init__(self, db_path: str):
        self._db_path = Path(db_path)
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock()

    @property
    def lock(self) -> threading.RLock:
        """读写互斥锁：确保 SQLite 多线程环境下持久化的线程安全。"""
        return self._lock

    def open(self) -> sqlite3.Connection:
        """开启仓储：初始化连接池与 WAL 模式，并执行 Schema 同步。"""
        if self._conn is not None:
            return self._conn

        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._initialize_schema()
        return self._conn

    def close(self) -> None:
        """关闭仓储：安全回收数据库连接。"""
        with self._lock:
            if self._conn is None:
                return
            self._conn.close()
            self._conn = None

    def require_conn(self) -> sqlite3.Connection:
        """连接断言：确保在进行 DAO 读写前物理连接已就绪。"""
        if self._conn is None:
            raise RuntimeError("TraceStorageManager is not opened")
        return self._conn

    def _initialize_schema(self) -> None:
        """结构初始化：创建任务记录主表、审计日志及语义索引，并执行自动迁移。"""
        conn = self.require_conn()
        self._migrate_agent_run_table(conn)
        self._repair_agent_run_foreign_keys(conn)
        with self._lock:
            conn.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS agent_run (
                    run_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    client_id TEXT NOT NULL,
                    bot_name TEXT NOT NULL,
                    player_name TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    request_type TEXT NOT NULL DEFAULT 'player_message',
                    user_input TEXT NOT NULL,
                    request_payload_json TEXT NOT NULL,
                    env_snapshot_json TEXT,
                    status TEXT NOT NULL,
                    intent TEXT,
                    reply_text TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    latest_checkpoint_id TEXT,
                    checkpoint_count INTEGER NOT NULL DEFAULT 0,
                    workflow_name TEXT NOT NULL DEFAULT 'main_workflow',
                    workflow_version TEXT,
                    started_at INTEGER NOT NULL,
                    finished_at INTEGER,
                    duration_ms INTEGER
                );

                CREATE INDEX IF NOT EXISTS idx_agent_run_status_started
                ON agent_run(status, started_at DESC);

                {self._if_not_exists(LLM_CALL_TABLE_SQL)}

                CREATE INDEX IF NOT EXISTS idx_llm_call_run_seq
                ON llm_call(run_id, call_seq);

                {self._if_not_exists(RUN_EVENT_TABLE_SQL)}

                CREATE INDEX IF NOT EXISTS idx_run_event_run_time
                ON run_event(run_id, created_at);

                {self._if_not_exists(STEP_SUMMARY_TABLE_SQL)}

                CREATE INDEX IF NOT EXISTS idx_step_summary_thread_time
                ON step_summary(thread_id, created_at DESC);
                """
            )
            conn.commit()

    @staticmethod
    def _if_not_exists(create_sql: str) -> str:
        return create_sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)

    def _migrate_agent_run_table(self, conn: sqlite3.Connection) -> None:
        """历史迁移：处理特定版本的字段变更（如 thread_id 约束放宽）。"""
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_run'"
        ).fetchone()
        if row is None:
            return

        create_sql = str(row["sql"] or "")
        if "thread_id TEXT NOT NULL UNIQUE" not in create_sql:
            return

        with self._lock:
            conn.execute("PRAGMA foreign_keys=OFF;")
            conn.execute("ALTER TABLE agent_run RENAME TO agent_run_legacy;")
            conn.execute(AGENT_RUN_TABLE_SQL)
            conn.execute(
                """
                INSERT INTO agent_run (
                    run_id,
                    thread_id,
                    client_id,
                    bot_name,
                    player_name,
                    source_type,
                    request_type,
                    user_input,
                    request_payload_json,
                    env_snapshot_json,
                    status,
                    intent,
                    reply_text,
                    error_code,
                    error_message,
                    latest_checkpoint_id,
                    checkpoint_count,
                    workflow_name,
                    workflow_version,
                    started_at,
                    finished_at,
                    duration_ms
                )
                SELECT
                    run_id,
                    thread_id,
                    client_id,
                    bot_name,
                    player_name,
                    source_type,
                    request_type,
                    user_input,
                    request_payload_json,
                    env_snapshot_json,
                    status,
                    intent,
                    reply_text,
                    error_code,
                    error_message,
                    latest_checkpoint_id,
                    checkpoint_count,
                    workflow_name,
                    workflow_version,
                    started_at,
                    finished_at,
                    duration_ms
                FROM agent_run_legacy;
                """
            )
            self._rebuild_trace_table(
                conn,
                table_name="llm_call",
                create_sql=LLM_CALL_TABLE_SQL,
                column_names=(
                    "id",
                    "run_id",
                    "thread_id",
                    "node_name",
                    "call_seq",
                    "prompt_name",
                    "model_name",
                    "provider",
                    "base_url",
                    "request_messages_json",
                    "rendered_prompt_text",
                    "prompt_sha256",
                    "raw_response_text",
                    "parsed_output_json",
                    "parse_ok",
                    "parse_error",
                    "usage_json",
                    "latency_ms",
                    "created_at",
                ),
            )
            self._rebuild_trace_table(
                conn,
                table_name="run_event",
                create_sql=RUN_EVENT_TABLE_SQL,
                column_names=(
                    "id",
                    "run_id",
                    "thread_id",
                    "stage",
                    "event_name",
                    "node_name",
                    "step_index",
                    "payload_json",
                    "created_at",
                ),
            )
            self._rebuild_trace_table(
                conn,
                table_name="step_summary",
                create_sql=STEP_SUMMARY_TABLE_SQL,
                column_names=(
                    "id",
                    "summary_id",
                    "run_id",
                    "thread_id",
                    "step_index",
                    "action",
                    "target",
                    "kind",
                    "summary_text",
                    "summary_input_json",
                    "detail_ref_json",
                    "created_at",
                ),
            )
            conn.execute("DROP TABLE IF EXISTS agent_run_legacy;")
            conn.execute("PRAGMA foreign_keys=ON;")
            conn.commit()

    def _repair_agent_run_foreign_keys(self, conn: sqlite3.Connection) -> None:
        """外键修复：自动对齐旧表重命名后丢失的外键关联。"""
        tables_to_repair = (
            (
                "llm_call",
                LLM_CALL_TABLE_SQL,
                (
                    "id",
                    "run_id",
                    "thread_id",
                    "node_name",
                    "call_seq",
                    "prompt_name",
                    "model_name",
                    "provider",
                    "base_url",
                    "request_messages_json",
                    "rendered_prompt_text",
                    "prompt_sha256",
                    "raw_response_text",
                    "parsed_output_json",
                    "parse_ok",
                    "parse_error",
                    "usage_json",
                    "latency_ms",
                    "created_at",
                ),
            ),
            (
                "run_event",
                RUN_EVENT_TABLE_SQL,
                (
                    "id",
                    "run_id",
                    "thread_id",
                    "stage",
                    "event_name",
                    "node_name",
                    "step_index",
                    "payload_json",
                    "created_at",
                ),
            ),
            (
                "step_summary",
                STEP_SUMMARY_TABLE_SQL,
                (
                    "id",
                    "summary_id",
                    "run_id",
                    "thread_id",
                    "step_index",
                    "action",
                    "target",
                    "kind",
                    "summary_text",
                    "summary_input_json",
                    "detail_ref_json",
                    "created_at",
                ),
            ),
        )

        with self._lock:
            conn.execute("PRAGMA foreign_keys=OFF;")
            repaired = False
            for table_name, create_sql, column_names in tables_to_repair:
                row = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table_name,),
                ).fetchone()
                table_sql = str(row["sql"] or "") if row is not None else ""
                if "agent_run_legacy" not in table_sql:
                    continue
                self._rebuild_trace_table(
                    conn,
                    table_name=table_name,
                    create_sql=create_sql,
                    column_names=column_names,
                )
                repaired = True
            conn.execute("DROP TABLE IF EXISTS agent_run_legacy;")
            conn.execute("PRAGMA foreign_keys=ON;")
            if repaired:
                conn.commit()

    def _rebuild_trace_table(
        self,
        conn: sqlite3.Connection,
        *,
        table_name: str,
        create_sql: str,
        column_names: tuple[str, ...],
    ) -> None:
        """表重塑器：在保留数据的前提下重新物理创建表，用于修复复杂的结构约束变更。"""
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        if row is None:
            return

        legacy_table_name = f"{table_name}_legacy"
        conn.execute(f"DROP TABLE IF EXISTS {legacy_table_name}")
        conn.execute(f"ALTER TABLE {table_name} RENAME TO {legacy_table_name};")
        conn.execute(create_sql)
        column_list = ", ".join(column_names)
        conn.execute(
            f"""
            INSERT INTO {table_name} ({column_list})
            SELECT {column_list}
            FROM {legacy_table_name};
            """
        )
        conn.execute(f"DROP TABLE {legacy_table_name};")
