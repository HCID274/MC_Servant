# Perception Module - 神经符号语义解析系统
#
# 职责: 将语义概念映射到具体的 Minecraft ID，
#       并与 Bot 的环境感知取交集，返回实际可操作的目标。
#
# 设计原则:
# - 简单的接口，深度的功能
# - 依赖抽象，而非具体
# - 感知 (Perception) 与 动作 (Action) 解耦

from .interfaces import (
    IKnowledgeBase,
    IScanner,
    IInventoryProvider,
    ResolveStatus,
    ResolveResult,
    ScanResult,
)
from .resolver import EntityResolver, SearchConfig, create_entity_resolver
from .knowledge_base import JsonKnowledgeBase, get_knowledge_base
from .scanner import MineflayerScanner, MockScanner
from .inventory import BotInventoryProvider, MockInventoryProvider

__all__ = [
    # 抽象接口
    "IKnowledgeBase",
    "IScanner", 
    "IInventoryProvider",
    # 数据结构
    "ResolveStatus",
    "ResolveResult",
    "ScanResult",
    "SearchConfig",
    # 具体实现
    "EntityResolver",
    "JsonKnowledgeBase",
    "MineflayerScanner",
    "BotInventoryProvider",
    # Mock 实现 (测试用)
    "MockScanner",
    "MockInventoryProvider",
    # 工厂函数
    "create_entity_resolver",
    "get_knowledge_base",
]

