# Tag Resolver for Minecraft crafting

"""
Tag 解析器 - 神经符号架构的符号层组件

设计原则：
- 简单接口：get_equivalents(item) 返回所有等价物品
- 深度功能：内部处理 Tag 组查找、缓存
- 依赖抽象：通过 ITagResolver 接口解耦

职责：
- 将某物品映射到其所属 Tag 组的所有成员
- 支持快速查询物品是否属于某个 Tag 组
"""

import json
import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import List, Dict, Optional, Set

logger = logging.getLogger(__name__)


class ITagResolver(ABC):
    """Tag 解析器抽象接口"""
    
    @abstractmethod
    def get_equivalents(self, item_name: str) -> List[str]:
        """
        获取某物品的所有等价物品 (同 Tag 组)
        
        Args:
            item_name: 物品 ID (如 "oak_planks")
            
        Returns:
            该物品所属 Tag 组的所有成员列表。
            如果物品不属于任何 Tag 组，返回 [item_name] (自身)。
            
        Example:
            get_equivalents("birch_planks")
            # => ["oak_planks", "spruce_planks", "birch_planks", ...]
        """
        pass
    
    @abstractmethod
    def get_tag_members(self, tag_name: str) -> List[str]:
        """
        获取某 Tag 组的所有成员
        
        Args:
            tag_name: Tag 名称 (如 "planks", "wool")
            
        Returns:
            该 Tag 组的所有物品列表，如果 Tag 不存在返回空列表。
        """
        pass
    
    @abstractmethod
    def find_available(self, item_name: str, inventory: Dict[str, int]) -> Optional[str]:
        """
        在背包中查找等价物品
        
        Args:
            item_name: 目标物品 ID
            inventory: 背包物品字典 {item_name: count}
            
        Returns:
            背包中存在的第一个等价物品名，如果没有返回 None。
        """
        pass

    @abstractmethod
    def get_available_count(self, item_name: str, inventory: Dict[str, int]) -> int:
        """
        获取背包中“等价物品集合”的总数量

        Args:
            item_name: 物品名或 Tag 名称
            inventory: 背包物品字典 {item_name: count}

        Returns:
            所有等价物品数量之和。若无 Tag/等价物品，则返回自身数量。
        """
        pass

    @abstractmethod
    def get_tag_for_item(self, item_name: str) -> Optional[str]:
        """返回物品所属 Tag 名（若没有则返回 None）"""
        pass


class TagResolver(ITagResolver):
    """
    Tag 解析器实现
    
    从 JSON 文件加载 Tag 定义，提供物品等价查询服务。
    使用反向索引优化查询性能。
    """
    
    _DEFAULT_PATH = Path(__file__).parent.parent / "data" / "tag_recipes.json"
    
    def __init__(self, tag_file: Optional[str] = None):
        """
        初始化 Tag 解析器
        
        Args:
            tag_file: Tag 定义文件路径，默认使用 data/tag_recipes.json
        """
        self._tag_file = Path(tag_file) if tag_file else self._DEFAULT_PATH
        self._tags: Dict[str, List[str]] = {}
        self._reverse_index: Dict[str, str] = {}  # item -> tag_name
        self._load_tags()

    @staticmethod
    def _normalize_name(name: Optional[str]) -> str:
        """
        统一名称格式：
        - 去掉 minecraft: 前缀
        - 去掉首尾空白
        """
        if not name:
            return ""
        n = str(name).strip()
        if n.startswith("minecraft:"):
            n = n.split("minecraft:", 1)[1]
        return n
    
    def _load_tags(self) -> None:
        """加载 Tag 定义并构建反向索引"""
        try:
            with open(self._tag_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 过滤掉注释字段
            # 规范化 Tag 与物品名，避免 minecraft: 前缀/空白导致匹配失败
            tags: Dict[str, List[str]] = {}
            for raw_tag_name, raw_items in data.items():
                if str(raw_tag_name).startswith("_"):
                    continue
                tag_name = self._normalize_name(raw_tag_name)
                items = [self._normalize_name(x) for x in (raw_items or []) if self._normalize_name(x)]
                if tag_name and items:
                    tags[tag_name] = items
            self._tags = tags
            
            # 构建反向索引 (item -> tag_name)
            for tag_name, items in self._tags.items():
                for item in items:
                    self._reverse_index[self._normalize_name(item)] = tag_name
            
            logger.info(f"TagResolver loaded {len(self._tags)} tags, {len(self._reverse_index)} items")
            
        except FileNotFoundError:
            logger.warning(f"Tag file not found: {self._tag_file}, using empty tags")
            self._tags = {}
            self._reverse_index = {}
        except Exception as e:
            logger.error(f"Failed to load tag file: {e}")
            self._tags = {}
            self._reverse_index = {}
    
    def get_equivalents(self, item_name: str) -> List[str]:
        """获取某物品的所有等价物品 (同 Tag 组)"""
        norm = self._normalize_name(item_name)
        tag_name = self._reverse_index.get(norm)
        if tag_name:
            return self._tags[tag_name]
        return [norm] if norm else [item_name]  # 无 Tag，返回自身
    
    def get_tag_members(self, tag_name: str) -> List[str]:
        """获取某 Tag 组的所有成员"""
        return self._tags.get(self._normalize_name(tag_name), [])

    def get_tag_for_item(self, item_name: str) -> Optional[str]:
        return self._reverse_index.get(self._normalize_name(item_name))
    
    def find_available(self, item_name: str, inventory: Dict[str, int]) -> Optional[str]:
        """在背包中查找等价物品
        
        支持两种输入：
        - Tag 名称 (如 "planks") -> 检查所有 Tag 成员
        - 物品名称 (如 "oak_planks") -> 检查同 Tag 组的等价物品
        """
        norm_item = self._normalize_name(item_name)

        # 规范化 inventory key（但不改变原 dict）
        inv_norm: Dict[str, int] = {}
        for k, v in (inventory or {}).items():
            nk = self._normalize_name(k)
            if not nk:
                continue
            inv_norm[nk] = inv_norm.get(nk, 0) + int(v or 0)

        # 如果 item_name 是 Tag 名称，直接获取其成员
        if norm_item in self._tags:
            equivalents = self._tags[norm_item]
        else:
            equivalents = self.get_equivalents(norm_item)
        
        # 按背包中数量排序，优先返回数量最多的
        available = [(name, inv_norm.get(name, 0)) for name in equivalents]
        available = [(name, count) for name, count in available if count > 0]
        
        if available:
            # 返回数量最多的
            available.sort(key=lambda x: x[1], reverse=True)
            return available[0][0]
        
        return None
    
    def get_available_count(self, item_name: str, inventory: Dict[str, int]) -> int:
        """获取背包中所有等价物品的总数量（支持 Tag 名称或物品名）"""
        norm_item = self._normalize_name(item_name)
        inv_norm: Dict[str, int] = {}
        for k, v in (inventory or {}).items():
            nk = self._normalize_name(k)
            if not nk:
                continue
            inv_norm[nk] = inv_norm.get(nk, 0) + int(v or 0)

        if norm_item in self._tags:
            equivalents = self._tags[norm_item]
        else:
            equivalents = self.get_equivalents(norm_item)
        return sum(int(inv_norm.get(name, 0)) for name in equivalents)


# 全局单例 (延迟初始化)
_tag_resolver: Optional[TagResolver] = None


def get_tag_resolver() -> ITagResolver:
    """获取全局 Tag 解析器实例"""
    global _tag_resolver
    if _tag_resolver is None:
        _tag_resolver = TagResolver()
    return _tag_resolver
