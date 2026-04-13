from dataclasses import dataclass, field
from typing import Any, Optional

from schemas import EnvSnapshot, MaidState, RouterOutput


@dataclass
class GraphRunContext:
    """Graph 入口上下文，统一收口 application -> graph 的跨层输入。"""

    user_input: str
    env_snapshot: EnvSnapshot
    trace_ctx: dict[str, str]
    route: Optional[RouterOutput] = None
    intent: Optional[str] = None
    execution_result: Optional[dict[str, Any]] = None
    failure_reason: Optional[str] = None
    compressed_history: list[dict[str, Any]] = field(default_factory=list)
    fail_count: int = 0
    planned_tasks: list[dict[str, Any]] = field(default_factory=list)
    opening_reply_text: Optional[str] = None

    def to_state(self) -> MaidState:
        return {
            "user_input": self.user_input,
            "intent": self.intent,
            "route": self.route,
            "plan": None,
            "opening_reply_text": self.opening_reply_text,
            "planned_tasks": list(self.planned_tasks),
            "chat_reply_text": None,
            "chat_plan": [],
            "tool_context": None,
            "current_task": None,
            "env_snapshot": self.env_snapshot,
            "trace_ctx": self.trace_ctx,
            "execution_result": self.execution_result,
            "failure_reason": self.failure_reason,
            "compressed_history": list(self.compressed_history),
            "fail_count": self.fail_count,
            "error_msg": None,
            "task_queue": [],
        }
