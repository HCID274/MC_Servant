# Background Task Manager
# 后台任务追踪器 - 确保优雅关闭
#
# 设计原则：
# - 简单接口：fire_and_forget() 一行搞定
# - 深度功能：自动追踪、优雅等待、超时保护
# - 解决痛点：asyncio loop 关闭时不会粗暴取消未完成任务

import asyncio
import logging
from typing import Coroutine, Set, Optional

logger = logging.getLogger(__name__)


class BackgroundTaskManager:
    """
    后台任务管理器
    
    用于追踪 fire-and-forget 式的异步任务，确保在服务关闭时
    能够优雅地等待所有任务完成，而不是被粗暴取消。
    
    使用示例:
        manager = BackgroundTaskManager()
        
        # 发射后台任务
        manager.fire_and_forget(some_async_task())
        
        # 关闭时等待
        await manager.wait_all_pending(timeout=30.0)
    """
    
    def __init__(self):
        self._pending: Set[asyncio.Task] = set()
        self._shutting_down: bool = False
    
    def fire_and_forget(self, coro: Coroutine) -> Optional[asyncio.Task]:
        """
        发射后台任务，自动追踪
        
        Args:
            coro: 要执行的协程
            
        Returns:
            创建的 Task 对象，如果正在关闭则返回 None
        """
        if self._shutting_down:
            logger.warning("TaskManager shutting down, rejecting new task")
            # 必须关闭协程，否则会有警告
            coro.close()
            return None
        
        try:
            task = asyncio.create_task(coro)
        except RuntimeError as e:
            # 没有运行中的事件循环
            logger.warning(f"Cannot create task (no event loop?): {e}")
            coro.close()
            return None
        
        self._pending.add(task)
        task.add_done_callback(self._on_task_done)
        
        logger.debug(f"Fired background task, pending={len(self._pending)}")
        return task
    
    def _on_task_done(self, task: asyncio.Task) -> None:
        """任务完成回调"""
        self._pending.discard(task)
        
        # 检查异常（但不抛出，只记录）
        if not task.cancelled():
            exc = task.exception()
            if exc:
                logger.warning(f"Background task failed: {exc}")
    
    async def wait_all_pending(self, timeout: float = 30.0) -> int:
        """
        等待所有后台任务完成
        
        Args:
            timeout: 最大等待时间（秒）
            
        Returns:
            完成的任务数量
        """
        self._shutting_down = True
        
        if not self._pending:
            logger.info("No pending tasks to wait")
            return 0
        
        pending_count = len(self._pending)
        logger.info(f"Waiting for {pending_count} pending tasks (timeout={timeout}s)")
        
        try:
            # 等待所有任务完成
            done, pending = await asyncio.wait(
                self._pending,
                timeout=timeout,
                return_when=asyncio.ALL_COMPLETED,
            )
            
            completed = len(done)
            timed_out = len(pending)
            
            if timed_out > 0:
                logger.warning(f"{timed_out} tasks timed out, cancelling...")
                for task in pending:
                    task.cancel()
                # 再等待一小会让取消生效
                await asyncio.sleep(0.1)
            
            logger.info(f"Background tasks: {completed} completed, {timed_out} cancelled")
            return completed
            
        except Exception as e:
            logger.error(f"Error waiting for tasks: {e}")
            return 0
    
    def pending_count(self) -> int:
        """当前待处理任务数"""
        return len(self._pending)
    
    @property
    def is_shutting_down(self) -> bool:
        """是否正在关闭"""
        return self._shutting_down
