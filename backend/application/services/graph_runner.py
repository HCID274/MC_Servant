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
    """追踪上下文构建：为单次请求生成唯一的运行标识符。"""
    run_id = uuid.uuid4().hex
    return {
        "run_id": run_id,
        "thread_id": run_id,
        "client_id": client_id,
        "bot_name": bot_name,
        "player_name": player,
    }


def _build_graph_config(trace_ctx: dict[str, str]) -> dict[str, dict[str, str]]:
    """图配置生成：构造 LangGraph 需要的持久化线程与命名空间参数。"""
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
    """异步执行引擎：优先调用 ainvoke 接口，确保与异步持久化层的兼容性。"""
    if workflow_app is None:
        return None, "workflow_unavailable"

    try:
        # 直接调用原生异步执行！优雅，高效！
        result = await asyncio.wait_for(
            workflow_app.ainvoke(state, config=config), 
            timeout=timeout_seconds
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
    """动态 API 调用器：封装对 LangGraph 状态查询接口的同步/异步适配逻辑。"""
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
    """历史版本计数：统计当前对话线程产生的检查点总数。"""
    history = await _call_state_api(workflow_app, "aget_state_history", "get_state_history", config)
    if history is None:
        return 0

    count = 0
    # 异步迭代兼容：处理流式或集合式的历史数据。
    if hasattr(history, "__aiter__"):
        async for _ in history:
            count += 1
        return count

    for _ in history:
        count += 1
    return count


def _extract_checkpoint_id(snapshot: Any) -> Optional[str]:
    """标识符提取：从状态快照中挖掘持久化记录的唯一 ID。"""
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
        # 字段嗅探：尝试获取不同版本 LangGraph 使用的 ID 字段。
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
    """追踪打点：记录一次决策流程中的细粒度逻辑事件。"""
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
    """台词提取器：适配不同模型输出结构，剥离用于语音播报的纯文本。"""
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
    """单次图执行用例：串联感知、思考、追踪，完成一次全链路决策请求。"""
    # 感知层：获取当前物理坐标。
    env_snapshot = await build_env_snapshot(message, bot_name, player, bot)
    trace_ctx = _build_trace_ctx(client_id, bot_name, player)
    config = _build_graph_config(trace_ctx)

    # 链路追踪初始化：登记一次新的 Run。
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

    # 驱动决策流。
    state = {
        "user_input": content,
        "task_queue": [],
        "env_snapshot": env_snapshot,
        "trace_ctx": trace_ctx,
    }
    _record_event(trace_repo, trace_ctx, stage="graph", event_name="graph_started")

    result, error = await _invoke_workflow_with_timeout(workflow_app, state, config)
    if result is None:
        # 异常链路记录：登记失败原因。
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

    # 后置审计：提取生成的快照与检查点计数。
    snapshot = await _call_state_api(workflow_app, "aget_state", "get_state", config)
    latest_checkpoint_id = _extract_checkpoint_id(snapshot)
    checkpoint_count = await _count_state_history(workflow_app, config)
    status = "interrupted" if "__interrupt__" in result else "completed"
    reply_text = extract_reply_text(result.get("route")) if result.get("intent") == "chat" else None

    # 完成打点：记录生成的任务量与状态。
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
