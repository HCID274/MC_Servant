# Runtime Context
# 运行时上下文 - 内存数据，进程重启后丢失

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Task:
    """
    任务数据结构
    
    存储当前正在执行的任务信息
    """
    task_type: str                  # 任务类型 (build, mine, farm, guard)
    description: str                # 任务描述
    params: Dict[str, Any] = field(default_factory=dict)  # 任务参数
    progress: float = 0.0           # 进度 (0.0 - 1.0)
    started_at: float = field(default_factory=time.time)
    
    def __repr__(self) -> str:
        return f"Task({self.task_type}, progress={self.progress:.1%})"


@dataclass
class ConversationMessage:
    """对话消息"""
    role: str       # "user" | "assistant" | "system"
    content: str
    timestamp: float = field(default_factory=time.time)
    player_name: Optional[str] = None  # 如果是用户消息，记录玩家名


@dataclass
class RuntimeContext:
    """
    运行时上下文
    
    存储 Bot 的"工作台"和"短期记忆"
    生命周期：Python 进程启动 → 关闭，重启后丢失
    """
    # 当前任务
    current_task: Optional[Task] = None
    
    # 对话历史 (滚动窗口，默认保留最近 20 条)
    conversation_history: List[ConversationMessage] = field(default_factory=list)
    max_history_length: int = 20
    
    # 状态时间戳
    last_activity: float = field(default_factory=time.time)
    state_entered_at: float = field(default_factory=time.time)
    
    def add_message(self, role: str, content: str, player_name: Optional[str] = None) -> None:
        """
        添加对话消息到历史
        
        自动维护滚动窗口
        """
        msg = ConversationMessage(
            role=role,
            content=content,
            player_name=player_name,
        )
        self.conversation_history.append(msg)
        
        # 滚动窗口
        if len(self.conversation_history) > self.max_history_length:
            self.conversation_history = self.conversation_history[-self.max_history_length:]
        
        self.last_activity = time.time()
    
    def get_conversation_for_llm(self) -> List[Dict[str, str]]:
        """
        获取适合传给 LLM 的对话历史格式
        
        Returns:
            [{"role": "user", "content": "..."}, ...]
        """
        return [
            {"role": msg.role, "content": msg.content}
            for msg in self.conversation_history
        ]
    
    def start_task(self, task_type: str, description: str, params: Optional[Dict] = None) -> Task:
        """
        开始新任务
        
        Args:
            task_type: 任务类型
            description: 任务描述
            params: 任务参数
            
        Returns:
            创建的 Task 对象
        """
        self.current_task = Task(
            task_type=task_type,
            description=description,
            params=params or {},
        )
        self.last_activity = time.time()
        return self.current_task
    
    def update_task_progress(self, progress: float) -> None:
        """更新任务进度"""
        if self.current_task:
            self.current_task.progress = min(1.0, max(0.0, progress))
            self.last_activity = time.time()
    
    def clear_task(self) -> None:
        """清除当前任务"""
        self.current_task = None
        self.last_activity = time.time()
    
    def reset_state_timer(self) -> None:
        """重置状态进入时间（状态转换时调用）"""
        self.state_entered_at = time.time()
    
    def get_state_duration(self) -> float:
        """获取当前状态持续时间（秒）"""
        return time.time() - self.state_entered_at


@dataclass
class BotContext:
    """
    Bot 上下文 - 依赖注入容器
    
    持有所有可注入的服务，供 State 使用。
    设计原则: 依赖抽象，而非具体
    
    Attributes:
        runtime: 运行时上下文 (任务/对话历史)
        executor: 任务执行服务 (Optional)
        actions: Bot 动作接口 (Optional)
        resolver: 实体解析器 (Optional)
        llm: LLM 客户端 (Optional)
        bot: Bot 控制器 (Optional) - 表演动作
    """
    runtime: RuntimeContext = field(default_factory=RuntimeContext)
    
    # 可注入的服务 (延迟注入，避免循环依赖)
    executor: Optional[Any] = None  # ITaskExecutionService
    actions: Optional[Any] = None   # IBotActions
    resolver: Optional[Any] = None  # IEntityResolver
    llm: Optional[Any] = None       # ILLMClient
    bot: Optional[Any] = None       # IBotController (表演动作：spin, look_at, jump)
    
    # 统一记忆服务 (Phase 5: Unified Memory System)
    memory: Optional[Any] = None    # IMemoryService (MemoryFacade)
    
    # 全息显示节流器
    _last_hologram_update: float = field(default=0.0)
    _hologram_throttle_ms: int = field(default=500)  # 最小更新间隔
    
    # 进度回调 (由 State 设置，由 Executor 调用)
    on_hologram_update: Optional[Any] = None  # Callable[[str], Awaitable[None]]
    on_chat_message: Optional[Any] = None     # Callable[[str], Awaitable[None]]
    on_npc_response: Optional[Any] = None     # Callable[[dict], Awaitable[None]]
    
    # 事件通知回调 (当后台任务产生事件时调用，用于触发状态机处理)
    on_event_queued: Optional[Any] = None  # Callable[[EventType, dict], Awaitable[None]]
    
    # 内部事件队列 (用于后台任务发送事件给状态机)
    _pending_events: List[Any] = field(default_factory=list)
    
    async def update_hologram_throttled(self, text: str) -> None:
        """
        节流的全息更新
        
        防止高频回调导致刷屏，最小间隔 500ms
        """
        now = time.time() * 1000
        if now - self._last_hologram_update < self._hologram_throttle_ms:
            return  # 跳过本次更新
        
        self._last_hologram_update = now
        if self.on_hologram_update:
            await self.on_hologram_update(text)
    
    async def queue_event_async(self, event_type: Any, payload: Dict[str, Any] = None) -> None:
        """
        将事件加入待处理队列并立即通知 (异步版本，推荐使用)
        
        Args:
            event_type: EventType 枚举值
            payload: 事件数据
        """
        self._pending_events.append((event_type, payload or {}))
        
        # 立即触发回调通知状态机处理
        if self.on_event_queued:
            try:
                await self.on_event_queued(event_type, payload or {})
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f"Event callback error: {e}")
    
    def queue_event(self, event_type: Any, payload: Dict[str, Any] = None) -> None:
        """
        将事件加入待处理队列 (同步版本，兼容旧代码)
        
        注意：此方法不会触发回调，需要外部轮询 process_pending_events
        新代码应使用 queue_event_async
        
        Args:
            event_type: EventType 枚举值
            payload: 事件数据
        """
        self._pending_events.append((event_type, payload or {}))
    
    def pop_pending_event(self) -> Optional[tuple]:
        """弹出一个待处理事件"""
        if self._pending_events:
            return self._pending_events.pop(0)
        return None
    
    def has_pending_events(self) -> bool:
        """是否有待处理事件"""
        return len(self._pending_events) > 0
