from dataclasses import dataclass, field
from typing import Any

from google import genai
from google.genai import types
from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI

from config import settings
from llm_agent.structured_output import stringify_message_content


@dataclass(frozen=True)
class LlmRuntimeConfig:
    """统一的 LLM 运行配置快照，供 Agent 和 Trace 共同读取。"""

    provider: str
    model_name: str
    base_url: str
    api_key: str
    max_retries: int


@dataclass(frozen=True)
class LlmInvokeResult:
    """统一的模型返回格式，屏蔽 OpenAI 与 Gemini SDK 差异。"""

    content: str
    usage_metadata: dict[str, Any] | None = None
    response_metadata: dict[str, Any] = field(default_factory=dict)


class UnifiedChatClient:
    """统一的聊天模型客户端，按 provider 分发到底层 SDK。"""

    def __init__(self, *, temperature: float):
        self._temperature = temperature

    def invoke(self, messages: list[BaseMessage]) -> LlmInvokeResult:
        runtime = get_llm_runtime_config()
        if runtime.provider == "gemini":
            return _invoke_gemini(messages=messages, runtime=runtime, temperature=self._temperature)
        return _invoke_openai(messages=messages, runtime=runtime, temperature=self._temperature)


def get_llm_runtime_config() -> LlmRuntimeConfig:
    """读取全局配置，返回当前启用的模型连接参数。"""
    provider = str(settings.llm_provider or "openai").strip().lower()
    if provider == "gemini":
        return LlmRuntimeConfig(
            provider="gemini",
            model_name=settings.gemini_model,
            base_url="",
            api_key=settings.gemini_api_key,
            max_retries=settings.llm_max_retries,
        )
    if provider != "openai":
        raise ValueError(f"Unsupported llm_provider: {settings.llm_provider}")
    return LlmRuntimeConfig(
        provider="openai",
        model_name=settings.llm_model,
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        max_retries=settings.llm_max_retries,
    )


def _invoke_openai(
    *,
    messages: list[BaseMessage],
    runtime: LlmRuntimeConfig,
    temperature: float,
) -> LlmInvokeResult:
    """调用 OpenAI 兼容接口。"""
    llm = ChatOpenAI(
        model=runtime.model_name,
        api_key=runtime.api_key,
        base_url=runtime.base_url,
        temperature=temperature,
        max_retries=runtime.max_retries,
    )
    response = llm.invoke(messages)
    usage = getattr(response, "usage_metadata", None)
    response_metadata = getattr(response, "response_metadata", {}) or {}
    if usage is None:
        usage = response_metadata.get("token_usage")
    return LlmInvokeResult(
        content=stringify_message_content(getattr(response, "content", "")),
        usage_metadata=usage,
        response_metadata=response_metadata,
    )


def _build_gemini_payload(messages: list[BaseMessage]) -> tuple[str, str | None]:
    """将 LangChain 消息压平成 Gemini SDK 可消费的文本输入。"""
    system_parts: list[str] = []
    content_parts: list[str] = []
    for message in messages:
        text = stringify_message_content(getattr(message, "content", ""))
        if not text:
            continue
        message_type = str(getattr(message, "type", "") or "").lower()
        if message_type == "system":
            system_parts.append(text)
            continue
        if message_type in {"human", "user"}:
            content_parts.append(text)
            continue
        if message_type in {"ai", "assistant"}:
            content_parts.append(f"[assistant]\n{text}")
            continue
        content_parts.append(f"[{message_type or 'user'}]\n{text}")

    system_instruction = "\n\n".join(system_parts).strip() or None
    contents = "\n\n".join(content_parts).strip()
    if contents:
        return contents, system_instruction
    return (system_instruction or ""), None


def _dump_usage(value: Any) -> dict[str, Any] | None:
    """兼容不同 SDK 对 usage 对象的序列化方式。"""
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if isinstance(value, dict):
        return value
    return {"raw": str(value)}


def _invoke_gemini(
    *,
    messages: list[BaseMessage],
    runtime: LlmRuntimeConfig,
    temperature: float,
) -> LlmInvokeResult:
    """调用 Gemini 官方 SDK。"""
    contents, system_instruction = _build_gemini_payload(messages)
    client = genai.Client(api_key=runtime.api_key or None)
    config = types.GenerateContentConfig(
        temperature=temperature,
        system_instruction=system_instruction,
        thinkingConfig=types.ThinkingConfig(thinkingBudget=0),
    )
    response = client.models.generate_content(
        model=runtime.model_name,
        contents=contents,
        config=config,
    )
    usage = _dump_usage(getattr(response, "usage_metadata", None))
    return LlmInvokeResult(
        content=stringify_message_content(getattr(response, "text", "") or ""),
        usage_metadata=usage,
        response_metadata={"token_usage": usage} if usage else {},
    )


def build_chat_client(*, temperature: float) -> UnifiedChatClient:
    """统一构造当前 provider 对应的聊天模型客户端。"""
    return UnifiedChatClient(temperature=temperature)


def build_router_client() -> UnifiedChatClient:
    """构造 Router Agent 使用的模型客户端。"""
    return build_chat_client(temperature=settings.llm_temperature_router)


def build_chat_planner_client() -> UnifiedChatClient:
    """构造 Chat Planner Agent 使用的模型客户端。"""
    return build_chat_client(temperature=settings.llm_temperature_planner)


def build_task_planner_client() -> UnifiedChatClient:
    """构造 Task Planner Agent 使用的模型客户端。"""
    return build_chat_client(temperature=settings.llm_temperature_planner)


def build_step_summary_client() -> UnifiedChatClient:
    """构造 Summary Agent 使用的模型客户端。"""
    return build_chat_client(temperature=settings.llm_temperature_summary)
