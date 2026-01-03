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
    
    def _load_tags(self) -> None:
        """加载 Tag 定义并构建反向索引"""
        try:
            with open(self._tag_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 过滤掉注释字段
            self._tags = {k: v for k, v in data.items() if not k.startswith('_')}
            
            # 构建反向索引 (item -> tag_name)
            for tag_name, items in self._tags.items():
                for item in items:
                    self._reverse_index[item] = tag_name
            
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
        tag_name = self._reverse_index.get(item_name)
        if tag_name:
            return self._tags[tag_name]
        return [item_name]  # 无 Tag，返回自身
    
    def get_tag_members(self, tag_name: str) -> List[str]:
        """获取某 Tag 组的所有成员"""
        return self._tags.get(tag_name, [])
    
    def find_available(self, item_name: str, inventory: Dict[str, int]) -> Optional[str]:
        """在背包中查找等价物品"""
        equivalents = self.get_equivalents(item_name)
        
        # 按背包中数量排序，优先返回数量最多的
        available = [(name, inventory.get(name, 0)) for name in equivalents]
        available = [(name, count) for name, count in available if count > 0]
        
        if available:
            # 返回数量最多的
            available.sort(key=lambda x: x[1], reverse=True)
            return available[0][0]
        
        return None
    
    def get_available_count(self, item_name: str, inventory: Dict[str, int]) -> int:
        """获取背包中所有等价物品的总数量"""
        equivalents = self.get_equivalents(item_name)
        return sum(inventory.get(name, 0) for name in equivalents)


# 全局单例 (延迟初始化)
_tag_resolver: Optional[TagResolver] = None


def get_tag_resolver() -> ITagResolver:
    """获取全局 Tag 解析器实例"""
    global _tag_resolver
    if _tag_resolver is None:
        _tag_resolver = TagResolver()
    return _tag_resolver
