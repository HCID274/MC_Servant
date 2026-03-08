import logging
from typing import Any

from application.core.bot_runtime import ensure_bot, resolve_bot_name
from application.core.context import AppRuntime
from application.services.graph_runner import extract_reply_text, run_graph_once
from application.services.quick_command_parser import parse_quick_command
from application.core.response_sender import broadcast_init_config, send_error, send_npc_response


logger = logging.getLogger(__name__)


def _first_step_info(steps: list[dict[str, Any]]) -> tuple[str, str]:
    """信息提取器：从任务序列中获取第一步的动作与目标，用于向玩家展示进度。"""
    if not steps:
        return "unknown", "none"
    first = steps[0] if isinstance(steps[0], dict) else {}
    return str(first.get("action", "unknown")), str(first.get("target", "none"))


async def _enqueue_quick_job(
    runtime: AppRuntime,
    bot_name: str,
    client_id: str,
    player: str,
    quick_job: dict,
) -> bool:
    """快捷任务入队：将预定义的简单指令（如跳跃、说话）直接压入异步执行队列。"""
    if runtime.task_queue_manager is None:
        await send_error(client_id, "queue_unavailable", "task queue is unavailable")
        return True

    queue_pos = await runtime.task_queue_manager.enqueue(
        bot_name,
        {
            "client_id": client_id,
            "player": player,
            "source": "quick",
            "response_action": quick_job.get("response_action", "quick_exec"),
            "hologram_text": quick_job.get("hologram_text", "✨"),
            "steps": quick_job.get("steps", []),
        },
    )
    # 反馈机制：若前面有任务在排队，告知玩家。
    if queue_pos > 1:
        await send_npc_response(
            client_id,
            bot_name,
            player,
            f"指令已入队 #{queue_pos}，前方还有 {queue_pos - 1} 条待执行喵。",
            action="quick_queue",
            hologram_text="📥",
        )
    return True


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
        reply_text = extract_reply_text(result.get("route")) or "我在呢主人喵~"
        await send_npc_response(
            client_id,
            bot_name,
            player,
            reply_text,
            action="chat",
            hologram_text="💬",
        )
        if runtime.trace_repo and run_id:
            runtime.trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="output",
                event_name="npc_response_sent",
                payload={"action": "chat", "content": reply_text},
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
                "initial_env_snapshot": result.get("env_snapshot") or {},
                "steps": task_queue,
                "run_id": run_id,
                "thread_id": thread_id,
            },
        )

        logger.info("Planned task_queue for %s: %s", bot_name, task_queue)
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

    quick_job = parse_quick_command(content)
    if quick_job:
        handled = await _enqueue_quick_job(runtime, bot_name, client_id, player, quick_job)
        if handled:
            return

    bot, created = await ensure_bot(runtime.bot_manager, bot_name)
    if created:
        await broadcast_init_config(runtime)

    if not bot:
        await send_error(client_id, "bot_unavailable", f"Bot '{bot_name}' is unavailable")
        return

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

