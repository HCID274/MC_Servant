from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grounding.translator import translate_chat_step
from llm_agent.agents.router import _build_router_messages


def test_router_prompt_template_only_requires_input_variable() -> None:
    rendered_prompt, messages = _build_router_messages("你好")
    assert rendered_prompt
    assert len(messages) == 2


def test_translate_chat_step_maps_master_eyes_to_existing_command() -> None:
    translated = translate_chat_step({"action": "look_at", "target": "master_eyes"})
    assert translated["command"] == "look_at_eyes"
