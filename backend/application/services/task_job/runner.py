import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from application.core.bot_runtime import ensure_bot
from application.core.context import AppRuntime
from application.core.response_sender import broadcast_init_config
from execution.task_executor import execute_task_step
from execution.task_queue import TaskJob

from .support import (
    FailureDecision,
    StepSummaryScheduler,
    TaskFailurePolicy,
    TaskJobReporter,
    failure_meta,
    pick_steps,
    remaining_steps,
    try_fatal_replan,
)


logger = logging.getLogger(__name__)
DEFAULT_RECOVERABLE_RETRY_LIMIT = 2
RECOVERABLE_RETRY_DELAY_SECONDS = 0.5


@dataclass
class TaskJobProcessor:
    runtime: AppRuntime
    bot_name: str
    job: TaskJob

    def __post_init__(self) -> None:
        self.client_id = str(self.job.get("client_id") or "")
        self.player = str(self.job.get("player") or "Unknown")
        self.run_id = str(self.job.get("run_id") or "")
        self.thread_id = str(self.job.get("thread_id") or "")
        self.source = str(self.job.get("source") or "task")
        self.steps = pick_steps(self.job)
        self.is_quick = self.source == "quick"
        self.response_action = str(self.job.get("response_action") or ("quick_exec" if self.is_quick else "task_exec"))
        self.hologram_text = str(self.job.get("hologram_text") or ("⚙️" if not self.is_quick else "✨"))
        self.reporter = TaskJobReporter(
            runtime=self.runtime,
            client_id=self.client_id,
            bot_name=self.bot_name,
            player=self.player,
            run_id=self.run_id,
            thread_id=self.thread_id,
            response_action=self.response_action,
            is_quick=self.is_quick,
            hologram_text=self.hologram_text,
        )
        self.policy = TaskFailurePolicy(DEFAULT_RECOVERABLE_RETRY_LIMIT)
        self.summary = StepSummaryScheduler(self.runtime)

    async def process(self) -> None:
        bot = await self._prepare_bot()
        if bot is None:
            return
        total = len(self.steps)
        self.reporter.record_event("task_queue", "task_job_started", payload={"total_steps": total})
        for idx, step in enumerate(self.steps, start=1):
            if not await self._process_step(bot, step, idx, total):
                return
        logger.info("任务执行完成 bot=%s total_steps=%s", self.bot_name, total)
        if self.client_id and not self.is_quick and self.reporter.should_emit_ingame_runtime_feedback():
            await self.reporter.send_feedback("任务执行完成喵。", hologram_text="✅")
        self.reporter.record_event("task_queue", "task_job_completed", payload={"total_steps": total})

    async def _prepare_bot(self) -> object | None:
        bot, created = await ensure_bot(self.runtime.bot_manager, self.bot_name)
        if created:
            await broadcast_init_config(self.runtime)
        if not bot:
            logger.error("Bot 不可用，任务终止 bot=%s", self.bot_name)
            await self.reporter.send_feedback("Bot 不可用，任务终止喵。", hologram_text="❌")
            self.reporter.record_event("error", "bot_unavailable", payload={"message": "Bot 不可用，任务终止喵。"})
            return None
        if not self.steps:
            logger.warning("任务为空，未执行任何动作 bot=%s", self.bot_name)
            await self.reporter.send_feedback("任务为空，未执行任何动作喵。", hologram_text="⚠️")
            self.reporter.record_event("error", "empty_task", payload={"message": "任务为空，未执行任何动作喵。"})
            return None
        bind_master = getattr(bot, "set_master_name", None)
        if callable(bind_master):
            bind_master(self.player)
        return bot

    async def _process_step(self, bot: object, step: dict[str, Any], idx: int, total: int) -> bool:
        action = str((step or {}).get("action") or "").strip()
        target = str((step or {}).get("target") or "").strip()
        count = step.get("count")
        reason = str((step or {}).get("reason") or "").strip()
        count_text = str(count) if count is not None else "<default>"
        logger.info(
            "[%s/%s] 开始执行 action=%s target=%s count=%s reason=%s",
            idx,
            total,
            action or "<missing>",
            target or "<empty>",
            count_text,
            reason or "<empty>",
        )
        if not action:
            await self.reporter.send_feedback(f"[{idx}/{total}] 任务步骤缺少 action，已中断喵。", hologram_text="⚠️")
            self.reporter.record_event(
                "error",
                "task_step_missing_action",
                payload={"message": "任务步骤缺少 action", "target": target},
                step_index=idx,
            )
            return False

        attempt = 0
        while True:
            attempt += 1
            self.reporter.record_event(
                "task_step",
                "task_step_started" if attempt == 1 else "task_step_retry_started",
                payload={
                    "action": action,
                    "target": target,
                    "count": count,
                    "reason": reason,
                    "total": total,
                    "attempt": attempt,
                },
                step_index=idx,
            )
            result = await execute_task_step(bot, action, target, reason, count=count if count is not None else None)
            if result.success:
                return await self._handle_success(bot, step, result, idx, total, attempt)
            if not await self._handle_failure(bot, step, result, idx, total, attempt):
                return False

    async def _handle_success(
        self,
        bot: object,
        step: dict[str, Any],
        result: Any,
        idx: int,
        total: int,
        attempt: int,
    ) -> bool:
        message = result.message
        action_name = str(step.get("action") or "").strip().lower()
        result_data = result.data if isinstance(result.data, dict) else {}
        spoken_text = str(result_data.get("spoken_text") or "").strip()
        logger.info(
            "[%s/%s] 执行成功 action=%s target=%s reason=%s attempt=%s message=%s",
            idx,
            total,
            step.get("action"),
            step.get("target") or "<empty>",
            step.get("reason") or "<empty>",
            attempt,
            message,
        )
        if action_name in {"speak", "say"} and spoken_text:
            await self.reporter.send_feedback(
                spoken_text,
                action="speak",
                force=True,
            )
        retry_note = "（局部恢复成功）" if attempt > 1 else ""
        text = f"{message}{retry_note}" if self.is_quick else f"[{idx}/{total}] {message}{retry_note}"
        await self.reporter.send_feedback(text)
        self.reporter.record_event(
            "task_step",
            "task_step_succeeded",
            payload={
                "action": step.get("action"),
                "target": step.get("target"),
                "reason": step.get("reason"),
                "message": message,
                "status": result.status.value,
                "executor_command": (result.data or {}).get("executor_command") if isinstance(result.data, dict) else None,
                "attempt": attempt,
            },
            step_index=idx,
        )
        self.summary.schedule(
            bot=bot,
            bot_name=self.bot_name,
            player=self.player,
            job=self.job,
            run_id=self.run_id,
            thread_id=self.thread_id,
            step_index=idx,
            total_steps=total,
            step=step,
            kind="success",
            attempt=attempt,
            result_payload={
                "message": message,
                "status": result.status.value,
                "error_code": result.error_code,
                "failure_class": None,
                "failure_reason": None,
            },
        )
        return True

    async def _handle_failure(
        self,
        bot: object,
        step: dict[str, Any],
        result: Any,
        idx: int,
        total: int,
        attempt: int,
    ) -> bool:
        action = str(step.get("action") or "").strip()
        target = str(step.get("target") or "").strip()
        reason = str(step.get("reason") or "").strip()
        message = result.message
        failure_class, failure_reason, raw_error = failure_meta(result)
        failure_payload = {
            "action": action,
            "target": target,
            "reason": reason,
            "message": message,
            "error_code": result.error_code,
            "status": result.status.value,
            "failure_class": failure_class,
            "failure_reason": failure_reason,
            "raw_error": raw_error,
            "executor_command": (result.data or {}).get("executor_command") if isinstance(result.data, dict) else None,
            "attempt": attempt,
        }
        decision = self.policy.decide(
            failure_class=failure_class,
            attempt=attempt,
            is_quick=self.is_quick,
            current_fail_count=int(self.job.get("fail_count") or 0),
        )
        if (
            failure_class == "fatal"
            and not self.is_quick
            and not decision.can_attempt_replan
        ):
            self.reporter.record_event(
                "graph",
                "fatal_replan_skipped",
                payload={
                    "reason": "fatal_replan_limit_reached",
                    "fail_count": int(self.job.get("fail_count") or 0),
                    "replan_limit": 2,
                },
                step_index=idx,
            )
        if decision.kind == "retry":
            return await self._retry_step(idx, total, message, failure_payload)
        if decision.kind == "suspend":
            await self._suspend_step(bot, step, idx, total, attempt, failure_reason, failure_payload)
            return False
        if decision.kind == "replan":
            replanned = await self._replan_step(bot, idx, total, message, failure_payload)
            return False if replanned else await self._fail_step(bot, step, idx, total, attempt, decision, failure_reason, failure_payload)
        return await self._fail_step(bot, step, idx, total, attempt, decision, failure_reason, failure_payload)

    async def _retry_step(self, idx: int, total: int, message: str, failure_payload: dict[str, Any]) -> bool:
        logger.warning(
            "[%s/%s] 局部重试 action=%s target=%s attempt=%s/%s message=%s",
            idx,
            total,
            failure_payload["action"],
            failure_payload["target"] or "<empty>",
            failure_payload["attempt"],
            DEFAULT_RECOVERABLE_RETRY_LIMIT,
            message,
        )
        text = (
            f"[{idx}/{total}] {message}，正在做第 {failure_payload['attempt']} 次局部恢复重试喵。"
            if not self.is_quick
            else f"{message}，正在局部恢复重试喵。"
        )
        await self.reporter.send_feedback(text, hologram_text="🔁")
        self.reporter.record_event(
            "task_step",
            "task_step_retry_scheduled",
            payload={
                **failure_payload,
                "retry_limit": DEFAULT_RECOVERABLE_RETRY_LIMIT,
                "retry_delay_seconds": RECOVERABLE_RETRY_DELAY_SECONDS,
            },
            step_index=idx,
        )
        await asyncio.sleep(RECOVERABLE_RETRY_DELAY_SECONDS)
        return True

    async def _suspend_step(
        self,
        bot: object,
        step: dict[str, Any],
        idx: int,
        total: int,
        attempt: int,
        failure_reason: str | None,
        failure_payload: dict[str, Any],
    ) -> None:
        text = (
            f"[{idx}/{total}] {failure_payload['message']}，当前任务已挂起喵。"
            if not self.is_quick
            else f"{failure_payload['message']}，当前任务已挂起喵。"
        )
        await self.reporter.send_feedback(text, hologram_text="⏸️")
        self.reporter.record_event("task_step", "task_step_suspended", payload=failure_payload, step_index=idx)
        self.summary.schedule(
            bot=bot,
            bot_name=self.bot_name,
            player=self.player,
            job=self.job,
            run_id=self.run_id,
            thread_id=self.thread_id,
            step_index=idx,
            total_steps=total,
            step=step,
            kind="suspended",
            attempt=attempt,
            result_payload=failure_payload,
        )
        self.reporter.record_event(
            "task_queue",
            "task_job_paused",
            payload={
                "paused_at_step": idx,
                "total_steps": total,
                "pending_steps": remaining_steps(self.steps, idx),
                "pause_reason": failure_reason,
            },
            step_index=idx,
        )

    async def _replan_step(
        self,
        bot: object,
        idx: int,
        total: int,
        message: str,
        failure_payload: dict[str, Any],
    ) -> bool:
        await self.reporter.send_feedback(
            f"[{idx}/{total}] {message}，我重新评估一下接下来怎么做喵。",
            action="task_replan",
            hologram_text="♻️",
        )
        return await try_fatal_replan(
            runtime=self.runtime,
            bot=bot,
            bot_name=self.bot_name,
            player=self.player,
            client_id=self.client_id,
            response_action=self.response_action,
            job=self.job,
            steps=self.steps,
            failed_step_index=idx,
            total_steps=total,
            failure_payload=failure_payload,
        )

    async def _fail_step(
        self,
        bot: object,
        step: dict[str, Any],
        idx: int,
        total: int,
        attempt: int,
        decision: FailureDecision,
        failure_reason: str | None,
        failure_payload: dict[str, Any],
    ) -> bool:
        logger.error(
            "[%s/%s] 任务失败 action=%s target=%s reason=%s failure_class=%s attempt=%s message=%s",
            idx,
            total,
            step.get("action"),
            step.get("target") or "<empty>",
            step.get("reason") or "<empty>",
            failure_payload["failure_class"],
            attempt,
            failure_payload["message"],
        )
        fatal_payload = {
            **failure_payload,
            "retry_limit": DEFAULT_RECOVERABLE_RETRY_LIMIT,
            "retries_exhausted": decision.retries_exhausted,
        }
        self.reporter.record_event("task_step", "task_step_failed", payload=fatal_payload, step_index=idx)
        self.summary.schedule(
            bot=bot,
            bot_name=self.bot_name,
            player=self.player,
            job=self.job,
            run_id=self.run_id,
            thread_id=self.thread_id,
            step_index=idx,
            total_steps=total,
            step=step,
            kind="failure",
            attempt=attempt,
            result_payload=fatal_payload,
        )
        self.reporter.record_event(
            "task_queue",
            "task_job_failed",
            payload={
                "failed_step": idx,
                "total_steps": total,
                "failed_reason": step.get("reason"),
                "error_code": failure_payload["error_code"],
                "failure_class": failure_payload["failure_class"],
                "failure_reason": failure_reason,
            },
            step_index=idx,
        )
        suffix = "，已达到局部恢复上限喵。" if decision.retries_exhausted else ""
        prefix = ""
        if failure_payload["failure_class"] == "fatal" and not self.is_quick and not decision.can_attempt_replan:
            prefix = "已达到重规划上限（2 次），"
        text = (
            f"{prefix}{failure_payload['message']}{suffix}"
            if self.is_quick
            else f"[{idx}/{total}] {prefix}{failure_payload['message']}{suffix}"
        )
        await self.reporter.send_feedback(text, hologram_text="⚠️")
        return False


async def process_task_job(runtime: AppRuntime, bot_name: str, job: TaskJob) -> None:
    await TaskJobProcessor(runtime=runtime, bot_name=bot_name, job=job).process()
