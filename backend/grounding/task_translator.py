from typing import Any, Dict


def translate_task_step(*, action: str, target: str) -> Dict[str, Any]:
    """语义翻译官：将 LLM 产出的模糊目标（如：主人前方）映射为精确的执行参数。"""
    normalized_action = (action or "").strip().lower()
    normalized_target = (target or "").strip()

    if normalized_action == "speak":
        return {"command": "chat", "message": normalized_target}

    if normalized_action == "move_to":
        if normalized_target == "master_front":
            return {
                "command": "navigate_relative",
                "entity": "master",
                "offset_type": "front",
                "distance": 2.0,
            }
        if normalized_target == "master_side":
            return {
                "command": "navigate_relative",
                "entity": "master",
                "offset_type": "side",
                "distance": 1.5,
            }
        return {"command": "unsupported", "action": normalized_action, "target": normalized_target}

    if normalized_action == "mine":
        return {"command": "mine_cluster", "resource": normalized_target}

    if normalized_action in {"pick_up", "craft", "place"}:
        return {"command": "unsupported", "action": normalized_action, "target": normalized_target}

    return {"command": "unsupported", "action": normalized_action, "target": normalized_target}

