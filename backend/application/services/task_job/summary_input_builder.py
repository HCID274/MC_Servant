from typing import Any

from grounding.snapshot_builder import normalize_env_snapshot


def _tokens(text: str) -> list[str]:
    """将文本拆分为标准化的词元序列。"""
    parts = [token.strip().lower() for token in text.replace("-", "_").split("_")]
    return [token for token in parts if token]


def _is_relevant(name: str, target: str) -> bool:
    """基于词元匹配判断两个名称是否具有语义相关性。"""
    if not name or not target:
        return False
    lowered_name = name.lower()
    lowered_target = target.lower()
    if lowered_name in lowered_target or lowered_target in lowered_name:
        return True
    target_tokens = _tokens(lowered_target)
    name_tokens = _tokens(lowered_name)
    return any(token in lowered_name for token in target_tokens) or any(token in lowered_target for token in name_tokens)


def _prune_inventory(inventory: Any, *, target: str, limit: int = 8) -> list[dict[str, Any]]:
    """裁剪背包数据，优先保留与当前任务目标相关的物品。"""
    if not isinstance(inventory, dict):
        return []
    ranked: list[tuple[int, int, str, int]] = []
    for name, count in inventory.items():
        item_name = str(name or "").strip()
        try:
            item_count = int(count or 0)
        except Exception:
            item_count = 0
        if not item_name or item_count <= 0:
            continue
        relevance = 0 if _is_relevant(item_name, target) else 1
        ranked.append((relevance, -item_count, item_name, item_count))
    ranked.sort()
    return [{"name": item_name, "count": item_count} for _, _, item_name, item_count in ranked[:limit]]


def _prune_nearby_blocks(nearby_blocks: Any, *, target: str, limit: int = 6) -> list[dict[str, Any]]:
    """筛选周围方块摘要，优先保留与目标相关且数量较多的资源。"""
    if not isinstance(nearby_blocks, list):
        return []
    ranked: list[tuple[int, int, str, dict[str, Any]]] = []
    for entry in nearby_blocks:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        try:
            count = int(entry.get("count", 0) or 0)
        except Exception:
            count = 0
        try:
            cluster_count = int(entry.get("cluster_count", 0) or 0)
        except Exception:
            cluster_count = 0
        relevance = 0 if _is_relevant(name, target) else 1
        ranked.append((relevance, -count, name, {
            "name": name,
            "count": count,
            "cluster_count": max(cluster_count, 0),
        }))
    ranked.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in ranked[:limit]]


def _recent_summary_lines(recent_summaries: list[dict[str, Any]], *, limit: int = 3) -> list[str]:
    """格式化最近的步骤执行摘要，用于注入长时记忆。"""
    lines: list[str] = []
    for item in recent_summaries[-limit:]:
        if not isinstance(item, dict):
            continue
        summary_id = str(item.get("summary_id") or "").strip()
        summary_text = str(item.get("summary_text") or "").strip()
        if not summary_text:
            continue
        lines.append(f"{summary_id}: {summary_text}" if summary_id else summary_text)
    return lines


def build_step_summary_input(
    *,
    job: dict[str, Any],
    step_index: int,
    total_steps: int,
    step: dict[str, Any],
    kind: str,
    attempt: int,
    result_payload: dict[str, Any],
    env_snapshot: dict[str, Any],
    recent_summaries: list[dict[str, Any]],
) -> dict[str, Any]:
    """摘要数据预处理器：压缩原始执行数据，仅保留规划强相关的上下文。"""
    env_snapshot = normalize_env_snapshot(env_snapshot)
    action = str(step.get("action") or "").strip()
    target = str(step.get("target") or "").strip()
    reason = str(step.get("reason") or "").strip()
    inventory = env_snapshot.get("inventory") or {}
    nearby_blocks = env_snapshot.get("nearby_blocks") or []

    return {
        "task_context": {
            "original_user_input": str(job.get("original_user_input") or "").strip(),
            "opening_reply_text": str(job.get("opening_reply_text") or "").strip(),
            "recent_step_summaries": _recent_summary_lines(recent_summaries),
        },
        "step_meta": {
            "step_index": step_index,
            "total_steps": total_steps,
            "action": action,
            "target": target,
            "reason": reason,
            "kind": kind,
            "attempt": attempt,
        },
        "outcome": {
            "message": str(result_payload.get("message") or "").strip(),
            "status": str(result_payload.get("status") or "").strip(),
            "error_code": result_payload.get("error_code"),
            "failure_class": result_payload.get("failure_class"),
            "failure_reason": result_payload.get("failure_reason"),
        },
        "world_state": {
            "bot_pos": env_snapshot.get("bot_pos") or {},
            "player_pos": env_snapshot.get("player_pos") or {},
            "health": env_snapshot.get("health"),
            "food": env_snapshot.get("food"),
            "equipped": env_snapshot.get("equipped"),
            "inventory_focus": _prune_inventory(inventory, target=target),
            "nearby_blocks_focus": _prune_nearby_blocks(nearby_blocks, target=target),
        },
    }
