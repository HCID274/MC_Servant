import logging
from typing import Any

from application.core.bot_runtime import ensure_bot, resolve_bot_name
from application.core.context import AppRuntime
from application.services.graph_runner import extract_reply_text, run_graph_once
from application.services.quick_command_parser import parse_quick_command
from application.core.response_sender import broadcast_init_config, send_error, send_npc_response


logger = logging.getLogger(__name__)


def _first_step_info(steps: list[dict[str, Any]]) -> tuple[str, str]:
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
    result = await run_graph_once(
        message=message,
        bot=bot,
        bot_name=bot_name,
        player=player,
        content=content,
        workflow_app=runtime.workflow_app,
    )
    if result is None:
        return False

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
        return True

    if intent == "task":
        task_queue = result.get("task_queue") or []
        if not task_queue:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                "任务我听懂了，但暂时还没规划出步骤喵。",
                action="task_plan",
                hologram_text="🤔",
            )
            return True

        if runtime.task_queue_manager is None:
            await send_error(client_id, "queue_unavailable", "task queue is unavailable")
            return True

        first_action, first_target = _first_step_info(task_queue)
        queue_pos = await runtime.task_queue_manager.enqueue(
            bot_name,
            {
                "client_id": client_id,
                "player": player,
                "source": "task",
                "response_action": "task_exec",
                "hologram_text": "⚙️",
                "steps": task_queue,
            },
        )

        logger.info("Planned task_queue for %s: %s", bot_name, task_queue)
        await send_npc_response(
            client_id,
            bot_name,
            player,
            f"任务已接收，共规划 {len(task_queue)} 步，首步 {first_action}->{first_target}，已入队 #{queue_pos} 喵。",
            action="task_plan",
            hologram_text="📥",
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

