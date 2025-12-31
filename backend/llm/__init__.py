# LLM Module
# 依赖抽象，而非具体

from .interfaces import ILLMClient
from .qwen_client import QwenClient
from .intent import Intent, IntentRecognizer

__all__ = [
    "ILLMClient",
    "QwenClient", 
    "Intent",
    "IntentRecognizer",
]
