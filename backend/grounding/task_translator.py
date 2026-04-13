from typing import Any, Dict

from domain_registry import get_domain_registry

def _normalize_name(value: Any) -> str:
    return str(value or "").strip().lower()


def translate_task_step(*, action: str, target: str, count: int | None = None) -> Dict[str, Any]:
    """语义翻译官：将 LLM 产出的模糊目标（如：主人前方）映射为精确的执行参数。"""
    normalized_action = (action or "").strip().lower()
    normalized_target = (target or "").strip()
    normalized_count = max(int(count or 1), 1)

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
        return {
            "command": "mine_cluster",
            "resource": normalized_target,
            "count": normalized_count,
            "resource_profile": get_domain_registry().resource_profile_name(normalized_target),
            "selection_policy": "cluster_runtime_selection",
        }

    if normalized_action == "pick_up":
        return {"command": "collect_drop", "item": normalized_target, "count": normalized_count}

    if normalized_action == "craft":
        return {"command": "craft_item", "item": normalized_target, "count": normalized_count}

    if normalized_action == "drop":
        return {"command": "drop_item", "item": normalized_target, "count": normalized_count}

    if normalized_action == "place":
        return {"command": "place_block", "block": normalized_target}

    return {"command": "unsupported", "action": normalized_action, "target": normalized_target}
