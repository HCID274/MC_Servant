import hashlib
import time
from typing import Optional, Union

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from llm_agent.prompts import get_knowledge_index_prompt, load_router_system_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import RouterOutput
from tracing.repository import TraceRepository

LLM_BASE_URL = "http://127.0.0.1:8000/v1"
LLM_MODEL = "qwen3.5-2b"
LLM_API_KEY = "EMPTY"
KNOWLEDGE_INDEX_PLACEHOLDER = "__KNOWLEDGE_INDEX__"


def _build_router_system_prompt() -> str:
    base_prompt = load_router_system_prompt()
    index_text = get_knowledge_index_prompt()
    if KNOWLEDGE_INDEX_PLACEHOLDER in base_prompt:
        return base_prompt.replace(KNOWLEDGE_INDEX_PLACEHOLDER, index_text)
    return f"{base_prompt}\n\n# 可用知识库索引\n{index_text}"


def _build_router_messages(user_input: str) -> tuple[str, list[SystemMessage | HumanMessage]]:
    system_prompt = _build_router_system_prompt()
    return system_prompt, [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_input),
    ]


def _record_router_call(
    *,
    trace_repo: Optional[TraceRepository],
    trace_ctx: Optional[dict[str, str]],
    request_messages: list[SystemMessage | HumanMessage],
    rendered_prompt_text: str,
    raw_response_text: Optional[str],
    parsed_output: Optional[dict],
    parse_error: Optional[str],
    latency_ms: int,
    usage: Optional[dict] = None,
) -> None:
    if trace_repo is None or not trace_ctx:
        return

    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="router",
        call_seq=1,
        prompt_name="intent_router.md",
        model_name=LLM_MODEL,
        base_url=LLM_BASE_URL,
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
    trace_repo: Optional[TraceRepository] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[RouterOutput]:
    """意图决策：调用 LLM 识别主人的核心意图是闲聊还是任务。"""
    rendered_prompt_text, request_messages = _build_router_messages(user_input)

    llm = ChatOpenAI(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0.4,
        max_retries=1,
    )

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
    """兼容入口：返回 RouterOutput。"""
    result = invoke_task_router(user_input)
    if result is None:
        raise RuntimeError("Router invoke failed")
    return result
