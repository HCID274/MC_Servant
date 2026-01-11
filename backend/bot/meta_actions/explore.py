# Explore Action - 探索附近区域
#
# 包装现有 actions.patrol()

from typing import Dict, Any, List, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult


@MetaActionRegistry.register
class ExploreAction(IMetaAction):
    """
    探索附近区域

    默认使用当前位置作为中心点，调用 actions.patrol() 实现随机巡逻。
    """

    @property
    def name(self) -> str:
        return "explore"

    @property
    def description(self) -> str:
        return "Explore the nearby area by patrolling around the current position"

    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="radius",
                type="int",
                description="Explore radius in blocks",
                required=False,
                default=20
            ),
            ParameterSpec(
                name="duration",
                type="int",
                description="Explore duration in seconds",
                required=False,
                default=30
            ),
        ]

    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        health = bot_state.get("health", 20)
        return health >= 2

    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> str:
        health = bot_state.get("health", 20)
        if health < 2:
            return "Health too low to explore"
        return ""

    async def execute(
        self,
        actions: "IBotActions",
        **params
    ) -> "ActionResult":
        from ..interfaces import ActionResult as AR, ActionStatus as AS

        state = actions.get_state()
        if not isinstance(state, dict):
            return AR(
                success=False,
                action="explore",
                message="Missing bot state for explore",
                status=AS.FAILED,
                error_code="STATE_UNAVAILABLE"
            )

        pos = state.get("position", {}) or {}
        center_x = int(pos.get("x", 0))
        center_z = int(pos.get("z", 0))

        radius = params.get("radius", 20)
        duration = params.get("duration", 30)
        timeout = params.get("timeout")

        kwargs = {
            "center_x": center_x,
            "center_z": center_z,
            "radius": radius,
            "duration": duration,
        }
        if timeout is not None:
            kwargs["timeout"] = timeout

        return await actions.patrol(**kwargs)
