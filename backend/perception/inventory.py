# Inventory Provider Implementation - 背包感知
#
# 职责:
# - 查询 Bot 背包内容
# - 提供同步的物品查询接口
# - 与 Scanner 分离，保持单一职责

import logging
from typing import Dict, Optional

from .interfaces import IInventoryProvider

logger = logging.getLogger(__name__)


class BotInventoryProvider(IInventoryProvider):
    """
    Bot 背包查询实现
    
    设计决策:
    - 所有方法都是同步的 (背包数据在内存中)
    - 不缓存结果，每次查询都从 Bot 获取最新状态
    - 与 MineflayerActions 解耦，保持 perception 模块独立性
    
    依赖:
    - Mineflayer bot 实例
    """
    
    def __init__(self, bot):
        """
        初始化背包提供者
        
        Args:
            bot: MineflayerBot 实例 (backend/bot/mineflayer_adapter.py)
                 需要有 _bot (原始 mineflayer bot) 属性
        """
        self._mf_bot = bot       # MineflayerBot wrapper
        self._bot = bot._bot     # 原始 mineflayer bot 对象
    
    def get_items(self) -> Dict[str, int]:
        """
        获取背包物品摘要 (合并同类项)
        
        Returns:
            {item_id: count} 字典
            如 {"oak_log": 64, "cobblestone": 128}
        """
        summary: Dict[str, int] = {}
        
        try:
            items = self._bot.inventory.items()
            for item in items:
                name = item.name
                count = item.count
                summary[name] = summary.get(name, 0) + count
                
        except Exception as e:
            logger.warning(f"[InventoryProvider] Failed to get items: {e}")
        
        return summary
    
    def has_item(self, item_id: str, min_count: int = 1) -> bool:
        """
        检查背包是否有指定物品
        
        Args:
            item_id: 物品 ID
            min_count: 最少数量 (默认 1)
            
        Returns:
            是否有足够数量的物品
        """
        return self.get_item_count(item_id) >= min_count
    
    def get_item_count(self, item_id: str) -> int:
        """
        获取指定物品的数量
        
        Args:
            item_id: 物品 ID
            
        Returns:
            物品数量，没有则返回 0
        """
        try:
            total = 0
            items = self._bot.inventory.items()
            for item in items:
                if item.name == item_id:
                    total += item.count
            return total
            
        except Exception as e:
            logger.warning(f"[InventoryProvider] Failed to get count for {item_id}: {e}")
            return 0
    
    def find_item(self, item_id: str):
        """
        在背包中查找物品对象
        
        Args:
            item_id: 物品 ID
            
        Returns:
            Mineflayer Item 对象，没有则返回 None
        """
        try:
            items = self._bot.inventory.items()
            for item in items:
                if item.name == item_id:
                    return item
            return None
            
        except Exception as e:
            logger.warning(f"[InventoryProvider] Failed to find {item_id}: {e}")
            return None


class MockInventoryProvider(IInventoryProvider):
    """
    模拟背包提供者 - 用于单元测试
    
    可以预设背包内容，方便测试 EntityResolver 的逻辑
    """
    
    def __init__(self, items: Optional[Dict[str, int]] = None):
        """
        初始化模拟背包
        
        Args:
            items: 预设的背包内容 {item_id: count}
        """
        self._items = items or {}
    
    def set_items(self, items: Dict[str, int]) -> None:
        """设置背包内容"""
        self._items = items.copy()
    
    def add_item(self, item_id: str, count: int = 1) -> None:
        """添加物品"""
        self._items[item_id] = self._items.get(item_id, 0) + count
    
    def remove_item(self, item_id: str, count: int = 1) -> None:
        """移除物品"""
        if item_id in self._items:
            self._items[item_id] = max(0, self._items[item_id] - count)
            if self._items[item_id] == 0:
                del self._items[item_id]
    
    def clear(self) -> None:
        """清空背包"""
        self._items.clear()
    
    def get_items(self) -> Dict[str, int]:
        """返回预设的背包内容"""
        return self._items.copy()
    
    def has_item(self, item_id: str, min_count: int = 1) -> bool:
        """检查是否有物品"""
        return self._items.get(item_id, 0) >= min_count
    
    def get_item_count(self, item_id: str) -> int:
        """获取物品数量"""
        return self._items.get(item_id, 0)

