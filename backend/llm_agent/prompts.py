from pathlib import Path


# 提示词目录约定：统一放在 backend/llm_agent/prompts 下
PROMPTS_DIR = (Path(__file__).resolve().parent / "prompts").resolve()
KNOWLEDGE_DIR = (PROMPTS_DIR / "knowledge").resolve()


def _load_prompt(filename: str) -> str:
    """内部通用的提示词读取逻辑。"""
    path = PROMPTS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Prompt file missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def _load_knowledge_file(filename: str) -> str:
    path = (KNOWLEDGE_DIR / filename).resolve()
    if KNOWLEDGE_DIR not in path.parents:
        raise ValueError(f"Invalid knowledge path: {filename}")
    if not path.exists():
        raise FileNotFoundError(f"Knowledge file missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def get_router_prompt() -> str:
    """第一层：意图识别 (Intent Router)"""
    return _load_prompt("intent_router.md")


def get_chat_planner_prompt() -> str:
    """第二层：聊天规划 (Node Chat Planner)"""
    return _load_prompt("node_chat_planner.md")


def get_task_planner_prompt() -> str:
    """第二层：任务规划 (Node Task Planner)"""
    return _load_prompt("node_task_planner.md")


def get_knowledge_index_prompt() -> str:
    """知识库索引（供 Intent Router 决定 required_knowledge）"""
    return _load_knowledge_file("index.json")


# 兼容旧代码调用
def load_router_system_prompt() -> str:
    return get_router_prompt()
