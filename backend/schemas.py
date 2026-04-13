from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

from pydantic import BaseModel, Field, model_validator


# ===== 意图与动作空间定义 =====
IntentType = Literal["chat", "task"]
ActionType = str

TargetVocabulary = Literal[
    "master_front",   # 主人正前方
    "master_side",    # 主人身旁
    "master_eyes",    # 主人的眼睛（用于看向主人）
    "self_feet"       # 自己的脚下
]

TaskActionType = Literal[                                                                                                                                              
    "mine",                                                                                                                                                            
    "pick_up",                                                                                                                                                         
    "craft",                                                                                                                                                           
    "drop",
    "place",                                                                                                                                                           
    "move_to",                                                                                                                                                         
    "speak",                                                                                                                                                           
]   


class RoutedIntent(BaseModel):
    """主意图：承载 Router 抽取出的当前唯一主意图及其明确 Goal。"""

    type: IntentType = Field(description="子意图类型，只能是 chat 或 task")
    priority: int = Field(description="执行顺序优先级，数字越小越优先", ge=1)
    goal: str = Field(description="当前主意图的明确目标；task 输出执行目标，chat 输出回应主题")

    @model_validator(mode="after")
    def normalize_fields(self) -> "RoutedIntent":
        self.goal = str(self.goal or "").strip()
        if not self.goal:
            raise ValueError("goal 不能为空")
        return self

class TaskStep(BaseModel):
    """任务原子步：定义一个具体的物理动作及其目标参数。"""
    action: TaskActionType = Field(
        description="执行的动作类型，必须是预设的合法动作之一"
    )
    target: str = Field(
        description="动作的目标参数（如方块ID、物品名或坐标标识）"
    )
    count: Optional[int] = Field(
        default=None,
        ge=1,
        description="可选数量参数；mine/craft/drop 在需要精确数量时必须显式填写",
    )
    reason: str = Field(
        description="执行该步骤的直接原因，必须说明此刻为什么要做这一步"
    )

    @model_validator(mode="after")
    def normalize_fields(self) -> "TaskStep":
        self.target = str(self.target or "").strip()
        self.reason = str(self.reason or "").strip()
        if not self.target:
            raise ValueError("target 不能为空")
        if not self.reason:
            raise ValueError("reason 不能为空")
        if self.count is not None and int(self.count) < 1:
            raise ValueError("count 必须大于等于 1")
        return self

class TaskPlannerOutput(BaseModel):
    """任务规划负载：承载经过大脑拆解后的步骤序列与人性化开场白。"""
    opening_reply_text: Optional[str] = Field(
        default=None,
        description="规划完成后立刻播报的回复，用于掩盖后续执行延迟"
    )
    plan: List[TaskStep] = Field(
        default_factory=list,
        description="经过逻辑拆解后的原子任务序列；每一步都必须包含 action、target、reason，且 speak 为合法动作"
    )


class StepSummaryAgentOutput(BaseModel):
    """步骤摘要负载：将物理执行结果压缩为可供检索的索引摘要。"""
    summary_text: str = Field(
        description="对单步执行结果的一句话压缩摘要，用于长时记忆检索"
    )


class ChatStep(BaseModel):
    """交互原子步：定义对主人的社交反馈及空间交互动作。"""
    action: Literal["move_to", "look_at", "animate", "speak"]
    target: Union[TargetVocabulary, str]

    @model_validator(mode="after")
    def normalize_fields(self) -> "ChatStep":
        self.target = str(self.target or "").strip()
        if not self.target:
            raise ValueError("target 不能为空")
        return self


class ChatPlannerOutput(BaseModel):
    """对话规划负载：承载基于环境快照的最终回复与轻互动动作序列。"""

    reply_text: str = Field(description="对主人的最终回复文本，必须带喵")
    plan: List[ChatStep] = Field(
        default_factory=list,
        description="可选的轻互动动作序列，只允许 speak/move_to/look_at/animate",
    )

    @model_validator(mode="after")
    def normalize_fields(self) -> "ChatPlannerOutput":
        self.reply_text = str(self.reply_text or "").strip()
        if not self.reply_text:
            raise ValueError("reply_text 不能为空")
        return self


