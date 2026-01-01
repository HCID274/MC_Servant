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
