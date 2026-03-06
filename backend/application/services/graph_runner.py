import asyncio
import logging
from typing import Any, Optional

from grounding.snapshot_builder import build_env_snapshot


logger = logging.getLogger(__name__)


async def _invoke_workflow_with_timeout(
    workflow_app: Any,
    state: dict,
    timeout_seconds: float = 20.0,
) -> Optional[dict]:
    """异步执行保障：在独立线程运行 LangGraph，并设置严格的超时阈值。"""
    if workflow_app is None:
        return None
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(workflow_app.invoke, state),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("LangGraph invoke timeout after %.1fs", timeout_seconds)
        return None
    except Exception as exc:
        logger.warning("LangGraph invoke failed: %s", exc)
        return None


def extract_reply_text(route: Any) -> Optional[str]:
    """属性提取器：适配不同模型输出格式，提取可读回复文本。"""
    if route is None:
        return None
    if isinstance(route, dict):
        return route.get("reply_text")
    return getattr(route, "reply_text", None)


async def run_graph_once(
    message: dict,
    bot: object,
    bot_name: str,
    player: str,
    content: str,
    workflow_app: Any,
) -> Optional[dict]:
    """图执行用例：构建环境快照并执行一次 Router->Planner 链路。"""
    env_snapshot = await build_env_snapshot(message, bot_name, player, bot)
    state = {
        "user_input": content,
        "task_queue": [],
        "env_snapshot": env_snapshot,
    }
    return await _invoke_workflow_with_timeout(workflow_app, state)
