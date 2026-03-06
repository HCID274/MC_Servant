import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict


logger = logging.getLogger(__name__)


MessageHandler = Callable[[dict], Awaitable[None]]


@dataclass
class ClientSession:
    """会话上下文：封装单个客户端的入站消息队列与后台分发任务。"""

    inbound_queue: asyncio.Queue[dict]
    dispatcher_task: asyncio.Task


class SessionRuntime:
    """会话调度器：解耦 WebSocket 收包与业务处理，避免慢消息阻塞接收循环。"""

    def __init__(self, inbound_queue_maxsize: int = 128):
        self._inbound_queue_maxsize = max(1, inbound_queue_maxsize)
        self._sessions: Dict[str, ClientSession] = {}

    async def start_client(self, client_id: str, handler: MessageHandler) -> None:
        """启动客户端分发协程；若已存在旧会话则先替换。"""
        await self.stop_client(client_id)

        inbound_queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=self._inbound_queue_maxsize)
        dispatcher_task = asyncio.create_task(
            self._dispatch_loop(client_id, inbound_queue, handler),
            name=f"ws-dispatcher-{client_id}",
        )
        self._sessions[client_id] = ClientSession(
            inbound_queue=inbound_queue,
            dispatcher_task=dispatcher_task,
        )

    async def stop_client(self, client_id: str) -> None:
        """停止客户端分发协程并清理会话状态。"""
        session = self._sessions.pop(client_id, None)
        if session is None:
            return
        session.dispatcher_task.cancel()
        try:
            await session.dispatcher_task
        except asyncio.CancelledError:
            pass

    async def shutdown(self) -> None:
        """停止全部客户端分发协程。"""
        for client_id in list(self._sessions.keys()):
            await self.stop_client(client_id)

    async def submit_message(self, client_id: str, message: dict) -> bool:
        """提交消息到客户端入站队列；队列满时返回 False。"""
        session = self._sessions.get(client_id)
        if session is None:
            return False
        try:
            session.inbound_queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            return False

    async def _dispatch_loop(
        self,
        client_id: str,
        inbound_queue: asyncio.Queue[dict],
        handler: MessageHandler,
    ) -> None:
        while True:
            try:
                message = await inbound_queue.get()
            except asyncio.CancelledError:
                return

            try:
                await handler(message)
            except Exception as exc:
                logger.exception("Dispatch failed for client %s: %s", client_id, exc)
            finally:
                inbound_queue.task_done()
