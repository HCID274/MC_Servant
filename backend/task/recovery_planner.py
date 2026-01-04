# Recovery Planner Interfaces
# LLM-driven recovery types and abstractions

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .interfaces import ActionStep


class RecoveryDecisionType(Enum):
    ACT = "act"
    CLARIFY = "clarify"
    ABORT = "abort"
    RETRY_SAME = "retry_same"
    NEW_STEP = "new_step"  # LLM 提出新的执行步骤


@dataclass
class RecoveryDecision:
    decision: RecoveryDecisionType
    step: Optional["ActionStep"] = None
    next_step: Optional["ActionStep"] = None  # 别名，与 step 等价
    message: str = ""
    raw: Optional[Dict[str, Any]] = None

    def __post_init__(self):
        # next_step 是 step 的别名
        if self.next_step is None and self.step is not None:
            self.next_step = self.step
        elif self.step is None and self.next_step is not None:
            self.step = self.next_step


@dataclass
class RecoveryContext:
    """恢复上下文 - 传递给 LLM Recovery Planner"""
    goal: str = ""                    # 当前任务目标
    task_goal: str = ""               # 别名
    last_action: Optional[Dict[str, Any]] = None
    last_result: Optional[Any] = None  # ActionResult 或 Dict
    bot_state: Dict[str, Any] = field(default_factory=dict)
    recent_steps: List[Any] = field(default_factory=list)
    completed_steps: List[Any] = field(default_factory=list)  # 别名
    cached_action: Optional[Any] = None  # 当前缓存的动作步骤
    allowed_actions: List[str] = field(default_factory=list)
    attempt: int = 1
    max_attempts: int = 3
    is_final_attempt: bool = False
    user_reply: Optional[str] = None

    def __post_init__(self):
        # 字段别名同步
        if not self.goal and self.task_goal:
            self.goal = self.task_goal
        elif not self.task_goal and self.goal:
            self.task_goal = self.goal
        if not self.recent_steps and self.completed_steps:
            self.recent_steps = self.completed_steps


class IRecoveryPlanner(ABC):
    @abstractmethod
    async def recover(self, context: RecoveryContext) -> RecoveryDecision:
        """
        Decide recovery action based on context.

        Args:
            context: recovery context

        Returns:
            RecoveryDecision
        """
        raise NotImplementedError
