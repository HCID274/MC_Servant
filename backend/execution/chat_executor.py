import logging
from dataclasses import dataclass, field
from typing import Any


logger = logging.getLogger(__name__)


@dataclass
class ChatExecutionOutcome:
    """聊天执行结果：记录轻互动步骤执行情况与最终实际播报文本。"""

    success: bool
    spoken_text: str = ""
    executed_steps: list[dict[str, Any]] = field(default_factory=list)
    failed_steps: list[dict[str, Any]] = field(default_factory=list)


async def _execute_move_to(bot: object, target: str) -> bool:
    navigate_relative = getattr(bot, "navigate_relative", None)
    if not callable(navigate_relative):
        return False
    if target == "master_side":
        return await navigate_relative("master", "side", 1.5)
    if target in {"master_front", "master"}:
        return await navigate_relative("master", "front", 2.0)
    if target == "self_feet":
        return True
    return False


async def _execute_look_at(bot: object, target: str) -> bool:
    if target in {"master_eyes", "master"}:
        look_at_eyes = getattr(bot, "look_at_eyes", None)
        if callable(look_at_eyes):
            return await look_at_eyes("master")
    look_at = getattr(bot, "look_at", None)
    if callable(look_at):
        return await look_at(target)
    return False


async def _execute_animate(bot: object, target: str) -> bool:
    animate = getattr(bot, "animate", None)
    if callable(animate):
        return await animate(target)

    if target == "jump":
        jump = getattr(bot, "jump", None)
        if callable(jump):
            return await jump()
    if target == "spin":
        spin = getattr(bot, "spin", None)
        if callable(spin):
            return await spin(1, 0.8)
    return False


async def _execute_chat_step(bot: object, action: str, target: str) -> bool:
    if action == "move_to":
        return await _execute_move_to(bot, target)
    if action == "look_at":
        return await _execute_look_at(bot, target)
    if action == "animate":
        return await _execute_animate(bot, target)
    return False


async def execute_chat_plan(
    bot: object,
    plan: list[dict[str, Any]],
    *,
    fallback_reply_text: str = "",
) -> ChatExecutionOutcome:
    """执行 Chat Planner 产出的轻互动步骤，失败时退化为纯文本回复。"""
    executed_steps: list[dict[str, Any]] = []
    failed_steps: list[dict[str, Any]] = []
    spoken_text = ""

    for index, step in enumerate(plan, start=1):
        if not isinstance(step, dict):
            failed_steps.append(
                {"index": index, "action": "<invalid>", "target": "", "message": "step is not a dict"}
            )
            continue

        action = str(step.get("action") or "").strip().lower()
        target = str(step.get("target") or "").strip()
        if not action or not target:
            failed_steps.append(
                {"index": index, "action": action or "<missing>", "target": target, "message": "missing action or target"}
            )
            continue

        if action == "speak":
            spoken_text = target
            executed_steps.append({"index": index, "action": action, "target": target, "success": True})
            continue

        ok = await _execute_chat_step(bot, action, target)
        record = {"index": index, "action": action, "target": target, "success": ok}
        if ok:
            executed_steps.append(record)
            if action == "speak":
                spoken_text = target
        else:
            failed_steps.append({**record, "message": "execution failed"})
            logger.warning("Chat step failed: index=%s action=%s target=%s", index, action, target)

    if not spoken_text and fallback_reply_text:
        spoken_text = fallback_reply_text
        executed_steps.append(
            {
                "index": len(plan) + 1,
                "action": "speak",
                "target": fallback_reply_text,
                "success": True,
                "fallback": True,
            }
        )

    return ChatExecutionOutcome(
        success=bool(spoken_text) and not any(step.get("action") == "speak" and not step.get("success") for step in failed_steps),
        spoken_text=spoken_text,
        executed_steps=executed_steps,
        failed_steps=failed_steps,
    )
