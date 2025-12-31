# Qwen-Flash Client Implementation

import json
import logging
from typing import Optional

from openai import AsyncOpenAI

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
        logger.info(f"QwenClient initialized with model: {model}")
    
    @property
    def model_name(self) -> str:
        return self._model
    
    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> str:
        """发送聊天请求，返回模型回复文本"""
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            content = response.choices[0].message.content
            logger.debug(f"LLM response: {content[:100]}...")
            return content
            
        except Exception as e:
            logger.error(f"QwenClient.chat failed: {e}")
            raise
    
    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
    ) -> dict:
        """发送聊天请求，返回 JSON 格式响应"""
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                response_format={"type": "json_object"},  # Qwen-Flash 支持 JSON Mode
            )
            content = response.choices[0].message.content
            
            # 清理可能的 markdown 代码块标记
            clean_content = content.replace("```json", "").replace("```", "").strip()
            
            result = json.loads(clean_content)
            logger.debug(f"LLM JSON response: {result}")
            return result
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            logger.error(f"Raw content: {content}")
            raise
        except Exception as e:
            logger.error(f"QwenClient.chat_json failed: {e}")
            raise


def create_qwen_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
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
    )
