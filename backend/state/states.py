# State Implementations
# 具体状态实现

import logging
from typing import Optional, TYPE_CHECKING

from .interfaces import IState, StateResult
from .events import Event, EventType
from .context import RuntimeContext

if TYPE_CHECKING:
    from ..llm.interfaces import ILLMClient

logger = logging.getLogger(__name__)


class UnclaimedState(IState):
    """
    无主状态 - 等待认领
    
    行为：
    - 接受 CLAIM 事件 → 转换到 IdleState
    - 接受 CHAT 事件 → 回复引导认领
    - 拒绝其他任务指令
    """
    
    @property
    def name(self) -> str:
        return "unclaimed"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        return "[无主] 右键认领"
    
    async def on_exit(self, context: RuntimeContext) -> None:
        pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.CLAIM:
            # 认领成功，转换到 IdleState
            # 注意：实际的 owner 信息由 StateMachine 在 BotConfig 中设置
            return StateResult(
                next_state=IdleState(self._llm) if hasattr(self, '_llm') else IdleState(),
                response=f"认领成功！你好主人，我是你的女仆，请多多关照喵~",
                action={"type": "jump"},  # 开心地跳一下
            )
        
        elif event.type == EventType.CHAT:
            return StateResult(
                response="你好呀~ 我现在还没有主人，你可以输入「认领」把我带回家哦~",
                hologram_text="👋",
            )
        
        elif event.type == EventType.QUERY:
            return StateResult(
                response="我是一只无主的女仆，正在等待有缘人认领我~",
            )
        
        # 其他事件（理论上被 PermissionGate 拦截了）
        return StateResult(
            response="请先认领我哦~",
        )
    
    def __init__(self, llm_client: Optional["ILLMClient"] = None):
        self._llm = llm_client


class IdleState(IState):
    """
    待命状态 - 等待主人指令
    
    行为：
    - 接受 TASK_REQUEST → 转换到 PlanningState
    - 接受 RELEASE → 转换到 UnclaimedState
    - 接受 CHAT → 调用 LLM 闲聊
    - 接受 QUERY → 报告状态
    """
    
    def __init__(self, llm_client: Optional["ILLMClient"] = None):
        self._llm = llm_client
    
    @property
    def name(self) -> str:
        return "idle"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        context.clear_task()
        return "💤 待命中"
    
    async def on_exit(self, context: RuntimeContext) -> None:
        pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.RELEASE:
            return StateResult(
                next_state=UnclaimedState(self._llm),
                response="好的，我自由了...再见，曾经的主人...",
                action={"type": "wave"},
            )
        
        elif event.type == EventType.TASK_REQUEST:
            # 提取任务信息
            task_type = event.payload.get("intent", "unknown")
            description = event.payload.get("description", event.payload.get("raw_input", ""))
            
            # 开始任务，转换到规划状态
            context.start_task(task_type, description, event.payload)
            
            return StateResult(
                next_state=PlanningState(self._llm),
                response="好的主人，让我想想怎么做...",
                hologram_text="💭 思考中...",
            )
        
        elif event.type == EventType.CHAT:
            # 闲聊
            response = await self._generate_chat_response(event, context)
            # 截取前60个字符显示在全息上
            short_msg = response[:60] + "..." if len(response) > 60 else response
            return StateResult(response=response, hologram_text=f"💬 {short_msg}")
        
        elif event.type == EventType.QUERY:
            duration = context.get_state_duration()
            return StateResult(
                response=f"我正在待命中，已经等了 {int(duration)} 秒啦，随时准备接受主人的指令喵~",
            )
        
        return StateResult(response="喵？")
    
    async def _generate_chat_response(self, event: Event, context: RuntimeContext) -> str:
        """使用 LLM 生成闲聊回复"""
        if not self._llm:
            return "主人好~ (LLM 未配置，无法进行深度对话)"
        
        try:
            # 添加用户消息到历史
            user_input = event.payload.get("raw_input", "")
            context.add_message("user", user_input, event.source_player)
            
            # 构建消息
            messages = [
                {
                    "role": "system",
                    "content": (
                        "你是一个可爱的 Minecraft 女仆助手，说话要可爱俏皮，"
                        "每句话结尾可以加上「喵~」。你很乐意帮助主人完成各种任务。"
                        f"你的主人是 {event.source_player}。"
                    ),
                },
                *context.get_conversation_for_llm()
            ]
            
            response = await self._llm.chat(messages, max_tokens=256, temperature=0.8)
            context.add_message("assistant", response)
            return response
            
        except Exception as e:
            logger.error(f"Chat generation failed: {e}")
            return "啊...我脑子有点转不过来了，再说一遍好吗喵~"


