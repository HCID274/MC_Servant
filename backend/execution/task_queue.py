import asyncio
import logging
from typing import Any, Awaitable, Callable, Dict, TypedDict

from execution.task_worker import run_task_worker


class TaskJob(TypedDict):
    client_id: str
    player: str
    tasks: list[dict[str, Any]]


class TaskQueueManager:
    """任务调度器：为每个 Bot 维护独立的异步队列，实现指令排队与防并发执行。"""

    def __init__(self, process_job: Callable[[str, TaskJob], Awaitable[None]]):
        self._process_job = process_job
        self._queues: Dict[str, asyncio.Queue[TaskJob]] = {}
        self._workers: Dict[str, asyncio.Task] = {}
        self._logger = logging.getLogger(__name__)

    def _get_or_create_queue(self, bot_name: str) -> asyncio.Queue[TaskJob]:
        """队列索引：为每个独立的 Bot 获取或初始化一个专属的异步通信队列。"""
        queue = self._queues.get(bot_name)
        if queue is None:
            queue = asyncio.Queue()
            self._queues[bot_name] = queue
        return queue

    def _ensure_worker(self, bot_name: str) -> None:
        """Worker 守护：确保目标 Bot 的后台处理线程正在运行，若已停止则重新拉起。"""
        worker = self._workers.get(bot_name)
        if worker is not None and not worker.done():
            return

        queue = self._get_or_create_queue(bot_name)
        # 启动协程：绑定 Bot 名称与对应的消费队列。
        self._workers[bot_name] = asyncio.create_task(
            run_task_worker(bot_name, queue, self._process_job, self._logger),
            name=f"task-worker-{bot_name}",
        )

    async def enqueue(self, bot_name: str, job: TaskJob) -> int:
        """任务入队：将新任务压入队列，并返回该 Bot 当前排队的总长度。"""
        self._ensure_worker(bot_name)
        queue = self._get_or_create_queue(bot_name)
        pending_before = queue.qsize()
        await queue.put(job)
        return pending_before + 1

    async def shutdown(self) -> None:
        """全局清理：取消所有活跃的 Worker 线程并清空内存队列。"""
        for worker in self._workers.values():
            worker.cancel()
        if self._workers:
            await asyncio.gather(*self._workers.values(), return_exceptions=True)
        self._workers.clear()
        self._queues.clear()

