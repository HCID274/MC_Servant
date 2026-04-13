import json
import sqlite3
import threading
import time
from typing import Any, Optional


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class TraceRepository:
    """数据持久化：负责 Trace 数据的原子化读写，实现全链路执行留痕。定位为纯 DAO，不涉及连接管理或模式定义。"""

    def __init__(self, *, conn: sqlite3.Connection, lock: threading.RLock):
        self._conn = conn
        self._lock = lock

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
        """任务登记：在指令进入执行流前，初始化持久化的运行记录。"""
        started_at = _now_ms()
        with self._lock:
            self._conn.execute(
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
            self._conn.commit()

    def record_llm_call(
        self,
        *,
        run_id: str,
        thread_id: str,
        node_name: str,
        call_seq: int,
        prompt_name: str,
        provider: str,
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
        """模型审计：持久化单次 LLM 调用及其解析结果，供后续效果评估与调试。"""
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO llm_call (
                    run_id,
                    thread_id,
                    node_name,
                    call_seq,
                    prompt_name,
                    provider,
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    thread_id,
                    node_name,
                    call_seq,
                    prompt_name,
                    provider,
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
            self._conn.commit()

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
        """节点打点：记录执行流中的关键里程碑事件。"""
        with self._lock:
            self._conn.execute(
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
            self._conn.commit()

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
        """状态同步：在流程结束或产生阶段性产出时，更新运行记录。"""
        finished_at = _now_ms()
        with self._lock:
            current = self._conn.execute(
                "SELECT started_at FROM agent_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            started_at = int(current["started_at"]) if current else finished_at
            duration_ms = max(0, finished_at - started_at)
            self._conn.execute(
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
            self._conn.commit()

    def record_step_summary(
        self,
        *,
        summary_id: str,
        run_id: str,
        thread_id: str,
        step_index: int,
        action: str,
        target: Optional[str],
        kind: str,
        summary_text: str,
        summary_input: Optional[dict[str, Any]],
        detail_ref: Optional[dict[str, Any]],
    ) -> None:
        """摘要存档：保存单步任务执行的语义摘要，用于上下文压缩与记忆读取。"""
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO step_summary (
                    summary_id,
                    run_id,
                    thread_id,
                    step_index,
                    action,
                    target,
                    kind,
                    summary_text,
                    summary_input_json,
                    detail_ref_json,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    summary_id,
                    run_id,
                    thread_id,
                    step_index,
                    action,
                    target,
                    kind,
                    summary_text,
                    _json_text(summary_input),
                    _json_text(detail_ref),
                    _now_ms(),
                ),
            )
            self._conn.commit()

    def list_step_summaries(self, thread_id: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """历史回溯：按线程检索最近的执行摘要，供 Planning 层对齐上下文。"""
        rows = self._conn.execute(
            """
            SELECT summary_id, run_id, thread_id, step_index, action, target, kind,
                   summary_text, summary_input_json, detail_ref_json, created_at
            FROM step_summary
            WHERE thread_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (thread_id, max(1, limit)),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in reversed(rows):
            items.append(
                {
                    "summary_id": row["summary_id"],
                    "run_id": row["run_id"],
                    "thread_id": row["thread_id"],
                    "step_index": row["step_index"],
                    "action": row["action"],
                    "target": row["target"],
                    "kind": row["kind"],
                    "summary_text": row["summary_text"],
                    "summary_input": json.loads(row["summary_input_json"]) if row["summary_input_json"] else None,
                    "detail_ref": json.loads(row["detail_ref_json"]) if row["detail_ref_json"] else None,
                    "created_at": row["created_at"],
                }
            )
        return items

    def get_agent_run(self, run_id: str) -> Optional[dict[str, Any]]:
        """档案读取：检索特定任务的完整执行上下文。"""
        row = self._conn.execute(
            """
            SELECT run_id, thread_id, client_id, bot_name, player_name, source_type,
                   request_type, user_input, request_payload_json, env_snapshot_json,
                   status, intent, reply_text, error_code, error_message,
                   latest_checkpoint_id, checkpoint_count, workflow_name,
                   workflow_version, started_at, finished_at, duration_ms
            FROM agent_run
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "run_id": row["run_id"],
            "thread_id": row["thread_id"],
            "client_id": row["client_id"],
            "bot_name": row["bot_name"],
            "player_name": row["player_name"],
            "source_type": row["source_type"],
            "request_type": row["request_type"],
            "user_input": row["user_input"],
            "request_payload": json.loads(row["request_payload_json"]) if row["request_payload_json"] else None,
            "env_snapshot": json.loads(row["env_snapshot_json"]) if row["env_snapshot_json"] else None,
            "status": row["status"],
            "intent": row["intent"],
            "reply_text": row["reply_text"],
            "error_code": row["error_code"],
            "error_message": row["error_message"],
            "latest_checkpoint_id": row["latest_checkpoint_id"],
            "checkpoint_count": row["checkpoint_count"],
            "workflow_name": row["workflow_name"],
            "workflow_version": row["workflow_version"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "duration_ms": row["duration_ms"],
        }

    def list_runs_by_thread(self, thread_id: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """序列检索：按线程拉取执行生命线上的最近多次任务记录。"""
        rows = self._conn.execute(
            """
            SELECT run_id, thread_id, bot_name, player_name, source_type, request_type,
                   user_input, status, intent, reply_text, error_code, error_message,
                   latest_checkpoint_id, checkpoint_count, started_at, finished_at, duration_ms
            FROM agent_run
            WHERE thread_id = ?
            ORDER BY started_at DESC
            LIMIT ?
            """,
            (thread_id, max(1, limit)),
        ).fetchall()
        items: list[dict[str, Any]] = []
        for row in reversed(rows):
            items.append(
                {
                    "run_id": row["run_id"],
                    "thread_id": row["thread_id"],
                    "bot_name": row["bot_name"],
                    "player_name": row["player_name"],
                    "source_type": row["source_type"],
                    "request_type": row["request_type"],
                    "user_input": row["user_input"],
                    "status": row["status"],
                    "intent": row["intent"],
                    "reply_text": row["reply_text"],
                    "error_code": row["error_code"],
                    "error_message": row["error_message"],
                    "latest_checkpoint_id": row["latest_checkpoint_id"],
                    "checkpoint_count": row["checkpoint_count"],
                    "started_at": row["started_at"],
                    "finished_at": row["finished_at"],
                    "duration_ms": row["duration_ms"],
                }
            )
        return items

    def list_run_events(
        self,
        run_id: str,
        *,
        step_index: Optional[int] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """事件流水：检索特定任务或步骤的执行详情（打点序列）。"""
        if step_index is None:
            rows = self._conn.execute(
                """
                SELECT id, run_id, thread_id, stage, event_name, node_name, step_index, payload_json, created_at
                FROM run_event
                WHERE run_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (run_id, max(1, limit)),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT id, run_id, thread_id, stage, event_name, node_name, step_index, payload_json, created_at
                FROM run_event
                WHERE run_id = ? AND step_index = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (run_id, step_index, max(1, limit)),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "run_id": row["run_id"],
                "thread_id": row["thread_id"],
                "stage": row["stage"],
                "event_name": row["event_name"],
                "node_name": row["node_name"],
                "step_index": row["step_index"],
                "payload": json.loads(row["payload_json"]) if row["payload_json"] else None,
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def list_llm_calls(
        self,
        run_id: str,
        *,
        node_name: Optional[str] = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """调用追踪：拉取单次任务中的模型对话明细，用于排查逻辑偏差。"""
        if node_name:
            rows = self._conn.execute(
                """
                SELECT id, run_id, thread_id, node_name, call_seq, prompt_name, model_name,
                       provider, base_url, request_messages_json, rendered_prompt_text,
                       prompt_sha256, raw_response_text, parsed_output_json, parse_ok,
                       parse_error, usage_json, latency_ms, created_at
                FROM llm_call
                WHERE run_id = ? AND node_name = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (run_id, node_name, max(1, limit)),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT id, run_id, thread_id, node_name, call_seq, prompt_name, model_name,
                       provider, base_url, request_messages_json, rendered_prompt_text,
                       prompt_sha256, raw_response_text, parsed_output_json, parse_ok,
                       parse_error, usage_json, latency_ms, created_at
                FROM llm_call
                WHERE run_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?
                """,
                (run_id, max(1, limit)),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "run_id": row["run_id"],
                "thread_id": row["thread_id"],
                "node_name": row["node_name"],
                "call_seq": row["call_seq"],
                "prompt_name": row["prompt_name"],
                "model_name": row["model_name"],
                "provider": row["provider"],
                "base_url": row["base_url"],
                "request_messages": json.loads(row["request_messages_json"]) if row["request_messages_json"] else [],
                "rendered_prompt_text": row["rendered_prompt_text"],
                "prompt_sha256": row["prompt_sha256"],
                "raw_response_text": row["raw_response_text"],
                "parsed_output": json.loads(row["parsed_output_json"]) if row["parsed_output_json"] else None,
                "parse_ok": bool(row["parse_ok"]),
                "parse_error": row["parse_error"],
                "usage": json.loads(row["usage_json"]) if row["usage_json"] else None,
                "latency_ms": row["latency_ms"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def get_step_summary(self, summary_id: str) -> Optional[dict[str, Any]]:
        """语义摘要读取：按 ID 获取单条执行摘要。"""
        row = self._conn.execute(
            """
            SELECT summary_id, run_id, thread_id, step_index, action, target, kind,
                   summary_text, summary_input_json, detail_ref_json, created_at
            FROM step_summary
            WHERE summary_id = ?
            """,
            (summary_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "summary_id": row["summary_id"],
            "run_id": row["run_id"],
            "thread_id": row["thread_id"],
            "step_index": row["step_index"],
            "action": row["action"],
            "target": row["target"],
            "kind": row["kind"],
            "summary_text": row["summary_text"],
            "summary_input": json.loads(row["summary_input_json"]) if row["summary_input_json"] else None,
            "detail_ref": json.loads(row["detail_ref_json"]) if row["detail_ref_json"] else None,
            "created_at": row["created_at"],
        }
