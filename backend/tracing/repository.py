import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional


def _now_ms() -> int:
    """时间戳工具：获取当前毫秒级时间戳，用于精确计算延迟。"""
    return int(time.time() * 1000)


def _json_text(value: Any) -> Optional[str]:
    """序列化工具：将字典对象安全地转换为 JSON 字符串，并处理 None 值。"""
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class TraceRepository:
    """运行留痕仓储：将 run/llm/event 审计信息写入本地 SQLite，实现全链路可追溯。"""

    def __init__(self, db_path: str):
        self._db_path = Path(db_path)
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.RLock() # 数据库写操作排他锁

    def open(self) -> None:
        """数据库开启：初始化 SQLite 连接并配置 WAL 模式以提升并发性能。"""
        if self._conn is not None:
            return

        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._initialize_schema()

    def close(self) -> None:
        """资源回收：安全关闭数据库连接。"""
        with self._lock:
            if self._conn is None:
                return
            self._conn.close()
            self._conn = None

    def _initialize_schema(self) -> None:
        """表结构定义：创建 agent_run (请求主表)、llm_call (模型日志) 及 run_event (逻辑打点) 表。"""
        conn = self._require_conn()
        with self._lock:
            conn.executescript(
                """
                -- 记录一次完整的指令请求
                CREATE TABLE IF NOT EXISTS agent_run (
                    run_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL UNIQUE,
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

                -- 记录大模型调用明细
                CREATE TABLE IF NOT EXISTS llm_call (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    node_name TEXT NOT NULL,
                    call_seq INTEGER NOT NULL,
                    prompt_name TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    provider TEXT NOT NULL DEFAULT 'openai_compatible',
                    base_url TEXT,
                    request_messages_json TEXT NOT NULL,
                    rendered_prompt_text TEXT NOT NULL,
                    prompt_sha256 TEXT,
                    raw_response_text TEXT,
                    parsed_output_json TEXT,
                    parse_ok INTEGER NOT NULL DEFAULT 0,
                    parse_error TEXT,
                    usage_json TEXT,
                    latency_ms INTEGER,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES agent_run(run_id)
                );

                CREATE INDEX IF NOT EXISTS idx_llm_call_run_seq
                ON llm_call(run_id, call_seq);

                -- 记录细粒度的逻辑执行点
                CREATE TABLE IF NOT EXISTS run_event (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    thread_id TEXT,
                    stage TEXT NOT NULL,
                    event_name TEXT NOT NULL,
                    node_name TEXT,
                    step_index INTEGER,
                    payload_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(run_id) REFERENCES agent_run(run_id)
                );

                CREATE INDEX IF NOT EXISTS idx_run_event_run_time
                ON run_event(run_id, created_at);
                """
            )
            conn.commit()

    def _require_conn(self) -> sqlite3.Connection:
        """连接完整性检查：确保在执行 SQL 前数据库已开启。"""
        if self._conn is None:
            raise RuntimeError("TraceRepository is not opened")
        return self._conn

    def record_run_started(
        self,
        *,
        run_id: str,
        thread_id: str,
        client_id: str,
        bot_name: str,
        player_name: str,
        source_type: str,
        request_type: str,
        user_input: str,
        request_payload: dict[str, Any],
        env_snapshot: Optional[dict[str, Any]],
        workflow_version: Optional[str],
    ) -> None:
        """请求登记：在指令进入大脑前，初始化一条运行记录。"""
        conn = self._require_conn()
        started_at = _now_ms()
        with self._lock:
            conn.execute(
                """
                INSERT OR REPLACE INTO agent_run (
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
                    workflow_version,
                    started_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    thread_id,
                    client_id,
                    bot_name,
                    player_name,
                    source_type,
                    request_type,
                    user_input,
                    _json_text(request_payload),
                    _json_text(env_snapshot),
                    "running",
                    workflow_version,
                    started_at,
                ),
            )
            conn.commit()

    def record_llm_call(
        self,
        *,
        run_id: str,
        thread_id: str,
        node_name: str,
        call_seq: int,
        prompt_name: str,
        model_name: str,
        base_url: str,
        request_messages: list[dict[str, Any]],
        rendered_prompt_text: str,
        prompt_sha256: str,
        raw_response_text: Optional[str],
        parsed_output: Optional[dict[str, Any]],
        parse_ok: bool,
        parse_error: Optional[str],
        usage: Optional[dict[str, Any]],
        latency_ms: Optional[int],
    ) -> None:
        """模型日志：持久化一次具体的 LLM 调用及其解析结果。"""
        conn = self._require_conn()
        with self._lock:
            conn.execute(
                """
                INSERT INTO llm_call (
                    run_id,
                    thread_id,
                    node_name,
                    call_seq,
                    prompt_name,
                    model_name,
                    base_url,
                    request_messages_json,
                    rendered_prompt_text,
                    prompt_sha256,
                    raw_response_text,
                    parsed_output_json,
                    parse_ok,
                    parse_error,
                    usage_json,
                    latency_ms,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    thread_id,
                    node_name,
                    call_seq,
                    prompt_name,
                    model_name,
                    base_url,
                    _json_text(request_messages) or "[]",
                    rendered_prompt_text,
                    prompt_sha256,
                    raw_response_text,
                    _json_text(parsed_output),
                    1 if parse_ok else 0,
                    parse_error,
                    _json_text(usage),
                    latency_ms,
                    _now_ms(),
                ),
            )
            conn.commit()

    def record_event(
        self,
        *,
        run_id: str,
        thread_id: Optional[str],
        stage: str,
        event_name: str,
        payload: Optional[dict[str, Any]] = None,
        node_name: Optional[str] = None,
        step_index: Optional[int] = None,
    ) -> None:
        """逻辑打点：记录执行过程中的里程碑事件（如：任务入队、任务完成）。"""
        conn = self._require_conn()
        with self._lock:
            conn.execute(
                """
                INSERT INTO run_event (
                    run_id,
                    thread_id,
                    stage,
                    event_name,
                    node_name,
                    step_index,
                    payload_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    thread_id,
                    stage,
                    event_name,
                    node_name,
                    step_index,
                    _json_text(payload),
                    _now_ms(),
                ),
            )
            conn.commit()

    def update_run(
        self,
        run_id: str,
        *,
        status: Optional[str] = None,
        intent: Optional[str] = None,
        reply_text: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        latest_checkpoint_id: Optional[str] = None,
        checkpoint_count: Optional[int] = None,
    ) -> None:
        """运行更新：在流程结束或异常时，更新状态、耗时及产生的输出。"""
        conn = self._require_conn()
        finished_at = _now_ms()

        with self._lock:
            current = conn.execute(
                "SELECT started_at FROM agent_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            started_at = int(current["started_at"]) if current else finished_at
            duration_ms = max(0, finished_at - started_at)

            conn.execute(
                """
                UPDATE agent_run
                SET status = COALESCE(?, status),
                    intent = COALESCE(?, intent),
                    reply_text = COALESCE(?, reply_text),
                    error_code = COALESCE(?, error_code),
                    error_message = COALESCE(?, error_message),
                    latest_checkpoint_id = COALESCE(?, latest_checkpoint_id),
                    checkpoint_count = COALESCE(?, checkpoint_count),
                    finished_at = ?,
                    duration_ms = ?
                WHERE run_id = ?
                """,
                (
                    status,
                    intent,
                    reply_text,
                    error_code,
                    error_message,
                    latest_checkpoint_id,
                    checkpoint_count,
                    finished_at,
                    duration_ms,
                    run_id,
                ),
            )
            conn.commit()