class PlanningState(IState):
    """
    规划状态 - LLM 生成计划
    
    行为：
    - 进入时触发 LLM 规划
    - 接受 TASK_CONFIRM → 转换到 WorkingState
    - 接受 TASK_CANCEL → 返回 IdleState
    - 接受 CHAT → 简短回复
    """
    
    def __init__(self, llm_client: Optional["ILLMClient"] = None):
        self._llm = llm_client
    
    @property
    def name(self) -> str:
        return "planning"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        return "💭 思考中..."
    
    async def on_exit(self, context: RuntimeContext) -> None:
        pass
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.TASK_CONFIRM:
            return StateResult(
                next_state=WorkingState(self._llm),
                response="好的，开始干活啦！",
                hologram_text="🔨 工作中",
                action={"type": "start_task"},
            )
        
        elif event.type == EventType.TASK_CANCEL:
            return StateResult(
                next_state=IdleState(self._llm),
                response="好的，取消了喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type == EventType.CHAT:
            # 规划中，简短回复
            return StateResult(
                response="等一下喵，我正在想方案呢...",
                hologram_text="💭 思考中...",
            )
        
        elif event.type == EventType.QUERY:
            task = context.current_task
            if task:
                return StateResult(
                    response=f"我正在规划「{task.description}」任务，请稍等喵~",
                )
            return StateResult(response="我正在思考中喵~")
        
        return StateResult()


class WorkingState(IState):
    """
    工作状态 - 执行任务
    
    行为：
    - 接受 TASK_COMPLETE → 返回 IdleState
    - 接受 TASK_FAILED → 返回 IdleState (附带失败信息)
    - 接受 TASK_CANCEL → 返回 IdleState
    - 接受 CHAT → 简短回复，不中断工作
    """
    
    def __init__(self, llm_client: Optional["ILLMClient"] = None):
        self._llm = llm_client
    
    @property
    def name(self) -> str:
        return "working"
    
    async def on_enter(self, context: RuntimeContext) -> Optional[str]:
        context.reset_state_timer()
        task = context.current_task
        task_name = task.task_type if task else "任务"
        return f"🔨 {task_name}中"
    
    async def on_exit(self, context: RuntimeContext) -> None:
        # 清理任务（无论成功还是失败）
        context.clear_task()
    
    async def handle_event(self, event: Event, context: RuntimeContext) -> StateResult:
        if event.type == EventType.TASK_COMPLETE:
            return StateResult(
                next_state=IdleState(self._llm),
                response="任务完成啦！主人看看满意吗喵~",
                hologram_text="💤 待命中",
                action={"type": "celebrate"},
            )
        
        elif event.type == EventType.TASK_FAILED:
            error = event.payload.get("error", "未知错误")
            return StateResult(
                next_state=IdleState(self._llm),
                response=f"呜呜，任务失败了...原因：{error}，对不起主人喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type == EventType.TASK_CANCEL:
            return StateResult(
                next_state=IdleState(self._llm),
                response="好的，停下来了喵~",
                hologram_text="💤 待命中",
            )
        
        elif event.type == EventType.CHAT:
            # 工作中，简短回复（不中断工作）
            task = context.current_task
            if task:
                progress = task.progress * 100
                return StateResult(
                    response=f"忙着呢~ 进度 {progress:.0f}%，等会儿再聊喵~",
                    hologram_text="🔨 工作中",
                )
            return StateResult(response="忙着呢喵~", hologram_text="🔨 工作中")
        
        elif event.type == EventType.QUERY:
            task = context.current_task
            if task:
                progress = task.progress * 100
                duration = context.get_state_duration()
                return StateResult(
                    response=(
                        f"正在执行「{task.description}」\n"
                        f"进度: {progress:.0f}% | 已用时: {int(duration)}秒"
                    ),
                )
            return StateResult(response="正在工作中喵~")
        
        return StateResult()
