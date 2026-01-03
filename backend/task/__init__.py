# Task Module
# 任务系统 - 栈式任务规划与执行

from .interfaces import (
    TaskStatus,
    TaskType,
    StackTask,
    ActionStep,
    ActionPlan,
    TaskResult,
    RunContext,
    ITaskPlanner,
    IPrerequisiteResolver,
    ITaskExecutor,
    ITaskDecomposer,
    ITaskRunner,
)
from .stack_planner import StackPlanner, StackOverflowError
from .prerequisite_resolver import PrerequisiteResolver
from .llm_planner import LLMTaskPlanner
from .executor import TaskExecutor
from .decomposer import LLMTaskDecomposer
from .runners import GatherRunner, LinearPlanRunner, RunnerRegistry

__all__ = [
    # Enums
    "TaskStatus",
    "TaskType",
    # Data Classes
    "StackTask", 
    "ActionStep",
    "ActionPlan",
    "TaskResult",
    "RunContext",
    # Interfaces
    "ITaskPlanner",
    "IPrerequisiteResolver",
    "ITaskExecutor",
    "ITaskDecomposer",
    "ITaskRunner",
    # Implementations
    "StackPlanner",
    "StackOverflowError",
    "PrerequisiteResolver",
    "LLMTaskPlanner",
    "TaskExecutor",
    "LLMTaskDecomposer",
    # Runners
    "GatherRunner",
    "LinearPlanRunner",
    "RunnerRegistry",
]
