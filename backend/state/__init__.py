# State Machine Module
# 状态机模块 - 管理 Bot 的行为生命周期

from .interfaces import IState, IStateMachine, IPermissionGate, StateResult
from .events import Event, EventType
from .context import RuntimeContext
from .config import BotConfig
from .permission import PermissionGate, PermissionResult
from .states import UnclaimedState, IdleState, PlanningState, WorkingState
from .machine import StateMachine

__all__ = [
    # Interfaces
    "IState",
    "IStateMachine", 
    "IPermissionGate",
    "StateResult",
    # Events
    "Event",
    "EventType",
    # Data
    "RuntimeContext",
    "BotConfig",
    # Permission
    "PermissionGate",
    "PermissionResult",
    # States
    "UnclaimedState",
    "IdleState",
    "PlanningState",
    "WorkingState",
    # Machine
    "StateMachine",
]
