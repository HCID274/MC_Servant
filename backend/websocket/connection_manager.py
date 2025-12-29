# WebSocket Connection Manager

from abc import ABC, abstractmethod
from typing import Dict, Set
from fastapi import WebSocket
import logging


logger = logging.getLogger(__name__)


class IConnectionManager(ABC):
    """
    连接管理器抽象接口
    
    简单接口：connect, disconnect, broadcast
    深度功能：支持多客户端、分组广播等扩展
    """
    
    @abstractmethod
    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        """接受新连接"""
        pass
    
    @abstractmethod
    async def disconnect(self, client_id: str) -> None:
        """断开连接"""
        pass
    
    @abstractmethod
    async def send_personal(self, message: str, client_id: str) -> None:
        """发送消息到指定客户端"""
        pass
    
    @abstractmethod
    async def broadcast(self, message: str) -> None:
        """广播消息到所有客户端"""
        pass


class ConnectionManager(IConnectionManager):
    """
    WebSocket 连接管理器实现
    
    管理 Java 插件的 WebSocket 连接
    """
    
    def __init__(self):
        # client_id -> WebSocket
        self._connections: Dict[str, WebSocket] = {}
    
    @property
    def active_connections(self) -> Set[str]:
        """获取活跃连接的客户端 ID"""
        return set(self._connections.keys())
    
    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        """接受新连接"""
        await websocket.accept()
        self._connections[client_id] = websocket
        logger.info(f"Client connected: {client_id}")
    
    async def disconnect(self, client_id: str) -> None:
        """断开连接"""
        if client_id in self._connections:
            del self._connections[client_id]
            logger.info(f"Client disconnected: {client_id}")
    
    async def send_personal(self, message: str, client_id: str) -> None:
        """发送消息到指定客户端"""
        websocket = self._connections.get(client_id)
        if websocket:
            await websocket.send_text(message)
        else:
            logger.warning(f"Client not found: {client_id}")
    
    async def broadcast(self, message: str) -> None:
        """广播消息到所有客户端"""
        for client_id, websocket in self._connections.items():
            try:
                await websocket.send_text(message)
            except Exception as e:
                logger.error(f"Failed to send to {client_id}: {e}")


# 全局连接管理器实例
manager = ConnectionManager()
