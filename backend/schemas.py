from typing import Annotated, Any, Dict, List, Literal, Optional, TypedDict, Union
import operator

from pydantic import BaseModel, Field


# ===== LLM 输出结构 =====
IntentType = Literal["chat", "task"]
ActionType = Literal["mine", "move_to", "pick_up", "craft", "interact", "unknown"]


class RouterOutput(BaseModel):
    """第一层（思考层）路由输出。"""

    intent: IntentType = Field(description="意图分类结果")
    action: ActionType = Field(description="提取出的核心动作")
    target: str = Field(description="动作目标")
    reply_text: Optional[str] = Field(default=None, description="可选的快速回复文本")


class TaskRouterOutput(BaseModel):
    """离线 task-only 路由输出（兼容旧测试）。"""

    action: Literal["mine"] = Field(description="核心动作")
    target: Literal["coal_ore"] = Field(description="动作目标")


class PlannerOutput(BaseModel):
    """第一层（思考层）任务规划输出。"""

    tasks: List[Dict[str, Any]] = Field(default_factory=list, description="拆解后的任务序列")


class MaidState(TypedDict):
    """第二层（编排层）状态定义。"""

    user_input: str
    intent: Optional[IntentType]
    route: Optional[Union[RouterOutput, TaskRouterOutput]]
    plan: Optional[PlannerOutput]
    current_task: Optional[Dict[str, Any]]
    env_snapshot: Optional[Dict[str, Any]]
    execution_result: Optional[Dict[str, Any]]
    fail_count: int
    error_msg: Optional[str]

    # LangGraph reducer: 增量更新队列时自动拼接
    task_queue: Annotated[List[Dict[str, Any]], operator.add]
