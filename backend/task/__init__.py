# Task Module
# 任务系统 - 栈式任务规划与执行

from .interfaces import (
    TaskStatus,
    StackTask,
    ActionStep,
    ActionPlan,
    TaskResult,
    ITaskPlanner,
    IPrerequisiteResolver,
    ITaskExecutor,
)
from .stack_planner import StackPlanner, StackOverflowError
from .prerequisite_resolver import PrerequisiteResolver
from .llm_planner import LLMTaskPlanner
from .executor import TaskExecutor

__all__ = [
    # Interfaces
    "TaskStatus",
    "StackTask", 
    "ActionStep",
    "ActionPlan",
    "TaskResult",
    "ITaskPlanner",
    "IPrerequisiteResolver",
    "ITaskExecutor",
    # Implementations
    "StackPlanner",
    "StackOverflowError",
    "PrerequisiteResolver",
    "LLMTaskPlanner",
    "TaskExecutor",
]

