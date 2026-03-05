from typing import Optional, Union

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from llm_agent.prompts import load_router_system_prompt
from schemas import RouterOutput, TaskRouterOutput

LLM_BASE_URL = "http://127.0.0.1:8000/v1"
LLM_MODEL = "qwen3.5-2b"
LLM_API_KEY = "EMPTY"


def invoke_task_router(user_input: str) -> Optional[Union[RouterOutput, TaskRouterOutput]]:
    """调用 LLM 执行意图路由。"""
    prompt_template = ChatPromptTemplate.from_messages(
        [
            ("system", load_router_system_prompt()),
            ("human", "{input}"),
        ]
    )

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
        return RouterOutput(intent="task", action=result.action, target=result.target, reply_text=None)
    return result
