import json
import time
from pathlib import Path
from typing import Any, Optional


class LlmTranscriptWriter:
    """可读留痕：负责将 LLM 的全量对话（Prompt/Response/Parse）以人类可直接阅读的格式追加到本地文本文件。"""

    def __init__(self, path: str):
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _json_text(value: Any) -> Optional[str]:
        if value is None:
            return None
        return json.dumps(value, ensure_ascii=False, sort_keys=True)

    def append(
        self,
        *,
        run_id: str,
        thread_id: str,
        node_name: str,
        call_seq: int,
        prompt_name: str,
        provider: str,
        model_name: str,
        request_messages: list[dict[str, Any]],
        rendered_prompt_text: str,
        raw_response_text: Optional[str],
        parsed_output: Optional[dict[str, Any]],
        parse_ok: bool,
        parse_error: Optional[str],
        latency_ms: Optional[int],
    ) -> None:
        """文本追加：按固定模板生成一次调用的完整上下文块并写入文件。"""
        created_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        blocks = [
            "=" * 100,
            f"time: {created_at}",
            f"run_id: {run_id}",
            f"thread_id: {thread_id}",
            f"node_name: {node_name}",
            f"call_seq: {call_seq}",
            f"prompt_name: {prompt_name}",
            f"provider: {provider}",
            f"model_name: {model_name}",
            f"latency_ms: {latency_ms if latency_ms is not None else ''}",
            "",
            "[request_messages_json]",
            self._json_text(request_messages) or "[]",
            "",
            "[rendered_prompt_text]",
            rendered_prompt_text or "",
            "",
            "[raw_response_text]",
            raw_response_text or "",
            "",
            "[parsed_output_json]",
            self._json_text(parsed_output) or "null",
            "",
            f"[parse_ok] {parse_ok}",
            f"[parse_error] {parse_error or ''}",
            "",
        ]
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write("\n".join(blocks))
