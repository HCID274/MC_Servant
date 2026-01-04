# Qwen-Flash Client Implementation

import asyncio
import json
import logging
import time
from typing import Optional, Tuple

from openai import AsyncOpenAI

from .call_logger import LLMCallLogger
from .interfaces import ILLMClient

logger = logging.getLogger(__name__)


class QwenClient(ILLMClient):
    """
    通义千问 Qwen-Flash 客户端实现
    
    使用 OpenAI 兼容接口调用阿里云 DashScope API
    
    特点:
    - qwen-flash: 速度快、成本低、JSON 输出稳定
    - 支持 response_format={"type": "json_object"} 的 JSON Mode
    """
    
    def __init__(
        self,
        api_key: str,
        base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: str = "qwen-flash",
        call_logger: Optional[LLMCallLogger] = None,
    ):
        """
        初始化 Qwen 客户端
        
        Args:
            api_key: DashScope API Key (格式: sk-xxxxxxxx)
            base_url: OpenAI 兼容 API 地址
            model: 模型名称 (qwen-flash / qwen-max)
        """
        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
        )
        self._model = model
        self._provider = "qwen"
        self._call_logger = call_logger
        logger.info(f"QwenClient initialized with model: {model}")
    
    @property
    def model_name(self) -> str:
        return self._model
    
    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
        max_retries: int = 2,
    ) -> str:
        """
        发送聊天请求，返回模型回复文本
        
        如果 LLM 返回空内容，自动重试最多 max_retries 次
        """
        start = time.perf_counter()
        usage = None
        
        for attempt in range(1, max_retries + 2):
            try:
                response = await self._client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                usage = response.usage
                content = response.choices[0].message.content
                
                # 检查是否为空
                if content is None or not content.strip():
                    logger.warning(f"LLM returned empty content, model={self._model}, attempt={attempt}/{max_retries + 1}")
                    if attempt <= max_retries:
                        await asyncio.sleep(0.3 * attempt)
                        continue
                    content = ""
                
                logger.debug(f"LLM response: {content[:100] if content else '(empty)'}...")
                self._log_call("chat", True, start, usage, None)
                return content
                
            except Exception as e:
                logger.warning(f"LLM chat error (attempt {attempt}/{max_retries + 1}): {e}")
                if attempt <= max_retries:
                    await asyncio.sleep(0.5 * attempt)
                    continue
                self._log_call("chat", False, start, usage, str(e))
                logger.error(f"QwenClient.chat failed after {attempt} attempts: {e}")
                raise
    
    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
        max_retries: int = 2,
    ) -> dict:
        """
        发送聊天请求并返回 JSON
        
        如果 LLM 返回空内容或无效 JSON，自动重试最多 max_retries 次
        """
        start = time.perf_counter()
        usage = None
        content = None
        
        for attempt in range(1, max_retries + 2):
            try:
                response = await self._client.chat.completions.create(
                    model=self._model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    response_format={"type": "json_object"},
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

                clean_content = content.replace("```json", "").replace("```", "").strip()
                result = json.loads(clean_content)
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
                logger.error(f"QwenClient.chat_json failed after {attempt} attempts: {e}")
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


def create_qwen_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    call_logger: Optional[LLMCallLogger] = None,
) -> QwenClient:
    """
    工厂函数：从配置创建 QwenClient
    
    优先使用传入参数，否则从 settings 读取
    """
    from config import settings
    
    return QwenClient(
        api_key=api_key or settings.openai_api_key,
        base_url=base_url or settings.openai_base_url,
        model=model or settings.openai_model,
        call_logger=call_logger,
    )