class RouterOutput(BaseModel):
    """意图路由负载：承载当前阶段唯一主意图及即时回复文本。"""

    intents: List[RoutedIntent] = Field(
        default_factory=list,
        description="为兼容现有结构保留数组，但当前阶段只允许 1 个主意图",
    )
    reply_text: Optional[str] = Field(default=None, description="可选的即时回复文本")

    @model_validator(mode="after")
    def normalize_intents(self) -> "RouterOutput":
        """结果收口：去重、排序，并只保留当前最高优先级主意图。"""
        ordered: List[RoutedIntent] = []
        seen = set()
        sorted_intents = sorted(
            list(self.intents or []),
            key=lambda item: (int(item.priority), 0 if item.type == "task" else 1, item.goal),
        )
        for item in sorted_intents:
            key = (item.type, item.goal)
            if key in seen:
                continue
            seen.add(key)
            ordered.append(item)
        primary = ordered[0] if ordered else RoutedIntent(type="chat", priority=1, goal="回应主人当前对话")
        primary.priority = 1
        self.intents = [primary]
        return self

    @property
    def primary_intent(self) -> IntentType:
        return self.intents[0].type if self.intents else "chat"

    @property
    def primary_goal(self) -> str:
        return self.intents[0].goal if self.intents else "回应主人当前对话"

    def first_task_intent(self) -> Optional[RoutedIntent]:
        for intent in self.intents:
            if intent.type == "task":
                return intent
        return None


class PositionSnapshot(TypedDict, total=False):
    """三维坐标快照：统一 bot/player/目标点位的坐标结构。"""

    x: float
    y: float
    z: float


class NearbyBlockSnapshot(TypedDict, total=False):
    """附近方块摘要：统一 Planner/Bark/Summary 看到的环境物体结构。"""

    name: str
    count: int
    cluster_count: int


class EnvSnapshot(TypedDict, total=False):
    """标准环境快照：全链路唯一允许传递的游戏世界状态对象。"""

    bot_name: str
    master_name: str
    bot_pos: PositionSnapshot
    player_pos: PositionSnapshot
    inventory: Dict[str, int]
    nearby_blocks: List[NearbyBlockSnapshot]
    nearby_crafting_table: Optional[bool]
    equipped: Optional[str]
    health: Optional[float]
    food: Optional[int]


class ToolContext(TypedDict, total=False):
    """结构化查询上下文：由工具层汇总的确定性任务事实。"""

    user_input: str
    route: Dict[str, Any]
    resolution: Dict[str, Any]
    environment_hints: Dict[str, Any]
    lookups: Dict[str, Any]


class MaidState(TypedDict):
    """全局状态机上下文：承载指令全生命周期中的所有思考快照与环境变量。"""

    user_input: str
    intent: Optional[IntentType]
    route: Optional[RouterOutput]
    plan: Optional[TaskPlannerOutput]
    opening_reply_text: Optional[str]
    planned_tasks: Optional[List[Dict[str, Any]]]
    chat_reply_text: Optional[str]
    chat_plan: Optional[List[Dict[str, Any]]]
    tool_context: Optional[ToolContext]
    current_task: Optional[Dict[str, Any]]
    env_snapshot: Optional[EnvSnapshot]
    trace_ctx: Optional[Dict[str, str]]
    execution_result: Optional[Dict[str, Any]]
    failure_reason: Optional[str]
    compressed_history: Optional[List[Dict[str, Any]]]
    fail_count: int
    error_msg: Optional[str]

    # LangGraph 状态收口：task_queue 在单次运行或重规划时必须整体覆盖，不能把旧计划叠加回来。
    task_queue: List[Dict[str, Any]]
