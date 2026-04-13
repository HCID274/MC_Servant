import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Optional

from application.core.context import AppRuntime
from application.core.response_sender import send_npc_response
from application.services.graph_runner import run_fatal_replan_once
from execution.task_queue import TaskJob
from grounding.snapshot_builder import build_env_snapshot, normalize_env_snapshot
from llm_agent.agents.summary import invoke_step_summary_agent

from .summary_input_builder import build_step_summary_input


logger = logging.getLogger(__name__)
RECENT_SUMMARY_LIMIT = 3
MAX_FATAL_REPLAN_ATTEMPTS = 2


async def capture_env_snapshot(bot_name: str, player: str, bot: object) -> dict[str, Any]:
    return normalize_env_snapshot(
        await build_env_snapshot({}, bot_name, player, bot),
        bot_name=bot_name,
        player=player,
    )


def pick_steps(job: TaskJob) -> list[dict[str, Any]]:
    steps = job.get("steps")
    if isinstance(steps, list):
        return steps
    tasks = job.get("tasks")
    if isinstance(tasks, list):
        return tasks
    return []


def remaining_steps(steps: list[dict[str, Any]], step_index: int) -> list[dict[str, Any]]:
    return steps[max(step_index - 1, 0) :]


def failure_meta(result: Any) -> tuple[str, str | None, dict[str, Any] | None]:
    data = result.data if isinstance(result.data, dict) else {}
    failure_class = str(data.get("failure_class") or "fatal").strip() or "fatal"
    failure_reason = data.get("failure_reason")
    raw_error = data.get("raw_error")
    return failure_class, failure_reason, raw_error if isinstance(raw_error, dict) else None


@dataclass
class TaskJobReporter:
    runtime: AppRuntime
    client_id: str
    bot_name: str
    player: str
    run_id: str
    thread_id: str
    response_action: str
    is_quick: bool
    hologram_text: str

    def should_emit_ingame_runtime_feedback(self) -> bool:
        return self.is_quick

    def record_event(
        self,
        stage: str,
        event_name: str,
        *,
        payload: dict[str, Any] | None = None,
        step_index: int | None = None,
    ) -> None:
        if self.runtime.trace_repo is None or not self.run_id:
            return
        self.runtime.trace_repo.record_event(
            run_id=self.run_id,
            thread_id=self.thread_id or None,
            stage=stage,
            event_name=event_name,
            payload=payload,
            step_index=step_index,
        )

    async def send_feedback(
        self,
        text: str,
        *,
        action: Optional[str] = None,
        hologram_text: Optional[str] = None,
        force: bool = False,
    ) -> None:
        if not self.client_id or (not force and not self.should_emit_ingame_runtime_feedback()):
            return
        await send_npc_response(
            self.client_id,
            self.bot_name,
            self.player,
            text,
            action=action or self.response_action,
            hologram_text=hologram_text or self.hologram_text,
        )


