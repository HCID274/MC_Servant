# Actor Layer Interfaces
# Actor 层抽象接口定义
#
# 设计原则：
# - Actor 只输出语义意图，不输出坐标
# - 符号层 (ActionResolver) 负责落地
# - 依赖抽象，而非具体

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, TYPE_CHECKING

if TYPE_CHECKING:
    from .interfaces import RunContext


# ============================================================================
# Action Type Constants
# ============================================================================

class ActorActionType:
    """
    Actor 可输出的动作类型常量
    
    设计决策：
    - mine: 统一的采集动作，符号层决定是 mine 还是 mine_tree
    - clarify: 懒惰澄清，向玩家提问
    - done: 任务完成
    """
    MINE = "mine"           # 采集 (符号层决定 mine/mine_tree)
    GOTO = "goto"           # 导航
    CRAFT = "craft"         # 合成
    GIVE = "give"           # 交付
    EQUIP = "equip"         # 装备
    SCAN = "scan"           # 扫描
    CLARIFY = "clarify"     # 澄清提问
    DONE = "done"           # 任务完成


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class ActorDecision:
    """
    Actor 的单步决策输出
    
    设计原则：
    - action: 语义动作类型 (mine, goto, clarify, done)
    - target: 语义目标 (logs, owner, nearest_tree)，不含坐标
    - params: 动作参数 (count, question, choices 等)
    - reasoning: 决策理由 (用于调试/日志)
    
    Attributes:
        action: 动作类型 (ActorActionType 常量)
        target: 语义目标描述 (如 "logs", "owner", "iron_ore")
        params: 额外参数字典
            - mine: {"count": int}
            - clarify: {"question": str, "choices": List[str], "default": str}
            - done: {"message": str}
        reasoning: 决策理由 (仅用于日志，不影响执行)
    
    Examples:
        # 采集木头
        ActorDecision(action="mine", target="logs", params={"count": 10})
        
        # 澄清提问
        ActorDecision(
            action="clarify", 
            target=None,
            params={
                "question": "您想要哪种木头？",
                "choices": ["橡木", "白桦木", "任意"],
                "default": "任意"
            }
        )
        
        # 任务完成
        ActorDecision(action="done", params={"message": "采集完成！"})
    """
    action: str
    target: Optional[str] = None
    params: Dict[str, Any] = field(default_factory=dict)
    reasoning: str = ""
    
    def __repr__(self) -> str:
        target_str = f", target={self.target}" if self.target else ""
        return f"ActorDecision({self.action}{target_str})"
    
    @property
    def is_done(self) -> bool:
        """是否是完成动作"""
        return self.action == ActorActionType.DONE
    
    @property
    def is_clarify(self) -> bool:
        """是否是澄清动作"""
        return self.action == ActorActionType.CLARIFY
    
    @property
    def clarify_question(self) -> str:
        """获取澄清问题"""
        return self.params.get("question", "") if self.is_clarify else ""
    
    @property
    def clarify_choices(self) -> List[str]:
        """获取澄清选项"""
        return self.params.get("choices", []) if self.is_clarify else []


@dataclass
class GroundedAction:
    """
    落地后的具体动作
    
    由 IActionResolver.resolve() 产出，供 IBotActions 执行
    
    Attributes:
        action: 实际执行的动作名 (mine_tree, mine, goto 等)
        params: 具体参数 (包含坐标、block_type 等)
        description: 人类可读描述 (用于日志/头顶显示)
    """
    action: str
    params: Dict[str, Any] = field(default_factory=dict)
    description: str = ""
    
    def __repr__(self) -> str:
        return f"GroundedAction({self.action}, {self.description or self.params})"


# ============================================================================
# Abstract Interfaces
# ============================================================================

class ITaskActor(ABC):
    """
    任务执行者抽象接口
    
    职责：
    - 根据任务目标和当前状态决策下一步动作
    - 只输出语义意图，不输出具体坐标
    - 每次决策只产出 1 个 ActorDecision
    
    实现：
    - LLMTaskActor: 调用 LLM 进行决策
    
    设计原则：
    - 与 ITaskPlanner 区别：Planner 产出多步计划，Actor 只产出当前一步
    - 用于 Tick Loop 执行模式 (采集/战斗等非确定性任务)
    """
    
    @abstractmethod
    async def decide(
        self,
        task_goal: str,
        bot_state: Dict[str, Any],
        last_result: Optional[Dict[str, Any]] = None
    ) -> ActorDecision:
        """
        决策下一步动作
        
        Args:
            task_goal: 任务目标描述 (如 "采集 10 个木头")
            bot_state: Bot 当前状态 (位置、背包、owner_position 等)
            last_result: 上一步动作的结果 (可选)
                {
                    "action": str,
                    "success": bool,
                    "message": str,
                    "error_code": str,
                    "data": Any
                }
        
        Returns:
            ActorDecision: 语义化的决策结果
        """
        pass


class IActionResolver(ABC):
    """
    动作解析器抽象接口 (语义落地层)
    
    职责：
    - 将 ActorDecision (语义) 转换为 GroundedAction (具体)
    - 处理语义锚定 (owner/nearest → 坐标)
    - 决定 mine 使用 mine 还是 mine_tree
    
    实现：
    - SemanticActionResolver: 基于 KnowledgeBase 的语义解析
    
    设计原则：
    - Resolver 只负责落地，不做决策
    - 落地失败返回带错误信息的 GroundedAction (让 Actor 下一轮处理)
    """
    
    @abstractmethod
    async def resolve(
        self,
        decision: ActorDecision,
        context: "RunContext"
    ) -> GroundedAction:
        """
        将语义决策落地为具体动作
        
        Args:
            decision: Actor 的语义决策
            context: 执行上下文 (包含 owner_position 等)
        
        Returns:
            GroundedAction: 可直接执行的具体动作
        """
        pass
