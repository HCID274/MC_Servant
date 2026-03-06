import json
from typing import Any, Optional

from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI

from llm_agent.prompts import get_task_planner_prompt
from schemas import TaskPlannerOutput

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
) -> Optional[TaskPlannerOutput]:
    """调用 LLM 执行任务拆解。"""
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

    structured_llm = llm.with_structured_output(TaskPlannerOutput)
    try:
        return structured_llm.invoke([SystemMessage(content=rendered_prompt)])
    except Exception as exc:
        print(f"[-] Task Planner 解析失败: {exc}")
        return None
