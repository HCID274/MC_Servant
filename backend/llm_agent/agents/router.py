import hashlib
import time
from typing import Optional, Union

from langchain_core.messages import HumanMessage, SystemMessage

from llm_agent.client_factory import build_router_client, get_llm_runtime_config
from llm_agent.prompts import get_router_agent_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import RouterOutput
from tracing.store import TraceStore

def _build_router_system_prompt() -> str:
    """装载 Router 系统提示词。"""
    return get_router_agent_prompt()


def _build_router_messages(user_input: str) -> tuple[str, list[SystemMessage | HumanMessage]]:
    """构造供 LLM 消费的标准消息序列。"""
    system_prompt = _build_router_system_prompt()
    return system_prompt, [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_input),
    ]


def _record_router_call(
    *,
    trace_repo: Optional[TraceStore],
    trace_ctx: Optional[dict[str, str]],
    request_messages: list[SystemMessage | HumanMessage],
    rendered_prompt_text: str,
    raw_response_text: Optional[str],
    parsed_output: Optional[dict],
    parse_error: Optional[str],
    latency_ms: int,
    usage: Optional[dict] = None,
) -> None:
    """持久化 LLM 调用轨迹，记录意图识别的原始上下文。"""
    if trace_repo is None or not trace_ctx:
        return

    runtime = get_llm_runtime_config()
    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="router_agent",
        call_seq=1,
        prompt_name="intent_router_agent.md",
        provider=runtime.provider,
        model_name=runtime.model_name,
        base_url=runtime.base_url,
        request_messages=[
            {"type": message.type, "content": stringify_message_content(message.content)}
            for message in request_messages
        ],
        rendered_prompt_text=rendered_prompt_text,
        prompt_sha256=hashlib.sha256(rendered_prompt_text.encode("utf-8")).hexdigest(),
        raw_response_text=raw_response_text,
        parsed_output=parsed_output,
        parse_ok=parse_error is None and parsed_output is not None,
        parse_error=parse_error,
        usage=usage,
        latency_ms=latency_ms,
    )


def invoke_task_router(
    user_input: str,
    *,
    trace_repo: Optional[TraceStore] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[RouterOutput]:
    """执行意图决策逻辑，输出当前主意图与即时回复。"""
    rendered_prompt_text, request_messages = _build_router_messages(user_input)

    llm = build_router_client()

    started_at = time.perf_counter()
    raw_response_text: Optional[str] = None
    try:
        response = llm.invoke(request_messages)
        raw_response_text = stringify_message_content(getattr(response, "content", ""))
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            usage = getattr(response, "response_metadata", {}).get("token_usage")
        parsed_model, parsed_payload, _ = parse_model_output(RouterOutput, raw_response_text)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_router_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            request_messages=request_messages,
            rendered_prompt_text=rendered_prompt_text,
            raw_response_text=raw_response_text,
            parsed_output=parsed_payload,
            parse_error=None,
            latency_ms=latency_ms,
            usage=usage,
        )
        return parsed_model
    except Exception as e:
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_router_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            request_messages=request_messages,
            rendered_prompt_text=rendered_prompt_text,
            raw_response_text=raw_response_text,
            parsed_output=None,
            parse_error=str(e),
            latency_ms=latency_ms,
            usage=None,
        )
        print(f"[-] LLM 解析失败: {e}")
        return None


def route_user_input(user_input: str) -> RouterOutput:
    """对外暴露的意图分流接口，返回结构化意图识别结果。"""
    result = invoke_task_router(user_input)
    if result is None:
        raise RuntimeError("Router invoke failed")
    return result
