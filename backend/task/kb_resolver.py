# KB Resolver
#
# 简单的 KnowledgeBase Resolver，用于 UniversalRunner
# 根据架构评审，从 UniversalRunner 中提取，并使用 IActionResolver 接口

import logging
from typing import List, Optional, Dict, Any

from .interfaces import IActionResolver, RunContext

logger = logging.getLogger(__name__)


class KBOnlyResolver(IActionResolver):
    """
    轻量级 Resolver - 仅使用 KB，不需要 bot 实例

    用于参数归一化：将 LLM 输出的语义概念映射到具体 Minecraft ID
    不进行实际扫描，只做 KB 查询
    """

    def __init__(self, kb):
        """
        初始化

        Args:
            kb: 知识库实例 (IKnowledgeBase)
        """
        self._kb = kb

    def resolve_concept(self, concept: str) -> str:
        """
        解析语义概念到标准概念名/候选 ID

        Args:
            concept: 语义概念 (如 "tree", "log", "矿")

        Returns:
            标准概念名或第一个候选 ID
        """
        if not concept:
            return concept

        # 1. 尝试解析别名
        resolved = self._kb.resolve_alias(concept)

        # 2. 获取候选列表
        candidates = self._kb.get_candidates(resolved)

        if candidates:
            # 返回第一个候选 ID
            return candidates[0]

        # 3. 如果本身是合法 ID，返回自己
        if self._kb.is_valid_id(resolved):
            return resolved

        # 4. 原样返回
        return concept

    def get_candidates(self, concept: str) -> List[str]:
        """获取概念对应的全部候选 ID"""
        resolved = self._kb.resolve_alias(concept)
        return self._kb.get_candidates(resolved)
