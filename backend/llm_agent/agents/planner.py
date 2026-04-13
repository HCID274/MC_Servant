import json
import hashlib
import time
from typing import Any, Optional

from langchain_core.messages import SystemMessage

from llm_agent.client_factory import build_task_planner_client, get_llm_runtime_config
from llm_agent.prompts import get_task_planner_agent_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import TaskPlannerOutput
from tracing.store import TraceStore


def _to_json_text(value: Any) -> str:
    """将环境数据对象序列化为 JSON 字符串。"""
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _render_task_planner_prompt(
    *,
    goal: str,
    context: str,
    env_snapshot: Any,
    tool_context: Any,
    bot_name: str,
    master_name: str,
) -> str:
    """将多维物理环境状态注入任务规划提示词模板。"""
    prompt = get_task_planner_agent_prompt()
    replacements = {
        "goal": goal,
        "context": context,
        "env_snapshot": _to_json_text(env_snapshot),
        "tool_context": _to_json_text(tool_context),
        "bot_name": bot_name,
        "master_name": master_name,
    }
    for key, value in replacements.items():
        prompt = prompt.replace(f"{{{key}}}", value)
    return prompt


def _record_planner_call(
    *,
    trace_repo: Optional[TraceStore],
    trace_ctx: Optional[dict[str, str]],
    rendered_prompt: str,
    raw_response_text: Optional[str],
    parsed_output: Optional[dict[str, Any]],
    parse_error: Optional[str],
    latency_ms: int,
    usage: Optional[dict[str, Any]] = None,
) -> None:
    """全量审计任务规划的思考链路、上下文环境及模型响应。"""
    if trace_repo is None or not trace_ctx:
        return

    runtime = get_llm_runtime_config()
    request_messages = [{"type": "system", "content": rendered_prompt}]
    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="task_planner_agent",
        call_seq=1,
        prompt_name="node_task_planner_agent.md",
        provider=runtime.provider,
        model_name=runtime.model_name,
        base_url=runtime.base_url,
        request_messages=request_messages,
        rendered_prompt_text=rendered_prompt,
        prompt_sha256=hashlib.sha256(rendered_prompt.encode("utf-8")).hexdigest(),
        raw_response_text=raw_response_text,
        parsed_output=parsed_output,
        parse_ok=parse_error is None and parsed_output is not None,
        parse_error=parse_error,
        usage=usage,
        latency_ms=latency_ms,
    )


def invoke_task_planner(
    *,
    goal: str,
    context: str,
    env_snapshot: Any = None,
    tool_context: Any = None,
    bot_name: str = "Maid",
    master_name: str = "Master",
    trace_repo: Optional[TraceStore] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[TaskPlannerOutput]:
    """任务规划 Agent：将宏观目标拆解为可操作的微观指令序列。"""
    rendered_prompt = _render_task_planner_prompt(
        goal=goal,
        context=context,
        env_snapshot=env_snapshot,
        tool_context=tool_context,
        bot_name=bot_name,
        master_name=master_name,
    )

    llm = build_task_planner_client()

    request_messages = [SystemMessage(content=rendered_prompt)]
    started_at = time.perf_counter()
    raw_response_text: Optional[str] = None
    try:
        response = llm.invoke(request_messages)
        raw_response_text = stringify_message_content(getattr(response, "content", ""))
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            usage = getattr(response, "response_metadata", {}).get("token_usage")
        parsed_model, parsed_payload, _ = parse_model_output(TaskPlannerOutput, raw_response_text)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_planner_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            rendered_prompt=rendered_prompt,
            raw_response_text=raw_response_text,
            parsed_output=parsed_payload,
            parse_error=None,
            latency_ms=latency_ms,
            usage=usage,
        )
        return parsed_model
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_planner_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            rendered_prompt=rendered_prompt,
            raw_response_text=raw_response_text,
            parsed_output=None,
            parse_error=str(exc),
            latency_ms=latency_ms,
            usage=None,
        )
        print(f"[-] Task Planner 解析失败: {exc}")
        return None
