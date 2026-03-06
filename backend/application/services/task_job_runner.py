import logging
from typing import Any

from application.core.bot_runtime import ensure_bot
from application.core.context import AppRuntime
from application.core.response_sender import broadcast_init_config, send_npc_response
from execution.task_executor import execute_task_step
from execution.task_queue import TaskJob


logger = logging.getLogger(__name__)


def _pick_steps(job: TaskJob) -> list[dict[str, Any]]:
    steps = job.get("steps")
    if isinstance(steps, list):
        return steps
    tasks = job.get("tasks")
    if isinstance(tasks, list):
        return tasks
    return []


async def process_task_job(runtime: AppRuntime, bot_name: str, job: TaskJob) -> None:
    """任务执行编排：消费队列任务并统一回传执行进度。"""
    client_id = str(job.get("client_id") or "")
    player = str(job.get("player") or "Unknown")
    run_id = str(job.get("run_id") or "")
    thread_id = str(job.get("thread_id") or "")
    source = str(job.get("source") or "task")
    steps = _pick_steps(job)
    is_quick = source == "quick"
    response_action = str(job.get("response_action") or ("quick_exec" if is_quick else "task_exec"))
    hologram_text = str(job.get("hologram_text") or ("⚙️" if not is_quick else "✨"))

    def record_event(
        stage: str,
        event_name: str,
        *,
        payload: dict[str, Any] | None = None,
        step_index: int | None = None,
    ) -> None:
        if runtime.trace_repo is None or not run_id:
            return
        runtime.trace_repo.record_event(
            run_id=run_id,
            thread_id=thread_id or None,
            stage=stage,
            event_name=event_name,
            payload=payload,
            step_index=step_index,
        )

    bot, created = await ensure_bot(runtime.bot_manager, bot_name)
    if created:
        await broadcast_init_config(runtime)

    if not bot:
        if client_id:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                "Bot 不可用，任务终止喵。",
                action=response_action,
                hologram_text="❌",
            )
        record_event("error", "bot_unavailable", payload={"message": "Bot 不可用，任务终止喵。"})
        return

    if not steps:
        if client_id:
            await send_npc_response(
                client_id,
                bot_name,
                player,
                "任务为空，未执行任何动作喵。",
                action=response_action,
                hologram_text="⚠️",
            )
        record_event("error", "empty_task", payload={"message": "任务为空，未执行任何动作喵。"})
        return

    total = len(steps)
    record_event("task_queue", "task_job_started", payload={"total_steps": total})

    for idx, step in enumerate(steps, start=1):
        action = str((step or {}).get("action") or "").strip()
        target = str((step or {}).get("target") or "").strip()

        if not action:
            if client_id:
                await send_npc_response(
                    client_id,
                    bot_name,
                    player,
                    f"[{idx}/{total}] 任务步骤缺少 action，已中断喵。",
                    action=response_action,
                    hologram_text="⚠️",
                )
            record_event(
                "error",
                "task_step_missing_action",
                payload={"message": "任务步骤缺少 action", "target": target},
                step_index=idx,
            )
            return

        record_event(
            "task_step",
            "task_step_started",
            payload={"action": action, "target": target, "total": total},
            step_index=idx,
        )
        ok, message = await execute_task_step(bot, action, target)
        if not ok:
            if client_id:
                text = message if is_quick else f"[{idx}/{total}] {message}"
                await send_npc_response(
                    client_id,
                    bot_name,
                    player,
                    text,
                    action=response_action,
                    hologram_text="⚠️",
                )
            record_event(
                "task_step",
                "task_step_failed",
                payload={"action": action, "target": target, "message": message},
                step_index=idx,
            )
            return

        if client_id:
            text = message if is_quick else f"[{idx}/{total}] {message}"
            await send_npc_response(
                client_id,
                bot_name,
                player,
                text,
                action=response_action,
                hologram_text=hologram_text,
            )
        record_event(
            "task_step",
            "task_step_succeeded",
            payload={"action": action, "target": target, "message": message},
            step_index=idx,
        )

    if client_id and not is_quick:
        await send_npc_response(
            client_id,
            bot_name,
            player,
            "任务执行完成喵。",
            action=response_action,
            hologram_text="✅",
        )
    record_event("task_queue", "task_job_completed", payload={"total_steps": total})

