# Task System Interfaces
# 任务系统抽象接口定义
#
# 设计原则：简单接口，深度功能；依赖抽象，而非具体

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, TYPE_CHECKING
from enum import Enum

if TYPE_CHECKING:
    from ..bot.interfaces import ActionResult


# ============================================================================
# Task Status Enum
# ============================================================================

class TaskStatus(Enum):
    """任务状态枚举"""
    PENDING = "pending"           # 待执行
    IN_PROGRESS = "in_progress"   # 执行中
    BLOCKED = "blocked"           # 被阻塞 (有前置任务在执行)
    COMPLETED = "completed"       # 已完成
    FAILED = "failed"             # 失败


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class StackTask:
    """
    栈中的单个任务
    
    Attributes:
        name: 任务名称 (人类可读，如 "合成木棍")
        goal: 任务目标 (机器可解析，如 "craft stick 4")
        context: 上下文数据 (如来源任务、尝试次数)
        status: 任务状态
        blocking_reason: 阻塞原因 (如 "缺少 oak_planks")
    """
    name: str
    goal: str
    context: Dict[str, Any] = field(default_factory=dict)
    status: TaskStatus = TaskStatus.PENDING
    blocking_reason: Optional[str] = None
    
    def __repr__(self) -> str:
        return f"StackTask({self.name}, status={self.status.value})"


@dataclass
class ActionStep:
    """
    单个动作步骤
    
    Attributes:
        action: 动作名称 (必须与 MineflayerActions 方法名一致)
                如: "goto", "mine", "craft", "place", "give", "equip", "scan"
        params: 动作参数 (键名必须与方法参数一致)
                可选 timeout_sec 覆盖默认超时
        description: 人类可读描述 (用于日志/反馈)
    
    Example:
        ActionStep(
            action="mine",
            params={"block_type": "oak_log", "count": 5, "timeout_sec": 60},
            description="采集5个橡木原木"
        )
    """
    action: str
    params: Dict[str, Any]
    description: str = ""
    
    def __repr__(self) -> str:
        return f"ActionStep({self.action}, {self.description or self.params})"


@dataclass
class ActionPlan:
    """
    任务执行计划
    
    由 ITaskPlanner.plan() 生成，包含一系列有序的动作步骤
    
    Attributes:
        task_description: 原始任务描述
        steps: 动作步骤列表 (有序)
        estimated_time: 预估执行时间 (秒)
    """
    task_description: str
    steps: List[ActionStep]
    estimated_time: int = 0
    
    def __repr__(self) -> str:
        return f"ActionPlan({self.task_description}, {len(self.steps)} steps)"


@dataclass
class TaskResult:
    """
    任务执行结果
    
    由 TaskExecutor.execute() 返回
    
    Attributes:
        success: 是否成功
        task_description: 任务描述
        completed_steps: 已完成的动作结果列表
        failed_step: 失败的动作结果 (如果有)
        message: 结果描述 (人类可读)
    """
    success: bool
    task_description: str
    completed_steps: List["ActionResult"] = field(default_factory=list)
    failed_step: Optional["ActionResult"] = None
    message: str = ""
    
    def __repr__(self) -> str:
        status = "✅" if self.success else "❌"
        return f"TaskResult({status} {self.task_description})"


# ============================================================================
# Abstract Interfaces
# ============================================================================

class ITaskPlanner(ABC):
    """
    任务规划器抽象接口
    
    职责：
    - 根据任务描述和 Bot 状态生成可执行的动作计划
    - 失败后根据错误信息重新规划
    
    实现：
    - LLMTaskPlanner: 调用大模型生成计划
    """
    
    @abstractmethod
    async def plan(
        self, 
        task_description: str, 
        bot_state: Dict[str, Any]
    ) -> ActionPlan:
        """
        规划任务
        
        Args:
            task_description: 任务描述 (如 "采集5个铁矿")
            bot_state: Bot 当前状态 (位置、背包、血量等)
            
        Returns:
            ActionPlan: 可执行的动作计划
        """
        pass
    
    @abstractmethod
    async def replan(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        failed_result: "ActionResult",
        completed_steps: List["ActionResult"]
    ) -> ActionPlan:
        """
        任务重规划 (执行失败后)
        
        根据失败原因和已完成的步骤，生成新的执行计划
        
        Args:
            task_description: 原始任务描述
            bot_state: Bot 当前状态
            failed_result: 失败的动作结果 (包含 error_code)
            completed_steps: 已完成的动作结果列表
            
        Returns:
            ActionPlan: 新的执行计划
        """
        pass


class IPrerequisiteResolver(ABC):
    """
    前置任务解析器抽象接口 (符号层)
    
    职责：
    - 根据错误码推断需要的前置任务
    - 这是 Neuro-Symbolic 架构的 Symbolic 层
    
    处理的错误码：
    - INSUFFICIENT_MATERIALS: 材料不足 → 尝试合成/采集
    - NO_TOOL: 没有合适工具 → 尝试合成工具
    
    返回 None 表示符号层无法解决，交给 LLM 处理
    """
    
    @abstractmethod
    def resolve(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> Optional[StackTask]:
        """
        解析前置任务
        
        Args:
            error_code: 错误码 (如 "INSUFFICIENT_MATERIALS", "NO_TOOL")
            context: 错误上下文 (如 {"missing": {"oak_planks": 2}})
            inventory: 当前背包内容 {item_name: count}
            
        Returns:
            StackTask: 需要先完成的前置任务
            None: 符号层无法解决
        """
        pass


class ITaskExecutor(ABC):
    """
    任务执行器抽象接口
    
    职责：
    - 协调 Planner、Stack、Actions
    - 驱动任务执行循环
    - 处理失败和前置任务压栈
    """
    
    @abstractmethod
    async def execute(
        self,
        task_description: str,
        task_type: Optional[str] = None,
        task_payload: Optional[Dict[str, Any]] = None,
    ) -> TaskResult:
        """
        执行任务直到完成或失败
        
        这是顶层入口，负责：
        1. 创建根任务并压入栈
        2. 驱动 while 循环执行栈中任务
        3. 处理前置任务的递归压栈
        
        Args:
            task_description: 任务描述
            task_type: 可选，来自意图识别/状态机的任务类型（如 "mine" / "build" / "goto"）
            task_payload: 可选，状态机透传的原始事件 payload（可包含玩家坐标、实体信息等）
            
        Returns:
            TaskResult: 执行结果
        """
        pass
    
    @abstractmethod
    def cancel(self) -> None:
        """
        取消当前执行
        
        清空任务栈，停止执行循环
        """
        pass
    
    @property
    @abstractmethod
    def is_running(self) -> bool:
        """是否正在执行任务"""
        pass
