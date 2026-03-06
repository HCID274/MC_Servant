import asyncio
import logging
from typing import Any, Optional

from application.bot_runtime import ensure_bot, resolve_bot_name
from application.context import AppRuntime
from application.response_sender import broadcast_init_config, send_error, send_npc_response
from execution.task_executor import execute_task_step
from execution.task_queue import TaskJob
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
        # 兜底逻辑：若模型响应过慢，则记录警告并返回空。
        logger.warning("LangGraph invoke timeout after %.1fs", timeout_seconds)
        return None
    except Exception as exc:
        # 鲁棒性保障：捕获 LLM 链路的所有异常。
        logger.warning("LangGraph invoke failed: %s", exc)
        return None


def _extract_reply_text(route: Any) -> Optional[str]:
    """属性提取器：适配不同的模型输出格式，提取用于回复玩家的纯文本。"""
    if route is None:
        return None
    if isinstance(route, dict):
        return route.get("reply_text")
    return getattr(route, "reply_text", None)


async def process_task_job(runtime: AppRuntime, bot_name: str, job: TaskJob) -> None:
    """任务执行器：负责将排队的抽象任务序列转化为具体的物理操作。"""
    client_id = str(job.get("client_id") or "")
    player = str(job.get("player") or "Unknown")
    tasks = job.get("tasks") or []

    # 执行环境保障：确保执行动作时 Bot 已经处于连接状态。
    bot, created = await ensure_bot(runtime.bot_manager, bot_name)
    if created:
        # 状态同步：若新生成了 Bot，需通知所有客户端更新列表。
        await broadcast_init_config(runtime)

    if not bot:
        # 失败反馈：若 Bot 彻底失联，及时告知玩家原因。
        if client_id:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                "Bot 不可用，任务终止喵。",
                action="task_exec",
                hologram_text="❌",
            )
        return

    total = len(tasks)
    # 任务序列迭代：按序翻译并执行 LLM 规划的每一个步骤。
    for idx, step in enumerate(tasks, start=1):
        action = str((step or {}).get("action") or "").strip()
        target = str((step or {}).get("target") or "").strip()
        
        # 参数校验：防止执行缺失关键指令的无效步骤。
        if not action:
            if client_id:
                await send_npc_response(
                    client_id,
                    bot_name,
                    player,
                    f"[{idx}/{total}] 任务步骤缺少 action，已中断喵。",
                    action="task_exec",
                    hologram_text="⚠️",
                )
            return

        # 物理执行：调用翻译层并将指令下发给 Mineflayer。
        ok, message = await execute_task_step(bot, action, target)
        if not ok:
            # 异常处理：若某个步骤失败（如寻路失败），中断整个任务流。
            if client_id:
                await send_npc_response(
                    client_id,
                    bot_name,
                    player,
                    f"[{idx}/{total}] {message}",
                    action="task_exec",
                    hologram_text="⚠️",
                )
            return

        # 进度反馈：执行完每一步都向玩家汇报“正在做什么”。
        if client_id:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                f"[{idx}/{total}] {message}",
                action="task_exec",
                hologram_text="⚙️",
            )

    # 任务终结：所有步骤完成后发送成功通知。
    if client_id:
        await send_npc_response(
            client_id,
            bot_name,
            player,
            "任务执行完成喵。",
            action="task_exec",
            hologram_text="✅",
        )


async def _try_handle_with_graph(
    message: dict,
    client_id: str,
    bot: object,
    bot_name: str,
    player: str,
    content: str,
    runtime: AppRuntime,
) -> bool:
    env_snapshot = await build_env_snapshot(message, bot_name, player, bot)
    state = {
        "user_input": content,
        "task_queue": [],
        "env_snapshot": env_snapshot,
    }

    result = await _invoke_workflow_with_timeout(runtime.workflow_app, state)
    if result is None:
        return False

    intent = result.get("intent")
    if intent == "chat":
        reply_text = _extract_reply_text(result.get("route")) or "我在呢主人喵~"
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
            return False

        first = task_queue[0] if isinstance(task_queue[0], dict) else {}
        first_action = first.get("action", "unknown")
        first_target = first.get("target", "none")
        queue_pos = await runtime.task_queue_manager.enqueue(
            bot_name,
            {
                "client_id": client_id,
                "player": player,
                "tasks": task_queue,
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
    """对话处理器：系统的主交互入口，负责快速响应基础指令或启动 LangGraph 决策。"""
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

    lowered = content.lower()
    if lowered in {"hello", "hi", "你好", "你好呀"}:
        await bot.jump()
        await send_npc_response(client_id, bot_name, player, "Ciallo~~~~", action="greeting", hologram_text="💖")
        return

    if lowered in {"status", "where", "你在哪", "位置"}:
        pos = await bot.get_position()
        text = f"我在 ({pos[0]:.0f}, {pos[1]:.0f}, {pos[2]:.0f})" if pos else "我现在还没准备好，稍后再试。"
        await send_npc_response(client_id, bot_name, player, text, action="status", hologram_text="📍")
        return

    if lowered in {"jump", "跳", "跳一下"}:
        await bot.jump()
        await send_npc_response(client_id, bot_name, player, "收到，跳了一下。", action="jump", hologram_text="🦘")
        return

    if lowered.startswith("say ") and len(content) > 4:
        to_say = content[4:].strip()
        await bot.chat(to_say)
        await send_npc_response(client_id, bot_name, player, f"已发送聊天: {to_say}", action="chat", hologram_text="💬")
        return

    if lowered.startswith("look ") and len(content) > 5:
        target = content[5:].strip()
        ok = await bot.look_at(target)
        text = "已看向目标。" if ok else "看向失败，请确认目标格式。"
        await send_npc_response(client_id, bot_name, player, text, action="look_at", hologram_text="👀")
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

