import json
import logging
import time
from typing import Optional, Tuple

from openai import AsyncOpenAI

from .call_logger import LLMCallLogger
from .interfaces import ILLMClient

logger = logging.getLogger(__name__)


class OpenRouterClient(ILLMClient):
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str = "https://openrouter.ai/api/v1",
        reasoning_enabled: bool = False,
        call_logger: Optional[LLMCallLogger] = None,
    ) -> None:
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
        )
        self._model = model
        self._reasoning_enabled = reasoning_enabled
        self._provider = "openrouter"
        self._call_logger = call_logger
        logger.info(f"OpenRouterClient initialized with model: {model}")

    @property
    def model_name(self) -> str:
        return self._model

    def _build_request_kwargs(self, **kwargs: object) -> dict:
        request_kwargs = dict(kwargs)
        if self._reasoning_enabled:
            request_kwargs["extra_body"] = {"reasoning": {"enabled": True}}
        return request_kwargs

    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> str:
        start = time.perf_counter()
        usage = None
        try:
            response = await self._client.chat.completions.create(
                **self._build_request_kwargs(
                    model=self._model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
            )
            usage = response.usage
            content = response.choices[0].message.content
            logger.debug(f"LLM response: {content[:100]}...")
            self._log_call("chat", True, start, usage, None)
            return content
        except Exception as e:
            self._log_call("chat", False, start, usage, str(e))
            logger.error(f"OpenRouterClient.chat failed: {e}")
            raise

    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
    ) -> dict:
        start = time.perf_counter()
        usage = None
        try:
            response = await self._client.chat.completions.create(
                **self._build_request_kwargs(
                    model=self._model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    response_format={"type": "json_object"},
                )
            )
            usage = response.usage
            content = response.choices[0].message.content

            clean_content = content.replace("```json", "").replace("```", "").strip()

            result = json.loads(clean_content)
            logger.debug(f"LLM JSON response: {result}")
            self._log_call("chat_json", True, start, usage, None)
            return result
        except json.JSONDecodeError as e:
            self._log_call("chat_json", False, start, usage, f"json_decode_error: {e}")
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            logger.error(f"Raw content: {content}")
            raise
        except Exception as e:
            self._log_call("chat_json", False, start, usage, str(e))
            logger.error(f"OpenRouterClient.chat_json failed: {e}")
            raise

    def _extract_usage(self, usage: Optional[object]) -> Tuple[int, int, int]:
        if usage is None:
            return 0, 0, 0
        if isinstance(usage, dict):
            return (
                int(usage.get("prompt_tokens") or 0),
                int(usage.get("completion_tokens") or 0),
                int(usage.get("total_tokens") or 0),
            )
        return (
            int(getattr(usage, "prompt_tokens", 0) or 0),
            int(getattr(usage, "completion_tokens", 0) or 0),
            int(getattr(usage, "total_tokens", 0) or 0),
        )

    def _log_call(
        self,
        method: str,
        success: bool,
        start_time: float,
        usage: Optional[object],
        error: Optional[str],
    ) -> None:
        if not self._call_logger:
            return
        prompt_tokens, completion_tokens, total_tokens = self._extract_usage(usage)
        latency_ms = (time.perf_counter() - start_time) * 1000
        self._call_logger.log_call(
            provider=self._provider,
            model=self._model,
            method=method,
            success=success,
            latency_ms=latency_ms,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            error=error,
        )
