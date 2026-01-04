import json
import logging
import os
from typing import Optional


class LLMCallLogger:
    def __init__(self, log_path: str) -> None:
        self._logger = logging.getLogger("llm.calls")
        if not self._logger.handlers:
            log_dir = os.path.dirname(log_path)
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)
            handler = logging.FileHandler(log_path, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.INFO)
            self._logger.propagate = False
        self._log_path = log_path

    def log_call(
        self,
        *,
        provider: str,
        model: str,
        method: str,
        success: bool,
        latency_ms: float,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
        error: Optional[str] = None,
    ) -> None:
        payload = {
            "provider": provider,
            "model": model,
            "method": method,
            "success": success,
            "latency_ms": round(latency_ms, 2),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        }
        if error:
            payload["error"] = error
        self._logger.info(json.dumps(payload, ensure_ascii=False))


_logger_instance: Optional[LLMCallLogger] = None


def get_llm_call_logger(log_path: str) -> Optional[LLMCallLogger]:
    global _logger_instance
    if not log_path or not log_path.strip():
        return None
    if _logger_instance is None:
        _logger_instance = LLMCallLogger(log_path=log_path)
    return _logger_instance
