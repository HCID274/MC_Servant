# Recovery Interfaces
# 恢复系统的核心抽象层
#
# 设计原则：
# - 定义恢复策略的语义（不涉及具体实现）
# - 支持 L1-L4 分级恢复
# - 区分内联执行 vs 压栈执行

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ..bot.interfaces import ActionResult


# ============================================================================
# Enums
# ============================================================================

class RecoveryLevel(Enum):
    """
    恢复策略级别
    
    L0: 成功状态 (无需恢复)
    L1: 动作级重试 (最轻量)
    L2: 脱困策略 (连续失败时)
    L3: 报告并阻塞 (需要主人介入)
    L4: 超时兜底 (回主人身边)
    """
    L0_SUCCESS = "L0"
    L1_ACTION_RETRY = "L1"
    L2_UNSTUCK = "L2"
    L3_REPORT_BLOCK = "L3"
    L4_TIMEOUT_FALLBACK = "L4"


class RecoveryActionType(Enum):
    """
    恢复动作类型
    
    分类：
    - 内联执行 (is_inline=True): micro_move, retry_same, unstuck_*
    - 压栈执行 (is_inline=False): goto_owner, craft_prerequisite
    """
    # L1 策略
    RETRY_SAME = "retry_same"
    MICRO_MOVE = "micro_move"
    
    # L2 策略
    UNSTUCK_BACKOFF = "unstuck_backoff"
    UNSTUCK_STEP_UP = "unstuck_step_up"
    
    # L3 策略
    REPORT_AND_BLOCK = "report_and_block"
    
    # L4 策略
    GOTO_OWNER = "goto_owner"
    CLIMB_TO_SURFACE = "climb_to_surface"
    
    # 特殊
    NO_RECOVERY = "no_recovery"


# ============================================================================
# Data Structures
# ============================================================================

@dataclass
class CoordinatorRecoveryDecision:
    """
    恢复决策结果
    
    由 RecoveryCoordinator 返回，告诉 Runner 如何处理失败
    """
    level: RecoveryLevel
    action_type: RecoveryActionType
    should_retry: bool = True
    is_inline: bool = True  # True=当前Tick内解决, False=压栈给其他Runner
    params: dict = field(default_factory=dict)
    reason: str = ""

    def __repr__(self) -> str:
        return (
            f"CoordinatorRecoveryDecision({self.level.value}, {self.action_type.value}, "
            f"inline={self.is_inline}, reason={self.reason!r})"
        )


# Backward-compatible alias
RecoveryDecision = CoordinatorRecoveryDecision


@dataclass
class FailureContext:
    """
    失败上下文 - 传递给 RecoveryCoordinator 的信息
    """
    error_code: Optional[str]
    action_name: str
    consecutive_failures: int
    tick_count: int
    bot_position: Optional[dict] = None
    owner_position: Optional[dict] = None
    additional_info: dict = field(default_factory=dict)


# ============================================================================
# Interfaces
# ============================================================================

class IRecoveryCoordinator(ABC):
    """
    恢复协调器接口
    
    职责：
    - 消费 behavior_rules.json
    - 维护连续失败计数器 (按 Tick)
    - 根据 error_code 和计数器返回恢复决策
    """
    
    @abstractmethod
    def on_action_result(
        self, 
        result: "ActionResult", 
        tick: int
    ) -> RecoveryDecision:
        """
        处理动作结果，返回恢复决策
        
        Args:
            result: 动作执行结果
            tick: 当前 Tick 编号
            
        Returns:
            RecoveryDecision: 指示如何恢复
        """
        pass
    
    @abstractmethod
    def reset(self) -> None:
        """重置状态 (新任务开始时调用)"""
        pass
    
    @abstractmethod
    def get_consecutive_failures(self) -> int:
        """获取当前连续失败次数"""
        pass


class IRecoveryLogger(ABC):
    """
    恢复日志接口
    
    输出结构化 JSON 日志，便于调试和分析
    """
    
    @abstractmethod
    def log_recovery_decision(
        self,
        tick: int,
        decision: RecoveryDecision,
        context: FailureContext
    ) -> None:
        """记录恢复决策"""
        pass
    
    @abstractmethod
    def log_recovery_action_executed(
        self,
        tick: int,
        action_type: RecoveryActionType,
        success: bool,
        details: dict
    ) -> None:
        """记录恢复动作执行结果"""
        pass
