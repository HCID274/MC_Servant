import asyncio
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

    def _strip_code_fences(self, content: str) -> str:
        return content.replace("```json", "").replace("```", "").strip()

    def _extract_first_json_object(self, content: str) -> Optional[str]:
        in_string = False
        escape = False
        start = None
        depth = 0
        for i, ch in enumerate(content):
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == "\"":
                    in_string = False
                continue
            if ch == "\"":
                in_string = True
                continue
            if ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}":
                if depth > 0:
                    depth -= 1
                    if depth == 0 and start is not None:
                        return content[start:i + 1]
        return None

    def _drop_reasoning_field(self, content: str) -> Optional[str]:
        keys = ["\"reasoning\"", "\"reasoning_details\""]
        idx = -1
        for key in keys:
            pos = content.find(key)
            if pos != -1:
                idx = pos if idx == -1 else min(idx, pos)
        if idx == -1:
            return None
        prefix = content[:idx]
        comma_idx = prefix.rfind(",")
        if comma_idx != -1:
            prefix = prefix[:comma_idx]
        prefix = prefix.rstrip()
        if "{" not in prefix:
            return None
        if not prefix.endswith("}"):
            prefix = prefix + "\n}"
        return prefix

    def _salvage_json(self, content: str) -> Optional[dict]:
        if not content:
            return None
        candidate = self._drop_reasoning_field(content)
        if candidate:
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
        candidate = self._extract_first_json_object(content)
        if candidate:
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
        return None

    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
        max_retries: int = 2,
    ) -> str:
        """
        调用 LLM 并返回文本响应
        
        如果 LLM 返回空内容，自动重试最多 max_retries 次
        """
        start = time.perf_counter()
        usage = None
        last_error = None
        
        for attempt in range(1, max_retries + 2):  # 最多尝试 max_retries + 1 次
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
                
                # 检查是否为空
                if content is None or not content.strip():
                    logger.warning(f"LLM returned empty content, model={self._model}, attempt={attempt}/{max_retries + 1}")
                    if attempt <= max_retries:
                        await asyncio.sleep(0.3 * attempt)  # 短暂等待后重试
                        continue
                    # 最后一次尝试也失败，返回空字符串
                    content = ""
                
                logger.debug(f"LLM response: {content[:100] if content else '(empty)'}...")
                self._log_call("chat", True, start, usage, None)
                return content
                
            except Exception as e:
                last_error = e
                logger.warning(f"LLM chat error (attempt {attempt}/{max_retries + 1}): {e}")
                if attempt <= max_retries:
                    await asyncio.sleep(0.5 * attempt)
                    continue
                # 最后一次尝试也抛出异常
                self._log_call("chat", False, start, usage, str(e))
                logger.error(f"OpenRouterClient.chat failed after {attempt} attempts: {e}")
                raise

    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
        max_retries: int = 2,
    ) -> dict:
        """
        调用 LLM 并返回 JSON 响应
        
        如果 LLM 返回空内容或无效 JSON，自动重试最多 max_retries 次
        """
        start = time.perf_counter()
        usage = None
        content = None
        
        for attempt in range(1, max_retries + 2):
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
                
                # 检查是否为空
                if content is None or not content.strip():
                    logger.warning(f"LLM JSON returned empty content, model={self._model}, attempt={attempt}/{max_retries + 1}")
                    if attempt <= max_retries:
                        await asyncio.sleep(0.3 * attempt)
                        continue
                    raise ValueError("LLM returned empty content after all retries")

                clean_content = self._strip_code_fences(content)
                try:
                    result = json.loads(clean_content)
                except json.JSONDecodeError:
                    salvaged = self._salvage_json(clean_content)
                    if salvaged is not None:
                        logger.warning(
                            f"LLM JSON salvaged, model={self._model}, attempt={attempt}/{max_retries + 1}"
                        )
                        self._log_call("chat_json", True, start, usage, None)
                        return salvaged
                    raise
                logger.debug(f"LLM JSON response: {result}")
                self._log_call("chat_json", True, start, usage, None)
                return result
                
            except json.JSONDecodeError as e:
                logger.warning(f"JSON decode error (attempt {attempt}/{max_retries + 1}): {e}")
                if attempt <= max_retries:
                    await asyncio.sleep(0.3 * attempt)
                    continue
                self._log_call("chat_json", False, start, usage, f"json_decode_error: {e}")
                logger.error(f"Failed to parse LLM response as JSON after {attempt} attempts: {e}")
                logger.error(f"Raw content: {content}")
                raise
            except Exception as e:
                logger.warning(f"LLM chat_json error (attempt {attempt}/{max_retries + 1}): {e}")
                if attempt <= max_retries:
                    await asyncio.sleep(0.5 * attempt)
                    continue
                self._log_call("chat_json", False, start, usage, str(e))
                logger.error(f"OpenRouterClient.chat_json failed after {attempt} attempts: {e}")
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
