import re
from pathlib import Path
from typing import Iterable, List

from schemas import MaidState

KNOWLEDGE_DIR = (Path(__file__).resolve().parents[1] / "llm_agent" / "prompts" / "knowledge").resolve()
TOPIC_PATTERN = re.compile(r"^[a-z0-9_]+$")


def _unique_topics(raw_topics: Iterable[object]) -> List[str]:
    unique: List[str] = []
    seen = set()
    for raw in raw_topics:
        topic = str(raw).strip().lower()
        if not topic or topic == "none" or topic in seen:
            continue
        seen.add(topic)
        unique.append(topic)
    return unique


def _resolve_topic_file(topic: str) -> Path | None:
    if not TOPIC_PATTERN.match(topic):
        return None
    candidate = (KNOWLEDGE_DIR / f"{topic}.md").resolve()
    if KNOWLEDGE_DIR not in candidate.parents:
        return None
    if not candidate.exists():
        return None
    return candidate


def load_knowledge_node(state: MaidState) -> dict:
    """读取 Router 选择的知识卡带并拼接到 active_knowledge。"""
    route = state.get("route")
    topics = _unique_topics(getattr(route, "required_knowledge", []) or [])

    chunks: List[str] = []
    for topic in topics:
        path = _resolve_topic_file(topic)
        if path is None:
            continue
        content = path.read_text(encoding="utf-8").strip()
        if not content:
            continue
        chunks.append(f"## {topic}\n{content}")

    return {"active_knowledge": "\n\n".join(chunks)}
