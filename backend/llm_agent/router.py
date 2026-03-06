from typing import Optional, Union

from langchain_core.messages import SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from llm_agent.prompts import get_knowledge_index_prompt, load_router_system_prompt
from schemas import RouterOutput, TaskRouterOutput

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


def _build_router_prompt_template() -> ChatPromptTemplate:
    """
    构建 Router 提示词模板。

    注意：系统提示词中包含 JSON 花括号，必须按“纯文本消息”注入，
    避免被 ChatPromptTemplate 误判为模板变量。
    """
    return ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=_build_router_system_prompt()),
            ("human", "{input}"),
        ]
    )


def invoke_task_router(user_input: str) -> Optional[Union[RouterOutput, TaskRouterOutput]]:
    """调用 LLM 执行意图路由。"""
    prompt_template = _build_router_prompt_template()

    llm = ChatOpenAI(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0.4,
        max_retries=1,
    )

    structured_llm = llm.with_structured_output(RouterOutput)
    chain = prompt_template | structured_llm

    try:
        return chain.invoke({"input": user_input})
    except Exception as e:
        print(f"[-] LLM 解析失败: {e}")
        return None


def route_user_input(user_input: str) -> RouterOutput:
    """兼容入口：返回 RouterOutput。"""
    result = invoke_task_router(user_input)
    if result is None:
        raise RuntimeError("Router invoke failed")
    if isinstance(result, TaskRouterOutput):
        return RouterOutput(
            intent="task",
            action=result.action,
            target=result.target,
            required_knowledge=result.required_knowledge,
            reply_text=None,
        )
    return result
