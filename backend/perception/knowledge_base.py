# Knowledge Base Implementation - 静态语义知识库
#
# 职责:
# - 从 mc_knowledge_base.json 加载数据
# - 提供语义概念到 Minecraft ID 的映射
# - 别名解析和 ID 校验

import json
import logging
from pathlib import Path
from typing import List, Dict, Set, Optional

from .interfaces import IKnowledgeBase

logger = logging.getLogger(__name__)


class JsonKnowledgeBase(IKnowledgeBase):
    """
    JSON 文件知识库实现
    
    数据结构 (mc_knowledge_base.json):
    {
        "tags": {
            "logs": ["oak_log", "birch_log", ...],
            "ores": ["iron_ore", "gold_ore", ...],
            ...
        },
        "items": {
            "oak_log": ["logs", "fuel", ...],
            ...
        },
        "aliases": {
            "木头": "logs",
            "wood": "logs",
            ...
        }
    }
    
    设计决策:
    - 所有方法都是同步的 (内存字典查询)
    - 启动时一次性加载，重启生效
    - 预留 reload() 方法
    """
    
    def __init__(self, kb_path: Optional[str] = None):
        """
        初始化知识库
        
        Args:
            kb_path: JSON 文件路径，默认使用 data/mc_knowledge_base.json
        """
        if kb_path is None:
            # 默认路径: backend/data/mc_knowledge_base.json
            kb_path = Path(__file__).parent.parent / "data" / "mc_knowledge_base.json"
        
        self._kb_path = Path(kb_path)
        
        # 核心数据结构
        self._tags: Dict[str, List[str]] = {}      # tag_name -> [item_ids]
        self._items: Dict[str, List[str]] = {}     # item_id -> [tag_names]
        self._aliases: Dict[str, str] = {}         # alias -> tag_name
        self._all_item_ids: Set[str] = set()       # 所有合法的 item_id
        
        # 加载数据
        self._load()
    
    def _load(self) -> None:
        """加载 JSON 知识库"""
        try:
            with open(self._kb_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            self._tags = data.get("tags", {})
            self._items = data.get("items", {})
            self._aliases = data.get("aliases", {})
            
            # 构建所有合法 ID 集合
            self._all_item_ids = set(self._items.keys())
            
            # 同时将 tags 中的所有 ID 也加入合法集合
            for tag_items in self._tags.values():
                self._all_item_ids.update(tag_items)
            
            logger.info(
                f"[KnowledgeBase] Loaded: {len(self._tags)} tags, "
                f"{len(self._items)} items, {len(self._aliases)} aliases"
            )
            
        except FileNotFoundError:
            logger.error(f"[KnowledgeBase] File not found: {self._kb_path}")
            raise
        except json.JSONDecodeError as e:
            logger.error(f"[KnowledgeBase] JSON parse error: {e}")
            raise
    
    def get_candidates(self, concept: str) -> List[str]:
        """
        获取概念对应的候选 ID 列表
        
        查询优先级:
        1. 先解析别名
        2. 查 tags 表
        3. 如果 concept 本身就是合法 ID，返回 [concept]
        
        Args:
            concept: 语义概念 (如 "wood", "logs", "oak_log")
            
        Returns:
            候选 ID 列表
        """
        # 1. 解析别名
        resolved = self.resolve_alias(concept)
        
        # 2. 查 tags 表
        if resolved in self._tags:
            return self._tags[resolved].copy()
        
        # 3. 如果本身就是合法 ID，返回自己
        if resolved in self._all_item_ids:
            return [resolved]
        
        # 4. 原始输入也检查一下 (防止大小写问题)
        concept_lower = concept.lower()
        if concept_lower in self._tags:
            return self._tags[concept_lower].copy()
        if concept_lower in self._all_item_ids:
            return [concept_lower]
        
        return []
    
    def resolve_alias(self, alias: str) -> str:
        """
        解析别名到标准概念名
        
        Args:
            alias: 可能是别名的输入 (如 "木头", "wood")
            
        Returns:
            标准概念名 (如 "logs")
            如果不是别名，返回原值
        """
        # 直接查找
        if alias in self._aliases:
            return self._aliases[alias]
        
        # 小写查找
        alias_lower = alias.lower()
        if alias_lower in self._aliases:
            return self._aliases[alias_lower]
        
        return alias
    
    def validate_ids(self, ids: List[str]) -> List[str]:
        """
        校验 ID 列表的合法性
        
        Args:
            ids: 待校验的 ID 列表 (可能来自 LLM)
            
        Returns:
            合法的 ID 列表
        """
        if not ids:
            return []
        
        valid = []
        for item_id in ids:
            if self.is_valid_id(item_id):
                valid.append(item_id)
            else:
                # 尝试小写
                item_lower = item_id.lower()
                if item_lower in self._all_item_ids:
                    valid.append(item_lower)
                else:
                    logger.debug(f"[KnowledgeBase] Invalid ID: {item_id}")
        
        return valid
    
    def is_valid_id(self, item_id: str) -> bool:
        """
        检查单个 ID 是否合法
        
        Args:
            item_id: Minecraft 物品/方块 ID
            
        Returns:
            是否在知识库中存在
        """
        return item_id in self._all_item_ids or item_id.lower() in self._all_item_ids
    
    def reload(self) -> None:
        """
        重新加载知识库
        
        Phase 1 实现: 简单重新加载，不处理并发安全性
        """
        logger.info("[KnowledgeBase] Reloading...")
        self._load()
    
    # ========================================================================
    # 扩展方法 (非接口要求，但实用)
    # ========================================================================
    
    def get_tags_for_item(self, item_id: str) -> List[str]:
        """
        获取物品所属的标签列表
        
        Args:
            item_id: 物品 ID
            
        Returns:
            标签列表 (如 ["logs", "fuel"])
        """
        return self._items.get(item_id, []).copy()
    
    def get_all_tags(self) -> List[str]:
        """获取所有标签名"""
        return list(self._tags.keys())
    
    def get_all_item_ids(self) -> Set[str]:
        """获取所有合法的物品 ID"""
        return self._all_item_ids.copy()
    
    def search_by_keyword(self, keyword: str) -> List[str]:
        """
        按关键词搜索物品 ID
        
        Args:
            keyword: 搜索关键词 (如 "log", "ore")
            
        Returns:
            包含关键词的物品 ID 列表
        """
        keyword_lower = keyword.lower()
        return [
            item_id for item_id in self._all_item_ids
            if keyword_lower in item_id.lower()
        ]


# ============================================================================
# 单例模式 - 全局知识库实例
# ============================================================================

_knowledge_base: Optional[JsonKnowledgeBase] = None


def get_knowledge_base(kb_path: Optional[str] = None) -> JsonKnowledgeBase:
    """
    获取全局知识库实例 (单例模式)
    
    Args:
        kb_path: JSON 文件路径 (仅首次调用时有效)
        
    Returns:
        JsonKnowledgeBase 实例
    """
    global _knowledge_base
    
    if _knowledge_base is None:
        _knowledge_base = JsonKnowledgeBase(kb_path)
    
    return _knowledge_base


def reload_knowledge_base() -> None:
    """重新加载全局知识库"""
    global _knowledge_base
    
    if _knowledge_base is not None:
        _knowledge_base.reload()

