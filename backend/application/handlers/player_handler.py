import logging
from typing import Any

from application.core.bot_runtime import ensure_bot, resolve_bot_name
from application.core.context import AppRuntime
from application.services.graph_runner import extract_reply_text, run_graph_once
from application.core.response_sender import broadcast_init_config, send_error, send_npc_response
from execution.chat_executor import execute_chat_plan
from grounding.snapshot_builder import normalize_env_snapshot


logger = logging.getLogger(__name__)


def _format_task_queue_for_log(steps: list[dict[str, Any]]) -> str:
    """日志排版：任务队列按单步换行输出，避免整串挤成一行。"""
    if not steps:
        return "  (empty)"

    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            lines.append(f"  [{index}] <invalid_step> {step!r}")
            continue
        action = str(step.get("action") or "").strip() or "<missing>"
        target = str(step.get("target") or "").strip() or "<empty>"
        reason = str(step.get("reason") or "").strip() or "<empty>"
        lines.append(f"  [{index}] action={action} target={target} reason={reason}")
    return "\n".join(lines)


def _first_step_info(steps: list[dict[str, Any]]) -> tuple[str, str]:
    """信息提取器：从任务序列中获取第一步的动作与目标，用于向玩家展示进度。"""
    if not steps:
        return "unknown", "none"
    first = steps[0] if isinstance(steps[0], dict) else {}
    return str(first.get("action", "unknown")), str(first.get("target", "none"))


async def _try_handle_with_graph(
    message: dict,
    client_id: str,
    bot: object,
    bot_name: str,
    player: str,
    content: str,
    runtime: AppRuntime,
) -> bool:
    """大脑决策入口：调用 LangGraph Runner 开启深度思考逻辑。"""
    result = await run_graph_once(
        message=message,
        client_id=client_id,
        bot=bot,
        bot_name=bot_name,
        player=player,
        content=content,
        workflow_app=runtime.workflow_app,
        trace_repo=runtime.trace_repo,
    )
    if result is None:
        return False

    trace_ctx = result.get("trace_ctx") or {}
    run_id = str(trace_ctx.get("run_id") or "")
    thread_id = str(trace_ctx.get("thread_id") or "")
    intent = result.get("intent")
    if intent == "chat":
        reply_text = str(result.get("chat_reply_text") or "").strip() or extract_reply_text(result.get("route")) or "我在呢主人喵~"
        chat_plan = result.get("chat_plan") or []
        chat_outcome = await execute_chat_plan(bot, chat_plan, fallback_reply_text=reply_text)
        delivered_text = str(chat_outcome.spoken_text or reply_text).strip() or "我在呢主人喵~"
        await send_npc_response(
            client_id,
            bot_name,
            player,
            delivered_text,
            action="chat",
            hologram_text="💬",
        )
        if runtime.trace_repo and run_id:
            runtime.trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="chat_exec",
                event_name="chat_plan_executed",
                payload={
                    "step_count": len(chat_plan),
                    "executed_steps": chat_outcome.executed_steps,
                    "failed_steps": chat_outcome.failed_steps,
                },
            )
            runtime.trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="output",
                event_name="npc_response_sent",
                payload={"action": "chat", "content": delivered_text},
            )
        return True

    # 路径 B - 任务模式：将规划好的步骤序列压入后台异步队列。
    if intent == "task":
        task_queue = result.get("task_queue") or []
        opening_reply_text = str(result.get("opening_reply_text") or "").strip()
        # 异常防护：防止模型只认领了任务却没给出具体步骤。
        if not task_queue:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                "任务我听懂了，但暂时还没规划出步骤喵。",
                action="task_plan",
                hologram_text="🤔",
            )
            if runtime.trace_repo and run_id:
                runtime.trace_repo.record_event(
                    run_id=run_id,
                    thread_id=thread_id,
                    stage="output",
                    event_name="npc_response_sent",
                    payload={"action": "task_plan", "content": "任务我听懂了，但暂时还没规划出步骤喵。"},
                )
            return True

        if runtime.task_queue_manager is None:
            await send_error(client_id, "queue_unavailable", "task queue is unavailable")
            if runtime.trace_repo and run_id:
                runtime.trace_repo.record_event(
                    run_id=run_id,
                    thread_id=thread_id,
                    stage="error",
                    event_name="queue_unavailable",
                    payload={"message": "task queue is unavailable"},
                )
            return True

        # 异步投递：构造完整的任务 Job 并推入 Bot 专属队列，实现执行层隔离。
        first_action, first_target = _first_step_info(task_queue)
        queue_pos = await runtime.task_queue_manager.enqueue(
            bot_name,
            {
                "client_id": client_id,
                "player": player,
                "source": "task",
                "response_action": "task_exec",
                "hologram_text": "⚙️",
                "original_user_input": content,
                "opening_reply_text": opening_reply_text,
                "compressed_history": [],
                "initial_env_snapshot": normalize_env_snapshot(result.get("env_snapshot")),
                "route": result.get("route").model_dump() if hasattr(result.get("route"), "model_dump") else (result.get("route") or {}),
                "fail_count": 0,
                "steps": task_queue,
                "run_id": run_id,
                "thread_id": thread_id,
            },
        )

        logger.info("Planned task_queue for %s:\n%s", bot_name, _format_task_queue_for_log(task_queue))
        if runtime.trace_repo and run_id:
            runtime.trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="task_queue",
                event_name="task_enqueued",
                payload={"queue_pos": queue_pos, "steps": task_queue},
            )
        opening_text = opening_reply_text or (
            f"【BUG_FALLBACK_OPENING_REPLY_MISSING】任务已接收，共规划 {len(task_queue)} 步，"
            f"首步 {first_action}->{first_target}，已入队 #{queue_pos} 喵。"
        )
        await send_npc_response(
            client_id,
            bot_name,
            player,
            opening_text,
            action="task_plan",
            hologram_text="📥",
        )
        if runtime.trace_repo and run_id:
            runtime.trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="output",
                event_name="npc_response_sent",
                payload={
                    "action": "task_plan",
                    "content": opening_text,
                },
            )
        return True

    logger.warning("Graph returned unknown intent: %s", intent)
    return False


async def handle_player_message(message: dict, client_id: str, runtime: AppRuntime) -> None:
    """玩家消息入口：只做用例编排，不直接下沉到底层执行细节。"""
    player = message.get("player") or "Unknown"
    content = (message.get("content") or "").strip()
    bot_name = resolve_bot_name(message, runtime.bot_username)

    if not content:
        await send_error(client_id, "invalid_message", "content is empty")
        return

    bot, created = await ensure_bot(runtime.bot_manager, bot_name)
    if created:
        await broadcast_init_config(runtime)

    if not bot:
        await send_error(client_id, "bot_unavailable", f"Bot '{bot_name}' is unavailable")
        return

    bind_master = getattr(bot, "set_master_name", None)
    if callable(bind_master):
        bind_master(player)

    handled = await _try_handle_with_graph(
        message=message,
        client_id=client_id,
        bot=bot,
        bot_name=bot_name,
        player=player,
        content=content,
        runtime=runtime,
    )
    if handled:
        return

    await send_npc_response(
        client_id,
        bot_name,
        player,
        f"已收到指令：{content}。当前为极简降级模式，复杂任务暂未启用。",
        action="ack",
        hologram_text="💤 待命中",
    )

