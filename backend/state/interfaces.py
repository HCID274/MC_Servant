# State Machine Interfaces
# 状态机抽象接口定义
# 
# 设计原则：简单接口，深度功能；依赖抽象，不依赖具体

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .context import RuntimeContext
    from .events import Event
    from .config import BotConfig


@dataclass
class StateResult:
    """
    状态处理结果
    
    承载状态流转的关键信息，由 IState.handle_event 返回
    """
    next_state: Optional["IState"] = None  # None 表示不切换状态（自转换）
    response: Optional[str] = None         # 回复给玩家的文本
    action: Optional[dict] = None          # 需要触发的副作用 (如: Bot 跳跃, 播放声音)
    hologram_text: Optional[str] = None    # 头顶全息显示文本


class IState(ABC):
    """
    状态抽象接口
    
    每个状态封装：
    - 进入/退出时的行为 (on_enter/on_exit)
    - 对事件的响应逻辑 (handle_event)
    """
    
    @property
    @abstractmethod
    def name(self) -> str:
        """状态名称，用于日志和调试"""
        pass
    
    async def on_enter(self, context: "RuntimeContext") -> Optional[str]:
        """
        进入状态时的钩子
        
        Args:
            context: 运行时上下文
            
        Returns:
            头顶全息显示文本（如果需要更新）
        """
        pass
    
    async def on_exit(self, context: "RuntimeContext") -> None:
        """
        退出状态时的钩子
        
        用于清理临时数据、取消定时器等
        
        Args:
            context: 运行时上下文
        """
        pass
    
    @abstractmethod
    async def handle_event(
        self, 
        event: "Event", 
        context: "RuntimeContext"
    ) -> StateResult:
        """
        处理事件
        
        这是状态的核心方法，决定：
        - 是否切换到新状态
        - 返回什么响应
        - 触发什么动作
        
        Args:
            event: 输入事件
            context: 运行时上下文
            
        Returns:
            StateResult 包含状态流转决策
        """
        pass


class IStateMachine(ABC):
    """
    状态机抽象接口
    
    状态机是 Bot 的"行为总控"，负责：
    - 管理当前状态
    - 处理事件并驱动状态流转
    - 协调权限校验
    """
    
    @property
    @abstractmethod
    def current_state(self) -> IState:
        """当前状态"""
        pass
    
    @abstractmethod
    async def process(self, event: "Event") -> Optional[dict]:
        """
        处理事件
        
        完整的处理流程：
        1. 权限校验
        2. 委托给当前状态处理
        3. 状态转换（如果需要）
        4. 构建响应
        
        Args:
            event: 输入事件
            
        Returns:
            响应消息字典，或 None
        """
        pass


@dataclass
class PermissionResult:
    """权限校验结果"""
    allowed: bool
    reason: str = ""
    rejection_message: Optional[str] = None


class IPermissionGate(ABC):
    """
    权限校验抽象接口
    
    作为管道中的独立拦截器，实现单一职责
    """
    
    @abstractmethod
    def check(
        self, 
        event: "Event", 
        config: "BotConfig",
        current_state: str
    ) -> PermissionResult:
        """
        检查事件是否被允许
        
        Args:
            event: 输入事件
            config: Bot 配置（包含主人信息）
            current_state: 当前状态名称
            
        Returns:
            权限校验结果
        """
        pass
