from typing import Any, Optional

from tracing.store import TraceStore


def get_summary_dossier(trace_repo: Optional[TraceStore], summary_id: str) -> Optional[dict[str, Any]]:
    """卷宗聚合：按 summary_id 汇总该步骤的摘要、run、事件与模型调用明细。"""
    if trace_repo is None:
        return None

    summary = trace_repo.get_step_summary(summary_id)
    if summary is None:
        return None

    run_id = str(summary.get("run_id") or "")
    step_index = summary.get("step_index")
    thread_id = str(summary.get("thread_id") or "")
    return {
        "summary": summary,
        "run": trace_repo.get_agent_run(run_id) if run_id else None,
        "events": trace_repo.list_run_events(run_id, step_index=step_index, limit=50) if run_id else [],
        "llm_calls": trace_repo.list_llm_calls(run_id, limit=20) if run_id else [],
        "recent_thread_summaries": trace_repo.list_step_summaries(thread_id, limit=5) if thread_id else [],
    }


def get_thread_dossier(
    trace_repo: Optional[TraceStore],
    thread_id: str,
    *,
    run_limit: int = 5,
    summary_limit: int = 10,
    event_limit: int = 30,
    llm_limit: int = 20,
) -> Optional[dict[str, Any]]:
    """线程卷宗：按 thread_id 聚合该任务生命线上的运行、摘要与最近事件。"""
    if trace_repo is None:
        return None

    runs = trace_repo.list_runs_by_thread(thread_id, limit=run_limit)
    if not runs:
        return None

    latest_run_id = str(runs[-1].get("run_id") or "")
    return {
        "thread_id": thread_id,
        "runs": runs,
        "summaries": trace_repo.list_step_summaries(thread_id, limit=summary_limit),
        "latest_events": trace_repo.list_run_events(latest_run_id, limit=event_limit) if latest_run_id else [],
        "latest_llm_calls": trace_repo.list_llm_calls(latest_run_id, limit=llm_limit) if latest_run_id else [],
    }
