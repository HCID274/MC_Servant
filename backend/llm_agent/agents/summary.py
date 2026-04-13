import hashlib
import json
import time
from typing import Any, Optional

from langchain_core.messages import SystemMessage

from llm_agent.client_factory import build_step_summary_client, get_llm_runtime_config
from llm_agent.prompts import get_step_summary_agent_prompt
from llm_agent.structured_output import parse_model_output, stringify_message_content
from schemas import StepSummaryAgentOutput
from tracing.store import TraceStore


def _to_json_text(value: Any) -> str:
    """将数据对象序列化为标准 JSON 字符串以适配提示词。"""
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)


def _render_step_summary_prompt(summary_input: dict[str, Any]) -> str:
    """渲染包含执行上下文的步骤总结提示词模板。"""
    prompt = get_step_summary_agent_prompt()
    return prompt.replace("{summary_input_json}", _to_json_text(summary_input))


def _record_summary_agent_call(
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
    """记录步骤总结过程中的模型交互细节与解析状态。"""
    if trace_repo is None or not trace_ctx:
        return

    runtime = get_llm_runtime_config()
    trace_repo.record_llm_call(
        run_id=trace_ctx.get("run_id", ""),
        thread_id=trace_ctx.get("thread_id", ""),
        node_name="step_summary_agent",
        call_seq=1,
        prompt_name="node_step_summary_agent.md",
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


def invoke_step_summary_agent(
    *,
    summary_input: dict[str, Any],
    trace_repo: Optional[TraceStore] = None,
    trace_ctx: Optional[dict[str, str]] = None,
) -> Optional[StepSummaryAgentOutput]:
    """步骤总结 Agent：提炼单步执行的核心成果，实现长时记忆压缩。"""
    rendered_prompt = _render_step_summary_prompt(summary_input)
    request_messages = [SystemMessage(content=rendered_prompt)]
    llm = build_step_summary_client()

    started_at = time.perf_counter()
    raw_response_text: Optional[str] = None
    try:
        response = llm.invoke(request_messages)
        raw_response_text = stringify_message_content(getattr(response, "content", ""))
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            usage = getattr(response, "response_metadata", {}).get("token_usage")
        parsed_model, parsed_payload, _ = parse_model_output(StepSummaryAgentOutput, raw_response_text)
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        _record_summary_agent_call(
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
        _record_summary_agent_call(
            trace_repo=trace_repo,
            trace_ctx=trace_ctx,
            rendered_prompt=rendered_prompt,
            raw_response_text=raw_response_text,
            parsed_output=None,
            parse_error=str(exc),
            latency_ms=latency_ms,
            usage=None,
        )
        print(f"[-] Step Summary Agent 解析失败: {exc}")
        return None
