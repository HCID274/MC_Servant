import json
import hashlib
import time
from typing import Any, Optional

from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI

from llm_agent.prompts import get_task_planner_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import TaskPlannerOutput
from tracing.repository import TraceRepository

LLM_BASE_URL = "http://127.0.0.1:8000/v1"
LLM_MODEL = "qwen3.5-2b"
LLM_API_KEY = "EMPTY"


def _to_json_text(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _render_task_planner_prompt(
    *,
    context: str,
    active_knowledge: str,
    inventory: Any,
    nearby_blocks: Any,
    bot_pos: Any,
    player_pos: Any,
    bot_name: str,
    master_name: str,
) -> str:
    prompt = get_task_planner_prompt()
    replacements = {
        "context": context,
        "active_knowledge": active_knowledge or "",
        "inventory": _to_json_text(inventory),
        "nearby_blocks": _to_json_text(nearby_blocks),
        "bot_pos": _to_json_text(bot_pos),
        "player_pos": _to_json_text(player_pos),
        "bot_name": bot_name,
        "master_name": master_name,
    }
    for key, value in replacements.items():
        prompt = prompt.replace(f"{{{key}}}", value)
    return prompt


def _record_planner_call(
    *,
    trace_repo: Optional[TraceRepository],
    trace_ctx: Optional[dict[str, str]],
    rendered_prompt: str,
    raw_response_text: Optional[str],
    parsed_output: Optional[dict[str, Any]],
    parse_error: Optional[str],
    latency_ms: int,
    usage: Optional[dict[str, Any]] = None,
) -> None:
    if trace_repo is None or not trace_ctx:
        return

    request_messages = [{"type": "system", "content": rendered_prompt}]
    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="task_planner",
        call_seq=1,
        prompt_name="node_task_planner.md",
        model_name=LLM_MODEL,
        base_url=LLM_BASE_URL,
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
    context: str,
    active_knowledge: str = "",
    inventory: Any = None,
    nearby_blocks: Any = None,
    bot_pos: Any = None,
    player_pos: Any = None,
    bot_name: str = "Maid",
    master_name: str = "Master",
    trace_repo: Optional[TraceRepository] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[TaskPlannerOutput]:
    """任务规划：将复杂指令拆解为一系列可在游戏中执行的原子动作。"""
    rendered_prompt = _render_task_planner_prompt(
        context=context,
        active_knowledge=active_knowledge,
        inventory=inventory,
        nearby_blocks=nearby_blocks,
        bot_pos=bot_pos,
        player_pos=player_pos,
        bot_name=bot_name,
        master_name=master_name,
    )

    llm = ChatOpenAI(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0.3,
        max_retries=1,
    )

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
