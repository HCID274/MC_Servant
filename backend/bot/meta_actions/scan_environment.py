# Scan Environment Action - 扫描周围环境
#
# 包装现有 actions.scan()

import logging
from typing import Dict, Any, List, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult

logger = logging.getLogger(__name__)


@MetaActionRegistry.register
class ScanEnvironmentAction(IMetaAction):
    """
    扫描周围环境
    
    生成 LLM 友好的环境报告，用于决策
    """
    
    @property
    def name(self) -> str:
        return "scan_environment"
    
    @property
    def description(self) -> str:
        return (
            "Scan the surrounding area for specific targets (blocks, entities). "
            "Returns a list of found targets with their positions and distances."
        )
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="target_type",
                type="str",
                description="Type of target to scan for (e.g., 'iron_ore', 'zombie', 'player')",
                required=True
            ),
            ParameterSpec(
                name="radius",
                type="int",
                description="Search radius in blocks",
                required=False,
                default=32
            ),
            ParameterSpec(
                name="count",
                type="int",
                description="Maximum number of results to return",
                required=False,
                default=5
            )
        ]
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """扫描总是可用"""
        return True
    
    async def execute(
        self, 
        actions: "IBotActions", 
        **params
    ) -> "ActionResult":
        """执行扫描"""
        target_type = params.get("target_type")
        radius = params.get("radius", 32)
        count = params.get("count", 5)
        
        if not target_type:
            from ..interfaces import ActionResult
            return ActionResult(
                success=False,
                action="scan_environment",
                error_code="MISSING_PARAM",
                message="target_type is required"
            )
        
        logger.info(
            f"[ScanEnvironmentAction] Scanning for {target_type} "
            f"(radius={radius}, count={count})"
        )
        
        return await actions.scan(
            target_type=target_type,
            radius=radius,
            count=count
        )
