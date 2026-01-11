# Look Around Action - 观察周围
#
# 包装现有 actions.scan()

from typing import Dict, Any, List, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult


@MetaActionRegistry.register
class LookAroundAction(IMetaAction):
    """
    观察周围

    默认扫描附近玩家/实体，返回 LLM 友好的环境信息。
    """

    @property
    def name(self) -> str:
        return "look_around"

    @property
    def description(self) -> str:
        return "Look around nearby area and scan for targets"

    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="target_type",
                type="str",
                description="Target type to scan (e.g., 'player', 'mob', 'item')",
                required=False,
                default="player"
            ),
            ParameterSpec(
                name="radius",
                type="int",
                description="Scan radius in blocks",
                required=False,
                default=16
            ),
            ParameterSpec(
                name="count",
                type="int",
                description="Maximum number of results to return",
                required=False,
                default=5
            ),
        ]

    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        return True

    async def execute(
        self,
        actions: "IBotActions",
        **params
    ) -> "ActionResult":
        target_type = params.get("target_type") or "player"
        radius = params.get("radius", 16)
        count = params.get("count", 5)

        result = await actions.scan(target_type=target_type, radius=radius)
        if result and result.success and isinstance(count, int) and count > 0 and isinstance(result.data, dict):
            targets = result.data.get("targets")
            if isinstance(targets, list) and len(targets) > count:
                result.data["targets"] = targets[:count]
        return result
