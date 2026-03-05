from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grounding.translator import translate_chat_step
from llm_agent.router import _build_router_prompt_template


def test_router_prompt_template_only_requires_input_variable() -> None:
    template = _build_router_prompt_template()
    assert template.input_variables == ["input"]


def test_translate_chat_step_maps_master_eyes_to_existing_command() -> None:
    translated = translate_chat_step({"action": "look_at", "target": "master_eyes"})
    assert translated["command"] == "look_at_eyes"
