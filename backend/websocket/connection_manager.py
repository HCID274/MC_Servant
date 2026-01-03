# WebSocket Connection Manager

from abc import ABC, abstractmethod
from typing import Dict, Set
import time
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
        self._last_seen: Dict[str, float] = {}
    
    @property
    def active_connections(self) -> Set[str]:
        """获取活跃连接的客户端 ID"""
        return set(self._connections.keys())
    
    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        """接受新连接"""
        await websocket.accept()
        if client_id in self._connections:
            logger.warning(f"Client ID already connected, replacing: {client_id}")
            await self._close_connection(client_id, code=1000, reason="Replaced by new connection")
        self._connections[client_id] = websocket
        self._last_seen[client_id] = time.time()
        logger.info(f"Client connected: {client_id}")
    
    async def disconnect(self, client_id: str) -> None:
        """断开连接"""
        if client_id in self._connections:
            await self._close_connection(client_id, code=1000, reason="Disconnected")
            logger.info(f"Client disconnected: {client_id}")
    
    async def send_personal(self, message: str, client_id: str) -> None:
        """发送消息到指定客户端"""
        websocket = self._connections.get(client_id)
        if websocket:
            try:
                await websocket.send_text(message)
                self._last_seen[client_id] = time.time()
            except Exception as e:
                logger.error(f"Failed to send to {client_id}: {e}")
                await self._close_connection(client_id, code=1011, reason="Send failed")
        else:
            logger.warning(f"Client not found: {client_id}")
    
    async def broadcast(self, message: str) -> None:
        """广播消息到所有客户端"""
        for client_id, websocket in list(self._connections.items()):
            try:
                await websocket.send_text(message)
                self._last_seen[client_id] = time.time()
            except Exception as e:
                logger.error(f"Failed to send to {client_id}: {e}")
                await self._close_connection(client_id, code=1011, reason="Broadcast send failed")

    def touch(self, client_id: str) -> None:
        """更新客户端最后活动时间"""
        if client_id in self._connections:
            self._last_seen[client_id] = time.time()

    async def cleanup_stale(self, timeout_seconds: int) -> None:
        """清理超时未活动的连接"""
        now = time.time()
        stale_ids = [
            client_id for client_id, last_seen in self._last_seen.items()
            if (now - last_seen) > timeout_seconds
        ]
        for client_id in stale_ids:
            logger.warning(f"Client heartbeat timeout, closing: {client_id}")
            await self._close_connection(client_id, code=1001, reason="Heartbeat timeout")

    async def _close_connection(self, client_id: str, code: int, reason: str) -> None:
        """内部关闭连接并清理映射"""
        websocket = self._connections.pop(client_id, None)
        self._last_seen.pop(client_id, None)
        if websocket:
            try:
                await websocket.close(code=code, reason=reason)
            except Exception:
                pass


# 全局连接管理器实例
manager = ConnectionManager()
