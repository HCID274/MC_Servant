from typing import Annotated, Any, Dict, List, Literal, Optional, TypedDict, Union
import operator

from pydantic import BaseModel, Field, model_validator


# ===== LLM 输出结构 =====
IntentType = Literal["chat", "task"]
ActionType = str


# ===== 语义目标定义 =====
TargetVocabulary = Literal[
    "master_front",   # 主人正前方
    "master_side",    # 主人身旁
    "master_eyes",    # 主人的眼睛（用于看向主人）
    "self_feet"       # 自己的脚下
]

# 任务动作空间
TaskActionType = Literal[                                                                                                                                              
    "mine",                                                                                                                                                            
    "pick_up",                                                                                                                                                         
    "craft",                                                                                                                                                           
    "place",                                                                                                                                                           
    "move_to",                                                                                                                                                         
    "speak",                                                                                                                                                           
]   

class TaskStep(BaseModel):
    """任务原子步：定义一个具体的物理动作及其目标参数。"""
    action: TaskActionType = Field(
        description="执行的动作类型，必须是预设的合法动作之一"
    )
    target: str = Field(
        description="动作的目标。比如方块ID(oak_log)、物品ID(wooden_pickaxe)、相对位置(master_front)、或者说话的台词"
    )

class TaskPlannerOutput(BaseModel):
    """任务规划结果：承载了经过大脑拆解后的步骤序列，以及人性化的执行开场白。"""
    opening_reply_text: Optional[str] = Field(
        default=None,
        description="任务规划完成后立刻对玩家播报的开场白，用于掩盖首次计算延迟"
    )
    plan: List[TaskStep] = Field(
        default_factory=list,
        description="经过逻辑拆解后的原子任务序列"
    )

class ChatStep(BaseModel):
    """
    语义化的动作步骤。
    大模型只需输出“去主人前面”，无需关心坐标。
    """
    action: Literal["move_to", "look_at", "animate", "speak"]
    target: Union[TargetVocabulary, str]  # 如果是 speak，target 就是台词


class RouterOutput(BaseModel):
    """
    大脑的第一反应（意图识别结果）。
    它决定了女仆是该陪主人聊天（chat），还是该挽起袖子去干活（task）。
    """

    intent: IntentType = Field(description="意图分类结果")
    action: ActionType = Field(description="提取出的核心动作")
    target: str = Field(description="动作目标")
    required_knowledge: List[str] = Field(
        default_factory=list,
        description="后续任务规划需要加载的知识库主题列表；chat 必须为空列表",
    )
    reply_text: Optional[str] = Field(default=None, description="可选的快速回复文本")

    @model_validator(mode="after")
    def normalize_required_knowledge(self) -> "RouterOutput":
        # 统一做去空、去重、小写标准化，避免后续路径拼接出现脏 topic。
        normalized: List[str] = []
        seen = set()
        for raw in self.required_knowledge:
            topic = str(raw).strip().lower()
            if not topic or topic == "none" or topic in seen:
                continue
            seen.add(topic)
            normalized.append(topic)
        if self.intent == "chat":
            self.required_knowledge = []
        else:
            self.required_knowledge = normalized
        return self


class TaskRouterOutput(BaseModel):
    """
    （测试专用）简易的任务识别结果。
    主要用于在没有完整 LLM 接入时的离线功能测试。
    """

    action: Literal["mine"] = Field(description="核心动作")
    target: Literal["coal_ore"] = Field(description="动作目标")
    required_knowledge: List[str] = Field(default_factory=list, description="兼容字段")


class MaidState(TypedDict):
    """
    女仆的“记忆与实时状态”。
    这是整个大脑工作流的共享数据中心，记录了主人说了什么、大脑思考到了哪一步、任务队列排到了哪里，以及执行结果如何。
    """

    user_input: str
    intent: Optional[IntentType]
    route: Optional[Union[RouterOutput, TaskRouterOutput]]
    plan: Optional[TaskPlannerOutput]
    opening_reply_text: Optional[str]
    planned_tasks: Optional[List[Dict[str, Any]]]
    active_knowledge: Optional[str]
    current_task: Optional[Dict[str, Any]]
    env_snapshot: Optional[Dict[str, Any]]
    trace_ctx: Optional[Dict[str, str]]
    execution_result: Optional[Dict[str, Any]]
    failure_reason: Optional[str]
    fail_count: int
    error_msg: Optional[str]

    # LangGraph reducer: 增量更新队列时自动拼接
    task_queue: Annotated[List[Dict[str, Any]], operator.add]
