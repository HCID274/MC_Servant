from typing import Literal, Optional, TypedDict, List, Annotated
import operator
from pydantic import BaseModel, Field

# 真正的动态枚举，而不是写死
IntentType = Literal["chat", "task"]
ActionType = Literal["mine", "move_to", "pick_up", "craft", "interact", "unknown"]

class RouterOutput(BaseModel):
    intent: IntentType = Field(description="意图：纯互动(chat)还是干活(task)")
    action: ActionType = Field(description="提取的核心动作")
    target: str = Field(description="动作的目标名词，没有则为'none'")
    reply_text: str = Field(description="回复主人的话，必须带'喵'")

class MaidState(TypedDict):
    """LangGraph 状态"""
    user_input: str
    intent: Optional[IntentType]
    route: Optional[RouterOutput]
    
    # 【核心修正】：使用 Annotated 和 operator.add，告诉 LangGraph 这个列表是累加的
    task_queue: Annotated[List[dict], operator.add]
    error_msg: Optional[str]