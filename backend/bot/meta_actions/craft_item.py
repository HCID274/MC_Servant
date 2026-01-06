# Craft Item Action - 合成物品
#
# 包装现有 actions.craft()
# 检查背包是否有足够材料

import logging
from typing import Dict, Any, List, Optional, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


@MetaActionRegistry.register
class CraftItemAction(IMetaAction):
    """
    合成物品
    
    特性:
    - 自动检查是否有工作台 (需要时)
    - 自动检查材料是否充足 (可选)
    """
    
    @property
    def name(self) -> str:
        return "craft_item"
    
    @property
    def description(self) -> str:
        return (
            "Craft an item using materials in inventory. "
            "Automatically uses crafting table if required."
        )
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="item_name",
                type="str",
                description="Name of item to craft (e.g., 'oak_planks', 'stick', 'iron_pickaxe')",
                required=True
            ),
            ParameterSpec(
                name="count",
                type="int",
                description="Number of items to craft",
                required=False,
                default=1
            )
        ]
    
    # 需要工作台的配方 (3x3)
    CRAFTING_TABLE_REQUIRED = {
        # 工具
        "pickaxe", "axe", "shovel", "hoe", "sword",
        # 装备
        "helmet", "chestplate", "leggings", "boots", "shield",
        # 方块
        "chest", "furnace", "smoker", "blast_furnace",
        "anvil", "enchanting_table", "bookshelf",
        # 其他
        "bow", "crossbow", "fishing_rod", "bucket",
    }
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """
        检查是否可以合成
        
        基本条件:
        - 有背包
        - (如果需要 3x3 配方) 有工作台或能放置工作台
        """
        inventory = bot_state.get("inventory", {})
        
        # 基本检查: 背包存在
        if inventory is None:
            return False
        
        return True
    
    def needs_crafting_table(self, item_name: str) -> bool:
        """检查是否需要工作台"""
        # 检查物品名是否包含需要工作台的关键词
        for keyword in self.CRAFTING_TABLE_REQUIRED:
            if keyword in item_name.lower():
                return True
        return False
    
    def has_crafting_table_access(
        self, 
        item_name: str,
        bot_state: Dict[str, Any]
    ) -> bool:
        """检查是否能使用工作台"""
        if not self.needs_crafting_table(item_name):
            return True  # 不需要工作台
        
        inventory = bot_state.get("inventory", {})
        
        # 背包有工作台
        if inventory.get("crafting_table", 0) > 0:
            return True
        
        # 附近有工作台
        nearby = bot_state.get("nearby_blocks", [])
        if any("crafting_table" in str(b) for b in nearby):
            return True
        
        return False
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> Optional[str]:
        # 这个方法在没有具体 item_name 时无法给出具体原因
        return None
    
    async def execute(
        self, 
        actions: "IBotActions", 
        **params
    ) -> "ActionResult":
        """执行合成"""
        from ..interfaces import ActionResult
        
        item_name = params.get("item_name")
        count = params.get("count", 1)
        
        if not item_name:
            return ActionResult(
                success=False,
                action="craft_item",
                error_code="MISSING_PARAM",
                message="item_name is required"
            )
        
        # 检查是否需要工作台
        try:
            bot_state = await actions.get_state()
            
            if self.needs_crafting_table(item_name):
                if not self.has_crafting_table_access(item_name, bot_state):
                    return ActionResult(
                        success=False,
                        action="craft_item",
                        error_code="NO_CRAFTING_TABLE",
                        message=f"Crafting {item_name} requires a crafting table",
                        data={"requires": "crafting_table"}
                    )
        except Exception as e:
            logger.warning(f"[CraftItemAction] State check failed: {e}")
        
        logger.info(f"[CraftItemAction] Crafting {count}x {item_name}")
        
        return await actions.craft(item_name=item_name, count=count)
