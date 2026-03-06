from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from bot.mineflayer_adapter import BotManager
from execution.task_queue import TaskQueueManager
from tracing.repository import TraceRepository


@dataclass
class AppRuntime:
    """运行时容器：集中管理系统共享的 Bot 实例、任务队列及决策流状态。"""

    bot_username: str
    bot_manager: Optional[BotManager] = None
    workflow_app: Optional[Any] = None
    checkpointer: Optional[Any] = None
    checkpointer_cm: Optional[Any] = None
    trace_repo: Optional[TraceRepository] = None
    task_queue_manager: Optional[TaskQueueManager] = None
    bot_owners: Dict[str, Dict[str, str]] = field(default_factory=dict)
    online_players: Dict[str, Dict[str, str]] = field(default_factory=dict)
