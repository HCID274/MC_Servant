# Smelt Item Meta Action
# 冶炼物品元动作

from typing import Dict, Any, List, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult


@MetaActionRegistry.register
class SmeltItemAction(IMetaAction):
    """
    冶炼物品
    
    简单接口: smelt_item(item="raw_iron", count=3)
    深度功能:
    - 自动查找/放置熔炉
    - 自动选择燃料
    - 等待冶炼完成
    """
    
    # 可冶炼物品 (与 CraftingSystem.SMELTABLE_ITEMS 保持同步)
    SMELTABLE = {
        "raw_iron", "raw_gold", "raw_copper",
        "iron_ore", "gold_ore", "copper_ore",
        "sand", "cobblestone",
        "oak_log", "spruce_log", "birch_log", "jungle_log",
        "acacia_log", "dark_oak_log", "cherry_log", "mangrove_log",
        "clay_ball", "netherrack", "wet_sponge", "kelp", "cactus",
        "ancient_debris",
    }
    
    @property
    def name(self) -> str:
        return "smelt_item"
    
    @property
    def description(self) -> str:
        return "Smelt raw materials in a furnace (e.g., raw_iron → iron_ingot, sand → glass)"
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="item",
                type="str",
                description="Raw item to smelt (e.g., 'raw_iron', 'sand', 'cobblestone')",
                required=True
            ),
            ParameterSpec(
                name="count",
                type="int",
                description="Number of items to smelt",
                required=False,
                default=1
            ),
        ]
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """
        检查是否有可冶炼的材料
        
        注意: 这是"通用能力检查"，不是参数检查
        只要背包里有任何可冶炼材料就返回 True
        """
        inventory = bot_state.get("inventory", {})
        
        # 检查是否有任何可冶炼材料
        for item in self.SMELTABLE:
            if inventory.get(item, 0) > 0:
                return True
        
        return False
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> str:
        return "No smeltable materials in inventory"
    
    async def execute(
        self,
        actions: "IBotActions",
        item: str = "",
        count: int = 1,
        **kwargs
    ) -> "ActionResult":
        """
        执行冶炼
        
        委托给底层 BotActions.smelt()
        """
        # Normalize parameter names
        item_name = item or kwargs.get("item_name", "")
        timeout = kwargs.get("timeout")
        
        if not item_name:
            from ..interfaces import ActionResult as AR, ActionStatus as AS
            return AR(
                success=False,
                action="smelt_item",
                message="Missing required parameter: item",
                status=AS.FAILED,
                error_code="INVALID_PARAMS"
            )
        
        if timeout is None:
            return await actions.smelt(item_name, count=count)
        return await actions.smelt(item_name, count=count, timeout=timeout)
