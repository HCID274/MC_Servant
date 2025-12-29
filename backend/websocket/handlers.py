# WebSocket Message Handlers

from abc import ABC, abstractmethod
from typing import Optional, TYPE_CHECKING
import logging

from protocol import (
    MessageType, PlayerMessage, NpcResponse, BotCommand, 
    BotStatus, Heartbeat, parse_message
)

if TYPE_CHECKING:
    from bot.interfaces import IBotController

logger = logging.getLogger(__name__)


class IMessageHandler(ABC):
    """
    消息处理器抽象接口
    
    依赖抽象：处理器不关心 Bot 的具体实现
    """
    
    @abstractmethod
    async def handle(self, data: dict) -> Optional[dict]:
        """
        处理消息，返回响应（如果有）
        
        Args:
            data: 解析后的 JSON 消息
            
        Returns:
            响应消息字典，或 None
        """
        pass


class PlayerMessageHandler(IMessageHandler):
    """
    处理玩家消息
    
    职责：
    - 解析玩家意图
    - 调用 Bot 执行动作
    - 返回 NPC 响应
    """
    
    def __init__(self, bot_controller: "IBotController"):
        self._bot = bot_controller
    
    async def handle(self, data: dict) -> Optional[dict]:
        """处理玩家消息"""
        try:
            msg = PlayerMessage.model_validate(data)
            logger.info(f"Player {msg.player} -> {msg.npc}: {msg.content}")
            
            # 简单的指令处理（后续扩展为 LLM 意图识别）
            if msg.content.lower() == "hello":
                # 执行 Bot 动作
                await self._bot.jump()
                await self._bot.chat("Ciallo~~~~")
                
                # 返回响应
                response = NpcResponse(
                    npc=msg.npc or "Alice",
                    target_player=msg.player,
                    content="Ciallo~~~~",
                    hologram_text="💖",
                    action="greeting"
                )
                return response.model_dump()
            
            # 其他消息暂时返回默认响应
            response = NpcResponse(
                npc=msg.npc or "Alice",
                target_player=msg.player,
                content=f"我收到了: {msg.content}",
                action="echo"
            )
            return response.model_dump()
            
        except Exception as e:
            logger.error(f"Error handling player message: {e}")
            return None


class HeartbeatHandler(IMessageHandler):
    """心跳处理器"""
    
    async def handle(self, data: dict) -> Optional[dict]:
        """回复心跳"""
        import time
        return Heartbeat(timestamp=int(time.time())).model_dump()


class MessageRouter:
    """
    消息路由器
    
    根据消息类型分发到对应处理器
    """
    
    def __init__(self, bot_controller: "IBotController"):
        self._handlers: dict[MessageType, IMessageHandler] = {
            MessageType.PLAYER_MESSAGE: PlayerMessageHandler(bot_controller),
            MessageType.HEARTBEAT: HeartbeatHandler(),
        }
    
    async def route(self, data: dict) -> Optional[dict]:
        """路由消息到对应处理器"""
        try:
            msg_type = MessageType(data.get("type"))
            handler = self._handlers.get(msg_type)
            
            if handler:
                return await handler.handle(data)
            else:
                logger.warning(f"No handler for message type: {msg_type}")
                return None
                
        except Exception as e:
            logger.error(f"Error routing message: {e}")
            return None