class StepSummaryScheduler:
    def __init__(self, runtime: AppRuntime):
        self._runtime = runtime

    def schedule(self, **kwargs: Any) -> None:
        asyncio.create_task(self._capture(**kwargs))

    async def _capture(
        self,
        *,
        bot: object,
        bot_name: str,
        player: str,
        job: TaskJob,
        run_id: str,
        thread_id: str,
        step_index: int,
        total_steps: int,
        step: dict[str, Any],
        kind: str,
        attempt: int,
        result_payload: dict[str, Any],
    ) -> None:
        trace_repo = self._runtime.trace_repo
        if trace_repo is None or not run_id or not thread_id:
            return

        action = str(step.get("action") or "").strip()
        target = str(step.get("target") or "").strip()
        summary_id = f"{run_id}:step_{step_index}_{kind}"
        trace_repo.record_event(
            run_id=run_id,
            thread_id=thread_id,
            stage="summary",
            event_name="step_summary_started",
            payload={"summary_id": summary_id, "step_index": step_index, "kind": kind},
            step_index=step_index,
        )
        try:
            env_snapshot = await capture_env_snapshot(bot_name, player, bot)
            recent_summaries = trace_repo.list_step_summaries(thread_id, limit=RECENT_SUMMARY_LIMIT)
            summary_input = build_step_summary_input(
                job=job,
                step_index=step_index,
                total_steps=total_steps,
                step=step,
                kind=kind,
                attempt=attempt,
                result_payload=result_payload,
                env_snapshot=env_snapshot,
                recent_summaries=recent_summaries,
            )
            output = await asyncio.to_thread(
                invoke_step_summary_agent,
                summary_input=summary_input,
                trace_repo=trace_repo,
                trace_ctx={"run_id": run_id, "thread_id": thread_id},
            )
            if output is None or not str(output.summary_text or "").strip():
                trace_repo.record_event(
                    run_id=run_id,
                    thread_id=thread_id,
                    stage="summary",
                    event_name="step_summary_failed",
                    payload={"summary_id": summary_id, "reason": "empty_summary"},
                    step_index=step_index,
                )
                return
            summary_text = str(output.summary_text).strip()
            trace_repo.record_step_summary(
                summary_id=summary_id,
                run_id=run_id,
                thread_id=thread_id,
                step_index=step_index,
                action=action,
                target=target or None,
                kind=kind,
                summary_text=summary_text,
                summary_input=summary_input,
                detail_ref={
                    "run_id": run_id,
                    "thread_id": thread_id,
                    "step_index": step_index,
                    "kind": kind,
                    "action": action,
                    "target": target,
                },
            )
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="summary",
                event_name="step_summary_completed",
                payload={"summary_id": summary_id, "summary_text": summary_text},
                step_index=step_index,
            )
        except Exception as exc:
            logger.warning("Step summary capture failed for %s step %s: %s", bot_name, step_index, exc)
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="summary",
                event_name="step_summary_failed",
                payload={"summary_id": summary_id, "reason": str(exc)},
                step_index=step_index,
            )


@dataclass
class FailureDecision:
    kind: str
    retries_exhausted: bool
    can_attempt_replan: bool


class TaskFailurePolicy:
    def __init__(self, retry_limit: int):
        self._retry_limit = retry_limit

    def decide(
        self,
        *,
        failure_class: str,
        attempt: int,
        is_quick: bool,
        current_fail_count: int,
    ) -> FailureDecision:
        retries_exhausted = failure_class == "recoverable" and attempt > self._retry_limit
        can_attempt_replan = current_fail_count < MAX_FATAL_REPLAN_ATTEMPTS
        if failure_class == "recoverable" and attempt <= self._retry_limit:
            return FailureDecision("retry", retries_exhausted=False, can_attempt_replan=can_attempt_replan)
        if failure_class == "suspendable":
            return FailureDecision("suspend", retries_exhausted=False, can_attempt_replan=False)
        if failure_class == "fatal" and not is_quick and can_attempt_replan:
            return FailureDecision("replan", retries_exhausted=False, can_attempt_replan=True)
        return FailureDecision("fail", retries_exhausted=retries_exhausted, can_attempt_replan=can_attempt_replan)


