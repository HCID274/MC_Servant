import hashlib
import json
import time
from typing import Any, Optional

from langchain_core.messages import SystemMessage

from llm_agent.client_factory import build_chat_planner_client, get_llm_runtime_config
from llm_agent.prompts import get_chat_planner_agent_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import ChatPlannerOutput
from tracing.store import TraceStore


def _to_json_text(value: Any) -> str:
    """将环境对象序列化为 JSON 字符串。"""
    return json.dumps(value if value is not None else {}, ensure_ascii=False)


def _render_chat_planner_prompt(
    *,
    goal: str,
    context: str,
    env_snapshot: Any,
    bot_name: str,
    master_name: str,
) -> str:
    """将聊天目标与标准环境快照注入 Chat Planner 提示词模板。"""
    prompt = get_chat_planner_agent_prompt()
    replacements = {
        "goal": goal,
        "context": context,
        "env_snapshot": _to_json_text(env_snapshot),
        "bot_name": bot_name,
        "master_name": master_name,
    }
    for key, value in replacements.items():
        prompt = prompt.replace(f"{{{key}}}", value)
    return prompt


def _record_chat_planner_call(
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
    """持久化 Chat Planner 的提示词、模型原文与结构化结果。"""
    if trace_repo is None or not trace_ctx:
        return

    runtime = get_llm_runtime_config()
    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="chat_planner_agent",
        call_seq=1,
        prompt_name="node_chat_planner_agent.md",
        provider=runtime.provider,
        model_name=runtime.model_name,
        base_url=runtime.base_url,
        request_messages=[{"type": "system", "content": rendered_prompt}],
        rendered_prompt_text=rendered_prompt,
        prompt_sha256=hashlib.sha256(rendered_prompt.encode("utf-8")).hexdigest(),
        raw_response_text=raw_response_text,
        parsed_output=parsed_output,
        parse_ok=parse_error is None and parsed_output is not None,
        parse_error=parse_error,
        usage=usage,
        latency_ms=latency_ms,
    )


def invoke_chat_planner(
    *,
    goal: str,
    context: str,
    env_snapshot: Any = None,
    bot_name: str = "Maid",
    master_name: str = "Master",
    trace_repo: Optional[TraceStore] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[ChatPlannerOutput]:
    """聊天规划 Agent：生成 grounded 回复与轻互动动作序列。"""
    rendered_prompt = _render_chat_planner_prompt(
        goal=goal,
        context=context,
        env_snapshot=env_snapshot,
        bot_name=bot_name,
        master_name=master_name,
    )

    llm = build_chat_planner_client()
    request_messages = [SystemMessage(content=rendered_prompt)]
    started_at = time.perf_counter()
    raw_response_text: Optional[str] = None
    try:
        response = llm.invoke(request_messages)
        raw_response_text = stringify_message_content(getattr(response, "content", ""))
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            usage = getattr(response, "response_metadata", {}).get("token_usage")
        parsed_model, parsed_payload, _ = parse_model_output(ChatPlannerOutput, raw_response_text)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_chat_planner_call(
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
        _record_chat_planner_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            rendered_prompt=rendered_prompt,
            raw_response_text=raw_response_text,
            parsed_output=None,
            parse_error=str(exc),
            latency_ms=latency_ms,
            usage=None,
        )
        print(f"[-] Chat Planner 解析失败: {exc}")
        return None
