# Bot Controller Interfaces

from abc import ABC, abstractmethod
from typing import Tuple, Optional


class IBotController(ABC):
    """
    Bot 控制器抽象接口
    
    简单接口：jump, chat, get_position
    深度功能：后续可扩展 move_to, attack, place_block 等
    
    依赖抽象：业务逻辑依赖此接口，不依赖具体实现
    """
    
    @property
    @abstractmethod
    def is_connected(self) -> bool:
        """Bot 是否已连接"""
        pass
    
    @property
    @abstractmethod
    def username(self) -> str:
        """Bot 用户名"""
        pass
    
    @abstractmethod
    async def connect(self) -> bool:
        """连接到 Minecraft 服务器"""
        pass
    
    @abstractmethod
    async def disconnect(self) -> None:
        """断开连接"""
        pass
    
    @abstractmethod
    async def jump(self) -> bool:
        """跳跃"""
        pass
    
    @abstractmethod
    async def chat(self, message: str) -> bool:
        """发送聊天消息"""
        pass
    
    @abstractmethod
    async def get_position(self) -> Optional[Tuple[float, float, float]]:
        """获取当前位置"""
        pass


class IBotManager(ABC):
    """
    Bot 管理器抽象接口
    
    管理多个 Bot 实例
    """
    
    @abstractmethod
    def get_bot(self, name: str) -> Optional[IBotController]:
        """获取指定名称的 Bot"""
        pass
    
    @abstractmethod
    async def spawn_bot(self, name: str) -> IBotController:
        """生成新的 Bot"""
        pass
    
    @abstractmethod
    async def remove_bot(self, name: str) -> bool:
        """移除 Bot"""
        pass
    
    @abstractmethod
    def list_bots(self) -> list[str]:
        """列出所有 Bot 名称"""
        pass
