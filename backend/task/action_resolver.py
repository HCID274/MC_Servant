# Action Resolver Implementation
# 语义动作落地层
#
# 设计原则：
# - 将 Actor 的语义输出转换为可执行的具体动作
# - 处理语义锚定 (owner/nearest → 坐标)
# - 决定 mine 使用 mine 还是 mine_tree

import logging
from typing import Dict, Any, Optional, List, TYPE_CHECKING

from .actor_interfaces import (
    ActorDecision,
    ActorActionType,
    GroundedAction,
    IActionResolver,
)
from .interfaces import RunContext

if TYPE_CHECKING:
    from ..perception.interfaces import IKnowledgeBase

logger = logging.getLogger(__name__)


# ============================================================================
# Owner Anchor Keywords
# ============================================================================

# 触发 owner 参照系的关键词
OWNER_ANCHOR_KEYWORDS = [
    # 中文
    "我", "我这", "我这边", "我附近", "附近", "身边", "旁边",
    "给我", "帮我", "到我", "来我", "主人",
    # 英文
    "owner", "me", "player", "near me", "nearby", "here",
]


# ============================================================================
# SemanticActionResolver Implementation
# ============================================================================

class SemanticActionResolver(IActionResolver):
    """
    语义动作解析器
    
    职责：
    - 将 ActorDecision (语义) 转换为 GroundedAction (具体)
    - 语义锚定: 根据关键词决定使用 owner_position 还是 bot_position
    - 采集策略: 根据目标类型决定使用 mine 还是 mine_tree
    """
    
    def __init__(
        self,
        knowledge_base: "IKnowledgeBase",
        default_search_radius: int = 32
    ):
        """
        初始化解析器
        
        Args:
            knowledge_base: 知识库 (用于判断目标类型)
            default_search_radius: 默认搜索半径
        """
        self._kb = knowledge_base
        self._default_radius = default_search_radius
        
        # 缓存 logs 类型候选列表
        self._logs_candidates: Optional[List[str]] = None
    
    @property
    def logs_candidates(self) -> List[str]:
        """获取 logs 类型的候选列表 (缓存)"""
        if self._logs_candidates is None:
            self._logs_candidates = self._kb.get_candidates("logs")
        return self._logs_candidates
    
    async def resolve(
        self,
        decision: ActorDecision,
        context: RunContext
    ) -> GroundedAction:
        """
        将语义决策落地为具体动作
        
        Args:
            decision: Actor 的语义决策
            context: 执行上下文
        
        Returns:
            GroundedAction: 可执行的具体动作
        """
        action = decision.action
        
        # 特殊动作直接透传
        if action == ActorActionType.DONE:
            return GroundedAction(
                action="done",
                params=decision.params,
                description=decision.params.get("message", "任务完成")
            )
        
        if action == ActorActionType.CLARIFY:
            return GroundedAction(
                action="clarify",
                params=decision.params,
                description=decision.clarify_question
            )
        
        # 根据动作类型分发处理
        if action == ActorActionType.MINE:
            return await self._resolve_mine(decision, context)
        elif action == ActorActionType.GOTO:
            return await self._resolve_goto(decision, context)
        elif action == ActorActionType.CRAFT:
            return self._resolve_craft(decision)
        elif action == ActorActionType.GIVE:
            return self._resolve_give(decision, context)
        elif action == ActorActionType.SCAN:
            return self._resolve_scan(decision, context)
        elif action == ActorActionType.EQUIP:
            return self._resolve_equip(decision)
        else:
            # 未知动作，尝试直接透传
            logger.warning(f"Unknown action type: {action}, passing through")
            return GroundedAction(
                action=action,
                params=decision.params,
                description=f"执行 {action}"
            )
    
    async def _resolve_mine(
        self,
        decision: ActorDecision,
        context: RunContext
    ) -> GroundedAction:
        """
        解析采集动作
        
        决策逻辑：
        1. 解析 target 到候选列表
        2. 判断是否是树木类 → 使用 mine_tree
        3. 确定搜索中心 (语义锚定)
        """
        target = decision.target or ""
        params = decision.params or {}
        count = params.get("count", 1)
        
        # 1. 解析目标到候选列表
        resolved_concept = self._kb.resolve_alias(target) if target else target
        candidates = self._kb.get_candidates(resolved_concept) if resolved_concept else []
        
        # 如果知识库返回空，尝试直接使用 target 作为 ID
        if not candidates and target:
            if self._kb.is_valid_id(target):
                candidates = [target]
            else:
                # 可能是中文，尝试解析别名
                resolved = self._kb.resolve_alias(target)
                if resolved != target:
                    candidates = self._kb.get_candidates(resolved)
        
        # 2. 判断是否是树木类
        is_tree_target = self._is_tree_target(candidates, target)
        
        # 3. 确定搜索中心
        search_center = self._determine_search_center(target, context)
        
        # 4. 构建落地动作
        if is_tree_target:
            grounded_params = {
                "search_radius": self._default_radius
            }
            if search_center:
                grounded_params["near_position"] = search_center
            
            return GroundedAction(
                action="mine_tree",
                params=grounded_params,
                description=f"砍树获取 {target or 'logs'}"
            )
        else:
            # 普通采集
            block_type = candidates[0] if candidates else target
            grounded_params = {
                "block_type": block_type,
                "count": count,
                "search_radius": self._default_radius
            }
            if search_center:
                grounded_params["near_position"] = search_center
            
            return GroundedAction(
                action="mine",
                params=grounded_params,
                description=f"采集 {count} 个 {block_type or target}"
            )
    
    def _is_tree_target(self, candidates: List[str], target: str) -> bool:
        """判断目标是否是树木类型"""
        # 检查候选列表是否与 logs 有交集
        if candidates:
            logs = self.logs_candidates
            if any(c in logs for c in candidates):
                return True
        
        # 检查 target 中是否包含树木相关关键词
        tree_keywords = ["tree", "log", "wood", "树", "木头", "原木", "砍"]
        target_lower = target.lower() if target else ""
        return any(kw in target_lower for kw in tree_keywords)
    
    def _determine_search_center(
        self,
        target: str,
        context: RunContext
    ) -> Optional[Dict[str, Any]]:
        """
        语义锚定 - 根据目标语义确定搜索中心
        
        返回:
            owner_position dict 或 None (使用 bot 当前位置)
        """
        target_lower = (target or "").lower()
        
        # 检查是否包含 owner 锚点关键词
        for keyword in OWNER_ANCHOR_KEYWORDS:
            if keyword in target_lower:
                if context.owner_position:
                    logger.debug(f"Using owner_position as search center (keyword: {keyword})")
                    return context.owner_position
                break
        
        # 默认不指定中心（使用 bot 当前位置）
        return None
    
    async def _resolve_goto(
        self,
        decision: ActorDecision,
        context: RunContext
    ) -> GroundedAction:
        """解析导航动作"""
        target = decision.target or ""
        
        # "owner" → 使用 owner_position
        if target.lower() in ["owner", "主人", "player", "me"]:
            if context.owner_position:
                pos = context.owner_position
                target_str = f"{int(pos['x'])},{int(pos['y'])},{int(pos['z'])}"
                return GroundedAction(
                    action="goto",
                    params={"target": target_str},
                    description="走到主人身边"
                )
            else:
                # 没有 owner_position，返回错误
                return GroundedAction(
                    action="goto",
                    params={"target": "0,64,0"},
                    description="无法获取主人位置"
                )
        
        # 如果 target 已经是坐标格式，直接使用
        if "," in target:
            return GroundedAction(
                action="goto",
                params={"target": target},
                description=f"导航到 {target}"
            )
        
        # 其他情况，尝试解析为玩家名
        return GroundedAction(
            action="goto",
            params={"target": f"@{target}"},
            description=f"导航到 {target}"
        )
    
    def _resolve_craft(self, decision: ActorDecision) -> GroundedAction:
        """解析合成动作"""
        target = decision.target or ""
        params = decision.params or {}
        count = params.get("count", 1)
        
        # 尝试解析别名
        resolved = self._kb.resolve_alias(target) if target else target
        item_name = resolved if self._kb.is_valid_id(resolved) else target
        
        return GroundedAction(
            action="craft",
            params={"item_name": item_name, "count": count},
            description=f"合成 {count} 个 {item_name}"
        )
    
    def _resolve_give(
        self,
        decision: ActorDecision,
        context: RunContext
    ) -> GroundedAction:
        """解析交付动作"""
        target = decision.target or ""
        params = decision.params or {}
        count = params.get("count", 1)
        
        # 获取主人名称
        player_name = context.owner_name or "unknown"
        
        # 解析物品名
        resolved = self._kb.resolve_alias(target) if target else target
        item_name = resolved if self._kb.is_valid_id(resolved) else target
        
        return GroundedAction(
            action="give",
            params={
                "player_name": player_name,
                "item_name": item_name,
                "count": count
            },
            description=f"把 {count} 个 {item_name} 交给 {player_name}"
        )
    
    def _resolve_scan(
        self,
        decision: ActorDecision,
        context: RunContext
    ) -> GroundedAction:
        """解析扫描动作"""
        target = decision.target or "block"
        params = decision.params or {}
        radius = params.get("radius", self._default_radius)
        
        # 确定扫描类型
        target_type = "block"
        entity_keywords = ["mob", "entity", "monster", "animal", "player", "怪物", "动物", "生物"]
        if any(kw in target.lower() for kw in entity_keywords):
            target_type = "entity"
        
        return GroundedAction(
            action="scan",
            params={"target_type": target_type, "radius": radius},
            description=f"扫描周围 {radius} 格内的 {target}"
        )
    
    def _resolve_equip(self, decision: ActorDecision) -> GroundedAction:
        """解析装备动作"""
        target = decision.target or ""
        
        # 解析物品名
        resolved = self._kb.resolve_alias(target) if target else target
        item_name = resolved if self._kb.is_valid_id(resolved) else target
        
        return GroundedAction(
            action="equip",
            params={"item_name": item_name},
            description=f"装备 {item_name}"
        )


# ============================================================================
# Factory Function
# ============================================================================

def create_action_resolver(
    knowledge_base: "IKnowledgeBase",
    search_radius: int = 32
) -> SemanticActionResolver:
    """
    创建 ActionResolver 实例的工厂函数
    
    Args:
        knowledge_base: 知识库实例
        search_radius: 默认搜索半径
    
    Returns:
        配置好的 SemanticActionResolver 实例
    """
    return SemanticActionResolver(
        knowledge_base=knowledge_base,
        default_search_radius=search_radius
    )
