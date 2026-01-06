# Navigate Action - 导航到指定位置
#
# 包装现有 actions.goto()

import logging
from typing import Dict, Any, List, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


@MetaActionRegistry.register
class NavigateAction(IMetaAction):
    """
    导航到指定位置
    
    简单包装 actions.goto()，几乎总是可用
    """
    
    @property
    def name(self) -> str:
        return "navigate"
    
    @property
    def description(self) -> str:
        return "Navigate to a specific coordinate (x, y, z) or a named location"
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="target",
                type="str",
                description="Target position as 'x,y,z' or a named location",
                required=True
            ),
            ParameterSpec(
                name="sprint",
                type="bool",
                description="Whether to sprint while moving",
                required=False,
                default=True
            )
        ]
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """导航几乎总是可用"""
        # 检查健康值 (太低不应移动)
        health = bot_state.get("health", 20)
        if health < 2:
            return False
        
        return True
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> str:
        health = bot_state.get("health", 20)
        if health < 2:
            return "Health too low to navigate"
        return ""
    
    async def execute(
        self, 
        actions: "IBotActions", 
        **params
    ) -> "ActionResult":
        """执行导航"""
        target = params.get("target")
        
        if not target:
            from ..interfaces import ActionResult
            return ActionResult(
                success=False,
                action="navigate",
                error_code="MISSING_PARAM",
                message="Target is required"
            )
        
        logger.info(f"[NavigateAction] Moving to: {target}")
        return await actions.goto(target=target)
