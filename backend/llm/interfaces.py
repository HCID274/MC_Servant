# LLM Client Interfaces

from abc import ABC, abstractmethod
from typing import Optional


class ILLMClient(ABC):
    """
    LLM 客户端抽象接口
    
    简单接口：chat, chat_json
    深度功能：支持不同模型、参数配置
    
    依赖抽象：业务逻辑依赖此接口，不依赖具体实现
    """
    
    @property
    @abstractmethod
    def model_name(self) -> str:
        """当前使用的模型名称"""
        pass
    
    @abstractmethod
    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> str:
        """
        发送聊天请求，返回模型回复文本
        
        Args:
            messages: 消息列表，格式 [{"role": "user/system/assistant", "content": "..."}]
            max_tokens: 最大输出 token 数
            temperature: 采样温度
            
        Returns:
            模型回复的文本内容
        """
        pass
    
    @abstractmethod
    async def chat_json(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.3,
    ) -> dict:
        """
        发送聊天请求，返回 JSON 格式响应
        
        使用更低的 temperature 以获得稳定的结构化输出
        
        Args:
            messages: 消息列表
            max_tokens: 最大输出 token 数
            temperature: 采样温度（默认较低以保证 JSON 格式稳定）
            
        Returns:
            解析后的 JSON 字典
            
        Raises:
            json.JSONDecodeError: 模型返回的内容无法解析为 JSON
        """
        pass


class IIntentRecognizer(ABC):
    """
    意图识别器抽象接口
    """
    
    @abstractmethod
    async def recognize(self, user_input: str, context: Optional[str] = None) -> tuple:
        """
        识别用户意图
        
        Args:
            user_input: 用户输入文本
            context: 可选的上下文信息
            
        Returns:
            (意图枚举, 提取的实体字典)
        """
        pass
