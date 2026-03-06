import asyncio
import inspect
import logging
import uuid
from typing import Any, Optional

from config import settings
from grounding.snapshot_builder import build_env_snapshot
from tracing.repository import TraceRepository


logger = logging.getLogger(__name__)


def _build_trace_ctx(client_id: str, bot_name: str, player: str) -> dict[str, str]:
    run_id = uuid.uuid4().hex
    return {
        "run_id": run_id,
        "thread_id": run_id,
        "client_id": client_id,
        "bot_name": bot_name,
        "player_name": player,
    }


def _build_graph_config(trace_ctx: dict[str, str]) -> dict[str, dict[str, str]]:
    return {
        "configurable": {
            "thread_id": trace_ctx["thread_id"],
            "checkpoint_ns": "mc_servant.main_workflow",
        }
    }


async def _invoke_workflow_with_timeout(
    workflow_app: Any,
    state: dict,
    config: dict[str, Any],
    timeout_seconds: float = 20.0,
) -> tuple[Optional[dict], Optional[str]]:
    """异步执行保障：优先走 ainvoke，以兼容 AsyncSqliteSaver。"""
    if workflow_app is None:
        return None, "workflow_unavailable"

    try:
        ainvoke = getattr(workflow_app, "ainvoke", None)
        if callable(ainvoke):
            result = await asyncio.wait_for(ainvoke(state, config=config), timeout=timeout_seconds)
        else:
            result = await asyncio.wait_for(
                asyncio.to_thread(workflow_app.invoke, state, config),
                timeout=timeout_seconds,
            )
        return result, None
    except asyncio.TimeoutError:
        logger.warning("LangGraph invoke timeout after %.1fs", timeout_seconds)
        return None, "timeout"
    except Exception as exc:
        logger.warning("LangGraph invoke failed: %s", exc)
        return None, str(exc)


async def _call_state_api(
    workflow_app: Any,
    async_name: str,
    sync_name: str,
    config: dict[str, Any],
) -> Any:
    async_method = getattr(workflow_app, async_name, None)
    if callable(async_method):
        result = async_method(config)
        if inspect.isawaitable(result):
            return await result
        return result

    sync_method = getattr(workflow_app, sync_name, None)
    if callable(sync_method):
        return await asyncio.to_thread(sync_method, config)
    return None


async def _count_state_history(workflow_app: Any, config: dict[str, Any]) -> int:
    history = await _call_state_api(workflow_app, "aget_state_history", "get_state_history", config)
    if history is None:
        return 0

    count = 0
    if hasattr(history, "__aiter__"):
        async for _ in history:
            count += 1
        return count

    for _ in history:
        count += 1
    return count


def _extract_checkpoint_id(snapshot: Any) -> Optional[str]:
    if snapshot is None:
        return None

    containers = [
        getattr(snapshot, "config", None),
        getattr(snapshot, "metadata", None),
    ]
    for container in containers:
        if not isinstance(container, dict):
            continue
        configurable = container.get("configurable", container)
        if not isinstance(configurable, dict):
            continue
        for key in ("checkpoint_id", "thread_ts"):
            value = configurable.get(key)
            if value:
                return str(value)
    return None


def _record_event(
    trace_repo: Optional[TraceRepository],
    trace_ctx: dict[str, str],
    *,
    stage: str,
    event_name: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    if trace_repo is None:
        return
    trace_repo.record_event(
        run_id=trace_ctx["run_id"],
        thread_id=trace_ctx["thread_id"],
        stage=stage,
        event_name=event_name,
        payload=payload,
    )


def extract_reply_text(route: Any) -> Optional[str]:
    """属性提取器：适配不同模型输出格式，提取可读回复文本。"""
    if route is None:
        return None
    if isinstance(route, dict):
        return route.get("reply_text")
    return getattr(route, "reply_text", None)


async def run_graph_once(
    message: dict,
    client_id: str,
    bot: object,
    bot_name: str,
    player: str,
    content: str,
    workflow_app: Any,
    trace_repo: Optional[TraceRepository] = None,
) -> Optional[dict]:
    """图执行用例：构建环境快照、登记 run，并执行一次 Router->Planner 链路。"""
    env_snapshot = await build_env_snapshot(message, bot_name, player, bot)
    trace_ctx = _build_trace_ctx(client_id, bot_name, player)
    config = _build_graph_config(trace_ctx)

    if trace_repo is not None:
        trace_repo.record_run_started(
            run_id=trace_ctx["run_id"],
            thread_id=trace_ctx["thread_id"],
            client_id=client_id,
            bot_name=bot_name,
            player_name=player,
            source_type="graph",
            request_type=str(message.get("type") or "player_message"),
            user_input=content,
            request_payload=message,
            env_snapshot=env_snapshot,
            workflow_version=settings.workflow_version,
        )
        _record_event(
            trace_repo,
            trace_ctx,
            stage="ingress",
            event_name="player_message_received",
            payload={"content": content},
        )

    state = {
        "user_input": content,
        "task_queue": [],
        "env_snapshot": env_snapshot,
        "trace_ctx": trace_ctx,
    }
    _record_event(trace_repo, trace_ctx, stage="graph", event_name="graph_started")

    result, error = await _invoke_workflow_with_timeout(workflow_app, state, config)
    if result is None:
        status = "timed_out" if error == "timeout" else "failed"
        error_code = "graph_timeout" if error == "timeout" else "graph_failed"
        _record_event(
            trace_repo,
            trace_ctx,
            stage="error",
            event_name=error_code,
            payload={"message": error},
        )
        if trace_repo is not None:
            trace_repo.update_run(
                trace_ctx["run_id"],
                status=status,
                error_code=error_code,
                error_message=error,
            )
        return None

    snapshot = await _call_state_api(workflow_app, "aget_state", "get_state", config)
    latest_checkpoint_id = _extract_checkpoint_id(snapshot)
    checkpoint_count = await _count_state_history(workflow_app, config)
    status = "interrupted" if "__interrupt__" in result else "completed"
    reply_text = extract_reply_text(result.get("route")) if result.get("intent") == "chat" else None

    _record_event(
        trace_repo,
        trace_ctx,
        stage="graph",
        event_name="graph_finished",
        payload={
            "intent": result.get("intent"),
            "latest_checkpoint_id": latest_checkpoint_id,
            "checkpoint_count": checkpoint_count,
            "task_queue_size": len(result.get("task_queue") or []),
            "status": status,
        },
    )

    if trace_repo is not None:
        trace_repo.update_run(
            trace_ctx["run_id"],
            status=status,
            intent=result.get("intent"),
            reply_text=reply_text,
            latest_checkpoint_id=latest_checkpoint_id,
            checkpoint_count=checkpoint_count,
        )

    return result