async def try_fatal_replan(
    *,
    runtime: AppRuntime,
    bot: object,
    bot_name: str,
    player: str,
    client_id: str,
    response_action: str,
    job: TaskJob,
    steps: list[dict[str, Any]],
    failed_step_index: int,
    total_steps: int,
    failure_payload: dict[str, Any],
) -> bool:
    trace_repo = runtime.trace_repo
    task_queue_manager = runtime.task_queue_manager
    workflow_app = runtime.workflow_app
    run_id = str(job.get("run_id") or "")
    thread_id = str(job.get("thread_id") or "")
    original_user_input = str(job.get("original_user_input") or "").strip()
    route = job.get("route") or {}
    fail_count = int(job.get("fail_count") or 0) + 1

    if fail_count > MAX_FATAL_REPLAN_ATTEMPTS:
        if trace_repo is not None and run_id:
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id or None,
                stage="graph",
                event_name="fatal_replan_skipped",
                payload={
                    "reason": "fatal_replan_limit_reached",
                    "fail_count": fail_count,
                    "replan_limit": MAX_FATAL_REPLAN_ATTEMPTS,
                },
                step_index=failed_step_index,
            )
        return False

    if not original_user_input or not thread_id or not route or workflow_app is None or task_queue_manager is None:
        if trace_repo is not None and run_id:
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id or None,
                stage="graph",
                event_name="fatal_replan_failed",
                payload={"reason": "replan_context_incomplete"},
                step_index=failed_step_index,
            )
        return False

    env_snapshot = await capture_env_snapshot(bot_name, player, bot)
    compressed_history = trace_repo.list_step_summaries(thread_id, limit=5) if trace_repo is not None else []
    failure_reason = str(
        failure_payload.get("failure_reason") or failure_payload.get("message") or "任务执行陷入物理死局"
    ).strip()
    execution_result = {
        "failed_step_index": failed_step_index,
        "failed_action": failure_payload.get("action"),
        "failed_target": failure_payload.get("target"),
        "failed_reason": failure_payload.get("reason"),
        "failed_message": failure_payload.get("message"),
        "error_code": failure_payload.get("error_code"),
        "failure_class": failure_payload.get("failure_class"),
        "completed_steps": max(0, failed_step_index - 1),
        "remaining_steps": steps[failed_step_index - 1 :],
        "total_steps": total_steps,
    }

    if trace_repo is not None and run_id:
        trace_repo.record_event(
            run_id=run_id,
            thread_id=thread_id,
            stage="graph",
            event_name="fatal_replan_requested",
            payload={
                "failed_step_index": failed_step_index,
                "failure_reason": failure_reason,
                "failed_step_reason": failure_payload.get("reason"),
                "fail_count": fail_count,
            },
            step_index=failed_step_index,
        )

    result = await run_fatal_replan_once(
        client_id=client_id,
        bot_name=bot_name,
        player=player,
        original_user_input=original_user_input,
        thread_id=thread_id,
        route_payload=route,
        env_snapshot=env_snapshot,
        failure_reason=failure_reason,
        execution_result=execution_result,
        compressed_history=compressed_history,
        fail_count=fail_count,
        workflow_app=workflow_app,
        trace_repo=trace_repo,
    )
    if result is None:
        if trace_repo is not None and run_id:
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="graph",
                event_name="fatal_replan_failed",
                payload={"reason": "graph_replan_failed"},
                step_index=failed_step_index,
            )
        return False

    replanned_steps = result.get("task_queue") or []
    if not isinstance(replanned_steps, list) or not replanned_steps:
        if trace_repo is not None and run_id:
            trace_repo.record_event(
                run_id=run_id,
                thread_id=thread_id,
                stage="graph",
                event_name="fatal_replan_failed",
                payload={"reason": "empty_replanned_steps"},
                step_index=failed_step_index,
            )
        return False

    replanned_trace_ctx = result.get("trace_ctx") or {}
    replanned_run_id = str(replanned_trace_ctx.get("run_id") or "")
    replanned_thread_id = str(replanned_trace_ctx.get("thread_id") or thread_id)
    opening_reply_text = str(result.get("opening_reply_text") or "").strip()
    queue_pos = await task_queue_manager.enqueue(
        bot_name,
        {
            "client_id": client_id,
            "player": player,
            "source": "task",
            "response_action": response_action,
            "hologram_text": "⚙️",
            "original_user_input": original_user_input,
            "opening_reply_text": opening_reply_text,
            "compressed_history": compressed_history,
            "initial_env_snapshot": env_snapshot,
            "route": result.get("route").model_dump()
            if hasattr(result.get("route"), "model_dump")
            else (result.get("route") or route),
            "fail_count": fail_count,
            "steps": replanned_steps,
            "run_id": replanned_run_id,
            "thread_id": replanned_thread_id,
        },
    )

    first_step = replanned_steps[0] if replanned_steps and isinstance(replanned_steps[0], dict) else {}
    first_action = str(first_step.get("action") or "unknown")
    first_target = str(first_step.get("target") or "none")
    opening_text = opening_reply_text or (
        f"【BUG_FALLBACK_REPLAN_OPENING_REPLY_MISSING】任务已重新规划，共 {len(replanned_steps)} 步，"
        f"首步 {first_action}->{first_target}，已重新入队 #{queue_pos} 喵。"
    )
    if client_id:
        await send_npc_response(
            client_id,
            bot_name,
            player,
            opening_text,
            action="task_replan",
            hologram_text="♻️",
        )
    if trace_repo is not None and replanned_run_id:
        trace_repo.record_event(
            run_id=replanned_run_id,
            thread_id=replanned_thread_id,
            stage="task_queue",
            event_name="task_replan_enqueued",
            payload={"queue_pos": queue_pos, "steps": replanned_steps},
        )
        trace_repo.record_event(
            run_id=replanned_run_id,
            thread_id=replanned_thread_id,
            stage="output",
            event_name="npc_response_sent",
            payload={"action": "task_replan", "content": opening_text},
        )
    return True
