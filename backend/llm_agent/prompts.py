from pathlib import Path


# 提示词目录约定：统一放在 backend/data/prompts 下
PROMPTS_DIR = Path(__file__).resolve().parents[1] / "data" / "prompts"
INITIAL_SYSTEM_PROMPT = PROMPTS_DIR / "初始提示词.md"


def load_prompt(filename: str) -> str:
    """按文件名读取提示词。"""
    path = PROMPTS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def load_router_system_prompt() -> str:
    """读取 Router 系统提示词。"""
    if not INITIAL_SYSTEM_PROMPT.exists():
        raise FileNotFoundError(f"Router prompt missing: {INITIAL_SYSTEM_PROMPT}")
    return INITIAL_SYSTEM_PROMPT.read_text(encoding="utf-8").strip()
