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
from .behavior_rules import BehaviorRules, BehaviorThresholds
from .recovery_interfaces import (
    RecoveryLevel,
    RecoveryActionType,
    RecoveryDecision,
    FailureContext,
    IRecoveryCoordinator,
    IRecoveryLogger,
)
from .recovery_coordinator import RecoveryCoordinator, create_recovery_coordinator
from .recovery_logger import JsonRecoveryLogger, create_recovery_logger

try:
    from .runners import GatherRunner, LinearPlanRunner, RunnerRegistry
except Exception:
    GatherRunner = None
    LinearPlanRunner = None
    RunnerRegistry = None

__all__ = [
    # Enums
    "TaskStatus",
    "TaskType",
    "RecoveryLevel",
    "RecoveryActionType",
    # Data Classes
    "StackTask", 
    "ActionStep",
    "ActionPlan",
    "TaskResult",
    "RunContext",
    "RecoveryDecision",
    "FailureContext",
    "BehaviorThresholds",
    # Interfaces
    "ITaskPlanner",
    "IPrerequisiteResolver",
    "ITaskExecutor",
    "ITaskDecomposer",
    "ITaskRunner",
    "IRecoveryCoordinator",
    "IRecoveryLogger",
    # Implementations
    "StackPlanner",
    "StackOverflowError",
    "PrerequisiteResolver",
    "LLMTaskPlanner",
    "TaskExecutor",
    "LLMTaskDecomposer",
    "BehaviorRules",
    "RecoveryCoordinator",
    "JsonRecoveryLogger",
    # Factory Functions
    "create_recovery_coordinator",
    "create_recovery_logger",
]

if GatherRunner is not None:
    __all__.extend(
        [
            "GatherRunner",
            "LinearPlanRunner",
            "RunnerRegistry",
        ]
    )
