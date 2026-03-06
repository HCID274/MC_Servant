import asyncio
import logging
from typing import Awaitable, Callable


async def run_task_worker(
    bot_name: str,
    queue: asyncio.Queue[dict],
    process_job: Callable[[str, dict], Awaitable[None]],
    logger: logging.Logger,
) -> None:
    """后台工作线程：按 Bot 维度串行消费任务队列，确保物理动作不会重叠或冲突。"""
    while True:
        try:
            # 阻塞等待：直到队列中有新的任务进入。
            job = await queue.get()
        except asyncio.CancelledError:
            # 优雅退出：系统关闭时停止循环。
            return

        try:
            # 任务回调：调用 player_handler 提供的执行逻辑。
            await process_job(bot_name, job)
        except Exception as exc:
            # 异常捕获：确保单个任务的失败不会杀掉整个 Worker 线程。
            logger.exception("Task worker error (%s): %s", bot_name, exc)
        finally:
            # 队列确认：标记当前 Job 已完成。
            queue.task_done()
