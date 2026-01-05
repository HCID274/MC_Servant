# Task Interfaces
# 任务系统核心接口定义

import abc
import enum
from typing import List, Dict, Any, Optional, Union, Tuple, Protocol, runtime_checkable

# ============================================================================
# Enums
# ============================================================================

class TaskStatus(enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    IN_PROGRESS = "in_progress" # 🆕 Add this back as it's used in stack_planner
    BLOCKED = "blocked" # 🆕 Add this back as it's used in stack_planner
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class TaskType(enum.Enum):
    """
    任务类型枚举
    
    用于路由到不同的 Runner:
    - UniversalRunner: 覆盖所有类型 (Phase 3+)
    """
    GATHER = "gather"  # 采集 (树木/矿物/掉落物)
    CRAFT = "craft"    # 合成 (含熔炼)
    BUILD = "build"    # 建造
    GOTO = "goto"      # 移动/跟随
    GIVE = "give"      # 交付/丢弃
    COMBAT = "combat"  # 战斗
    FOLLOW = "follow"  # 跟随玩家
    IDLE = "idle"      # 空闲/发呆


class TaskResultStatus(enum.Enum):
    """任务结果状态详细码"""
    SUCCESS = "success"
    FAILED = "failed"
    WAITING_FOR_USER = "waiting_for_user"  # 🆕 需要用户澄清
    RETRY_NEEDED = "retry_needed"


# ============================================================================
# Data Classes
# ============================================================================

class StackTask:
    """栈中的单个任务"""
    def __init__(
        self,
        name: str,
        goal: str,
        context: Optional[Dict[str, Any]] = None,
        status: TaskStatus = TaskStatus.PENDING,
        priority: int = 0,
        task_type: Optional[TaskType] = None,
        params: Optional[Dict[str, Any]] = None,
        blocking_reason: Optional[str] = None, # 🆕 Added blocking_reason
    ):
        self.name = name
        self.goal = goal
        self.context = context or {}
        self.status = status
        self.priority = priority
        self.task_type = task_type
        self.params = params or {}
        self.blocking_reason = blocking_reason

    def __repr__(self):
        return f"<StackTask: {self.name} ({self.status.value})>"


class ActionStep:
    """单个动作步骤 (LLM 输出或代码生成)"""
    def __init__(
        self,
        action: str,
        params: Optional[Dict[str, Any]] = None,
        description: str = "",
        thoughts: Optional[str] = None,
    ):
        self.action = action
        self.params = params or {}
        self.description = description
        self.thoughts = thoughts

    def __repr__(self):
        return f"<ActionStep: {self.action} {self.params}>"


class ActionPlan:
    """动作序列 (Linear Plan)"""
    def __init__(self, steps: List[ActionStep]):
        self.steps = steps


class TaskResult:
    """任务执行结果"""
    def __init__(
        self,
        success: bool,
        task_description: str,
        completed_steps: Optional[List[Any]] = None,  # List[ActionResult]
        failed_step: Optional[Any] = None,            # ActionResult
        message: str = "",
        status: Optional[TaskResultStatus] = None,    # 🆕 详细状态
        dynamic_tasks: Optional[List[str]] = None,    # 🆕 动态生成的子任务 (Slow Path)
    ):
        self.success = success
        self.task_description = task_description
        self.completed_steps = completed_steps or []
        self.failed_step = failed_step
        self.message = message
        self.status = status or (TaskResultStatus.SUCCESS if success else TaskResultStatus.FAILED)
        self.dynamic_tasks = dynamic_tasks

    def __repr__(self):
        return f"<TaskResult: success={self.success} msg='{self.message}'>"


class RunContext:
    """
    运行时上下文
    
    在 executor.execute() 时创建，传递给 Runner。
    包含一次执行会话所需的动态信息。
    """
    def __init__(
        self,
        owner_name: Optional[str] = None,
        owner_position: Optional[dict] = None,
        on_progress: Optional[Any] = None,  # Callable[[str], Awaitable[None]]
        max_ticks: int = 50,  # 默认最大 tick 数
        overall_timeout: float = 300.0, # 默认总超时时间 (秒)
        user_reply: Optional[str] = None, # 🆕 用户回复内容 (用于澄清)
    ):
        self.owner_name = owner_name
        self.owner_position = owner_position
        self.on_progress = on_progress
        self.max_ticks = max_ticks
        self.overall_timeout = overall_timeout
        self.user_reply = user_reply


# ============================================================================
# Interfaces (Abstract Base Classes)
# ============================================================================

class ITaskPlanner(abc.ABC):
    """
    任务规划器接口
    
    负责:
    1. plan_tasks: 自然语言 -> 任务列表 (Decomposer)
    2. act: 状态感知 -> 单步动作 (ReAct Loop)
    """
    
    @abc.abstractmethod
    async def plan_tasks(self, user_instruction: str) -> List[StackTask]:
        """将用户指令分解为任务列表"""
        pass
        
    @abc.abstractmethod
    async def act(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        completed_steps: List[Any],
    ) -> Tuple[Optional[ActionStep], bool, str]:
        """
        根据当前状态决策下一步动作

        Returns:
            (next_step, is_done, done_message)
        """
        pass


class IPrerequisiteResolver(abc.ABC):
    """
    前置任务解析器接口 (Fast Path)
    
    负责处理确定性错误 (如缺少物品、缺少工具)，生成前置任务。
    """
    
    @abc.abstractmethod
    def resolve(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> Optional[StackTask]:
        """
        根据错误码和上下文，生成前置任务
        
        Args:
            error_code: 错误码 (e.g. "INSUFFICIENT_MATERIALS")
            context: 错误上下文 (e.g. {"missing": {"oak_log": 3}})
            inventory: 当前背包状态
            
        Returns:
            StackTask: 补救任务，如果无法解决则返回 None
        """
        pass


class ITaskExecutor(abc.ABC):
    """
    任务执行器接口
    
    负责管理任务栈、调用 Runner 执行任务。
    """
    
    @property
    @abc.abstractmethod
    def is_running(self) -> bool:
        """是否正在执行"""
        pass

    @property
    @abc.abstractmethod
    def current_task(self) -> Optional[StackTask]:
        """当前任务"""
        pass

    @abc.abstractmethod
    async def execute(
        self,
        task_description: str,
        task_type: Optional[str] = None,
        task_payload: Optional[Dict[str, Any]] = None,
    ) -> TaskResult:
        """执行任务"""
        pass
    
    @abc.abstractmethod
    def cancel(self) -> None:
        """取消执行"""
        pass


class ITaskDecomposer(abc.ABC):
    """任务分解器接口"""
    @abc.abstractmethod
    async def decompose(self, instruction: str) -> List[StackTask]:
        pass


# ============================================================================
# Runner Interfaces (Strategy Pattern)
# ============================================================================

class ITaskRunner(abc.ABC):
    """
    任务执行策略接口
    
    不同的任务类型可以使用不同的 Runner 实现:
    - UniversalRunner: 通用 ReAct 循环 (Phase 3+)
    """
    
    @property
    @abc.abstractmethod
    def supported_types(self) -> List[TaskType]:
        """该 Runner 支持的任务类型列表"""
        pass

    @abc.abstractmethod
    async def run(
        self,
        task: StackTask,
        actions: Any,  # IBotActions (avoid circular import)
        planner: ITaskPlanner,
        context: RunContext
    ) -> TaskResult:
        """
        执行单个任务
        
        Args:
            task: 待执行的任务
            actions: Bot 动作接口
            planner: 规划器 (用于 ReAct 循环)
            context: 运行时上下文
            
        Returns:
            TaskResult: 执行结果
        """
        pass


class IRunnerFactory(Protocol):
    """Runner 工厂接口"""
    def create(self, task: StackTask) -> ITaskRunner:
        """为给定任务创建/获取合适的 Runner"""
        ...

class IActionResolver(Protocol):
    """动作参数解析器接口 (e.g. "wood" -> "oak_log")"""
    def resolve_concept(self, concept: str) -> str:
        """将自然语言概念解析为具体 ID"""
        ...

    def get_candidates(self, concept: str) -> List[str]:
        """获取概念对应的所有候选 ID"""
        ...
