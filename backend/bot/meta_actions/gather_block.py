# Gather Block Action - 采集方块
#
# 包装现有 actions.mine()
# 使用 ToolMatcherMixin 实现完整的工具-方块匹配逻辑

import logging
from typing import Dict, Any, List, Optional, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec, ToolMatcherMixin
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


@MetaActionRegistry.register
class GatherBlockAction(IMetaAction, ToolMatcherMixin):
    """
    采集方块 (自动导航 + 挖掘)
    
    特性:
    - 完整的工具-方块匹配逻辑
    - 自动检查背包是否有合适的工具
    - 不可用时提供详细原因
    """
    
    @property
    def name(self) -> str:
        return "gather_block"
    
    @property
    def description(self) -> str:
        return (
            "Navigate to and mine a specific block type. "
            "Automatically checks for required tools. "
            "Use this for collecting resources like ores, logs, and stones."
        )
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="block_type",
                type="str",
                description="Type of block to mine (e.g., 'iron_ore', 'oak_log', 'stone')",
                required=True
            ),
            ParameterSpec(
                name="count",
                type="int",
                description="Number of blocks to gather",
                required=False,
                default=1
            ),
            ParameterSpec(
                name="near_position",
                type="dict",
                description="Optional search center: {x, y, z}",
                required=False
            )
        ]
    
    # 缓存最近一次检查的方块类型（用于 get_unavailable_reason）
    _last_checked_block: Optional[str] = None
    _last_missing_tool: Optional[str] = None
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """
        检查是否满足采集条件
        
        检查项:
        1. 健康值不能太低
        2. 背包有合适的工具 (如果需要)
        """
        # 检查健康
        health = bot_state.get("health", 20)
        if health < 4:
            return False
        
        # 获取请求的方块类型 (从上下文或默认可用)
        # 注意: 在动态过滤阶段，我们不知道具体要挖什么方块
        # 所以只要有任意工具就认为可用
        inventory = bot_state.get("inventory", {})
        
        # 检查是否有任何挖掘工具
        has_any_tool = any(
            any(tool_type in item for tool_type in ["pickaxe", "axe", "shovel"])
            for item in inventory.keys()
        )
        
        # 即使没有工具，也可以徒手挖掘某些方块
        return True  # 总是允许，具体检查在 execute 时进行
    
    def can_gather_block(
        self, 
        block_type: str, 
        bot_state: Dict[str, Any]
    ) -> bool:
        """
        检查是否能采集特定方块
        
        这是更精确的检查，在 execute 前调用
        """
        inventory = bot_state.get("inventory", {})
        
        has_tool = self.has_required_tool(block_type, inventory)
        
        if not has_tool:
            self._last_checked_block = block_type
            self._last_missing_tool = self.get_missing_tool_requirement(
                block_type, inventory
            )
        
        return has_tool
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> Optional[str]:
        health = bot_state.get("health", 20)
        if health < 4:
            return "Health too low to mine"
        
        if self._last_missing_tool:
            return self._last_missing_tool
        
        return None
    
    async def execute(
        self, 
        actions: "IBotActions", 
        **params
    ) -> "ActionResult":
        """执行采集"""
        from ..interfaces import ActionResult
        
        block_type = params.get("block_type")
        count = params.get("count", 1)
        near_position = params.get("near_position")
        timeout = params.get("timeout")
        
        if not block_type:
            return ActionResult(
                success=False,
                action="gather_block",
                error_code="MISSING_PARAM",
                message="block_type is required"
            )
        
        # 获取当前 Bot 状态进行工具检查
        try:
            bot_state = await actions.get_state()
            inventory = bot_state.get("inventory", {})
            
            if not self.has_required_tool(block_type, inventory):
                missing = self.get_missing_tool_requirement(block_type, inventory)
                return ActionResult(
                    success=False,
                    action="gather_block",
                    error_code="NO_TOOL",
                    message=f"Cannot mine {block_type}: {missing}",
                    data={"missing_tool": missing, "block_type": block_type}
                )
            
            # 尝试装备最佳工具
            best_tool = self.get_best_tool(block_type, inventory)
            if best_tool:
                logger.debug(f"[GatherBlockAction] Equipping {best_tool}")
                # 装备工具的逻辑由底层 actions.mine 处理
        except Exception as e:
            logger.warning(f"[GatherBlockAction] State check failed: {e}")
        
        logger.info(f"[GatherBlockAction] Mining {count}x {block_type}")
        
        # 委托给底层 Driver
        kwargs = {"block_type": block_type, "count": count}
        if near_position:
            kwargs["near_position"] = near_position
        if timeout is not None:
            kwargs["timeout"] = timeout
        
        return await actions.mine(**kwargs)
