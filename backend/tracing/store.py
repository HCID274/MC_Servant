from typing import Any, Optional

from .storage.manager import TraceStorageManager
from .storage.repository import TraceRepository
from .storage.transcript_writer import LlmTranscriptWriter


class TraceStore:
    """追踪门面：对外暴露统一的追踪接口，内部协调物理存储、DAO 与人类可读日志的同步写入。"""

    def __init__(self, db_path: str, *, llm_text_log_path: Optional[str] = None):
        self._storage = TraceStorageManager(db_path)
        self._repo: Optional[TraceRepository] = None
        self._transcript_writer = (
            LlmTranscriptWriter(llm_text_log_path) if llm_text_log_path else None
        )

    def open(self) -> None:
        """资源就绪：开启底层物理存储并初始化数据访问对象。"""
        conn = self._storage.open()
        self._repo = TraceRepository(conn=conn, lock=self._storage.lock)

    def close(self) -> None:
        """资源释放：关闭追踪组件，确保数据刷盘。"""
        self._repo = None
        self._storage.close()

    def _require_repo(self) -> TraceRepository:
        """DAO 校验：确保在调用接口前追踪器已正常开启。"""
        if self._repo is None:
            raise RuntimeError("TraceStore is not opened")
        return self._repo

    def record_run_started(self, **kwargs: Any) -> None:
        """记录任务启动。"""
        self._require_repo().record_run_started(**kwargs)

    def record_llm_call(self, **kwargs: Any) -> None:
        """记录模型调用：同时写入数据库与本地可读文本日志。"""
        repo = self._require_repo()
        repo.record_llm_call(**kwargs)
        if self._transcript_writer is not None:
            self._transcript_writer.append(
                run_id=str(kwargs.get("run_id") or ""),
                thread_id=str(kwargs.get("thread_id") or ""),
                node_name=str(kwargs.get("node_name") or ""),
                call_seq=int(kwargs.get("call_seq") or 0),
                prompt_name=str(kwargs.get("prompt_name") or ""),
                provider=str(kwargs.get("provider") or ""),
                model_name=str(kwargs.get("model_name") or ""),
                request_messages=list(kwargs.get("request_messages") or []),
                rendered_prompt_text=str(kwargs.get("rendered_prompt_text") or ""),
                raw_response_text=kwargs.get("raw_response_text"),
                parsed_output=kwargs.get("parsed_output"),
                parse_ok=bool(kwargs.get("parse_ok")),
                parse_error=kwargs.get("parse_error"),
                latency_ms=kwargs.get("latency_ms"),
            )

    def record_event(self, **kwargs: Any) -> None:
        """记录逻辑事件。"""
        self._require_repo().record_event(**kwargs)

    def update_run(self, run_id: str, **kwargs: Any) -> None:
        """同步运行状态。"""
        self._require_repo().update_run(run_id, **kwargs)

    def record_step_summary(self, **kwargs: Any) -> None:
        """存档步骤摘要。"""
        self._require_repo().record_step_summary(**kwargs)

    def list_step_summaries(self, thread_id: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """检索历史摘要。"""
        return self._require_repo().list_step_summaries(thread_id, limit=limit)

    def get_agent_run(self, run_id: str) -> Optional[dict[str, Any]]:
        """拉取任务记录。"""
        return self._require_repo().get_agent_run(run_id)

    def list_runs_by_thread(self, thread_id: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """拉取线程历史。"""
        return self._require_repo().list_runs_by_thread(thread_id, limit=limit)

    def list_run_events(
        self,
        run_id: str,
        *,
        step_index: Optional[int] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """拉取事件流水。"""
        return self._require_repo().list_run_events(run_id, step_index=step_index, limit=limit)

    def list_llm_calls(
        self,
        run_id: str,
        *,
        node_name: Optional[str] = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """拉取模型记录。"""
        return self._require_repo().list_llm_calls(run_id, node_name=node_name, limit=limit)

    def get_step_summary(self, summary_id: str) -> Optional[dict[str, Any]]:
        """读取单条摘要。"""
        return self._require_repo().get_step_summary(summary_id)
