from typing import Annotated, Any, Dict, List, Literal, Optional, TypedDict, Union
import operator

from pydantic import BaseModel, Field


# ===== LLM 输出结构 =====
IntentType = Literal["chat", "task"]
ActionType = Literal["mine", "move_to", "pick_up", "craft", "interact", "unknown"]


class RouterOutput(BaseModel):
    """
    大脑的第一反应（意图识别结果）。
    它决定了女仆是该陪主人聊天（chat），还是该挽起袖子去干活（task）。
    """

    intent: IntentType = Field(description="意图分类结果")
    action: ActionType = Field(description="提取出的核心动作")
    target: str = Field(description="动作目标")
    reply_text: Optional[str] = Field(default=None, description="可选的快速回复文本")


class TaskRouterOutput(BaseModel):
    """
    （测试专用）简易的任务识别结果。
    主要用于在没有完整 LLM 接入时的离线功能测试。
    """

    action: Literal["mine"] = Field(description="核心动作")
    target: Literal["coal_ore"] = Field(description="动作目标")


class PlannerOutput(BaseModel):
    """
    任务拆解清单。
    当主人下达复杂指令时，大脑会将大任务拆解成一串小任务，存放在这里。
    """

    tasks: List[Dict[str, Any]] = Field(default_factory=list, description="拆解后的任务序列")


class MaidState(TypedDict):
    """
    女仆的“记忆与实时状态”。
    这是整个大脑工作流的共享数据中心，记录了主人说了什么、大脑思考到了哪一步、任务队列排到了哪里，以及执行结果如何。
    """

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
