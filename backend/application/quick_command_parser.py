from typing import Any, Dict, Optional


def parse_quick_command(content: str) -> Optional[Dict[str, Any]]:
    """快捷指令解析：将高频短指令转成统一的执行步骤。"""
    normalized = (content or "").strip()
    lowered = normalized.lower()

    if lowered in {"hello", "hi", "你好", "你好呀"}:
        return {
            "source": "quick",
            "response_action": "greeting",
            "hologram_text": "💖",
            "steps": [{"action": "greet", "target": ""}],
        }

    if lowered in {"status", "where", "你在哪", "位置"}:
        return {
            "source": "quick",
            "response_action": "status",
            "hologram_text": "📍",
            "steps": [{"action": "status", "target": ""}],
        }

    if lowered in {"jump", "跳", "跳一下"}:
        return {
            "source": "quick",
            "response_action": "jump",
            "hologram_text": "🦘",
            "steps": [{"action": "jump", "target": ""}],
        }

    if lowered.startswith("say ") and len(normalized) > 4:
        to_say = normalized[4:].strip()
        if not to_say:
            return None
        return {
            "source": "quick",
            "response_action": "chat",
            "hologram_text": "💬",
            "steps": [{"action": "say", "target": to_say}],
        }

    if lowered.startswith("look ") and len(normalized) > 5:
        look_target = normalized[5:].strip()
        if not look_target:
            return None
        return {
            "source": "quick",
            "response_action": "look_at",
            "hologram_text": "👀",
            "steps": [{"action": "look", "target": look_target}],
        }

    return None
