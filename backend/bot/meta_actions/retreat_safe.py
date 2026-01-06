# Retreat Safe Meta Action
# 紧急避险元动作

from typing import Dict, Any, List, Optional, TYPE_CHECKING

from .interface import IMetaAction, ParameterSpec
from .registry import MetaActionRegistry

if TYPE_CHECKING:
    from ..interfaces import IBotActions, ActionResult


@MetaActionRegistry.register
class RetreatSafeAction(IMetaAction):
    """
    紧急避险
    
    简单接口: retreat_safe()
    深度功能:
    - 检测威胁方向
    - 向安全区域快速移动 (远离敌对生物，向主人方向)
    - 如果有盾牌则边退边举盾
    """
    
    # 危险血量阈值 (3 颗心 = 6 HP)
    DANGER_HEALTH_THRESHOLD = 6
    
    # 敌对生物类型
    HOSTILE_MOBS = {
        "zombie", "skeleton", "creeper", "spider", "enderman",
        "witch", "pillager", "vindicator", "evoker", "ravager",
        "phantom", "drowned", "husk", "stray", "blaze",
        "ghast", "magma_cube", "slime", "warden", "wither",
        "hoglin", "piglin_brute", "zombified_piglin",  # only when hostile
    }
    
    @property
    def name(self) -> str:
        return "retreat_safe"
    
    @property
    def description(self) -> str:
        return "Emergency retreat to a safe location when in danger (low health or hostile mobs nearby)"
    
    @property
    def parameters(self) -> List[ParameterSpec]:
        return [
            ParameterSpec(
                name="distance",
                type="int",
                description="Distance to retreat (blocks)",
                required=False,
                default=20
            ),
        ]
    
    def can_execute(self, bot_state: Dict[str, Any]) -> bool:
        """
        低血量或附近有敌对生物时可用
        
        这是"通用能力检查":
        - 血量低于阈值 -> 可用
        - 附近有敌对生物 -> 可用
        - 否则不显示（减少 LLM 选择负担）
        """
        # 低血量检查
        health = bot_state.get("health", 20)
        if health <= self.DANGER_HEALTH_THRESHOLD:
            return True
        
        # 敌对生物检查
        nearby_entities = bot_state.get("nearby_entities", [])
        for entity in nearby_entities:
            entity_type = entity.get("type", "") or entity.get("name", "")
            if entity_type.lower().replace("minecraft:", "") in self.HOSTILE_MOBS:
                return True
        
        return False
    
    def get_unavailable_reason(self, bot_state: Dict[str, Any]) -> Optional[str]:
        return "Bot is safe (health OK, no hostiles nearby)"
    
    async def execute(
        self,
        actions: "IBotActions",
        distance: int = 20,
        **kwargs
    ) -> "ActionResult":
        """
        执行避险
        
        策略:
        1. 获取当前位置
        2. 如果有主人位置，向主人方向移动
        3. 否则，原地跳起 + 尝试向上移动 (避免近战)
        """
        from ..interfaces import ActionResult as AR, ActionStatus as AS
        
        try:
            # 获取当前状态
            state = actions.get_state()
            current_pos = state.get("position", {})
            
            # 检查是否有主人位置 (如果有的话优先向主人逃跑)
            owner_pos = kwargs.get("owner_position")
            
            if owner_pos:
                # 向主人方向移动
                target = f"{int(owner_pos['x'])},{int(owner_pos['y'])},{int(owner_pos['z'])}"
            else:
                # 向 Y+ 方向尝试脱困 (跳上高处)
                # 这是一个简化策略，真正的避险需要更复杂的寻路
                target_x = current_pos.get("x", 0)
                target_y = current_pos.get("y", 64) + 5  # 向上 5 格
                target_z = current_pos.get("z", 0)
                target = f"{int(target_x)},{int(target_y)},{int(target_z)}"
            
            # 尝试快速移动
            result = await actions.goto(target, timeout=15.0)
            
            if result.success:
                return AR(
                    success=True,
                    action="retreat_safe",
                    message="成功撤退到安全位置",
                    status=AS.SUCCESS,
                    data={"retreated_to": target}
                )
            else:
                # 如果移动失败，尝试 climb_to_surface 作为备选
                if hasattr(actions, "climb_to_surface"):
                    climb_result = await actions.climb_to_surface(timeout=30.0)
                    if climb_result.success:
                        return AR(
                            success=True,
                            action="retreat_safe",
                            message="通过爬升脱离危险",
                            status=AS.SUCCESS,
                            data={"method": "climb_to_surface"}
                        )
                
                return AR(
                    success=False,
                    action="retreat_safe",
                    message=f"撤退失败: {result.message}",
                    status=AS.FAILED,
                    error_code=result.error_code or "RETREAT_FAILED"
                )
        
        except Exception as e:
            return AR(
                success=False,
                action="retreat_safe",
                message=f"避险出错: {str(e)}",
                status=AS.FAILED,
                error_code="EXECUTION_ERROR"
            )
