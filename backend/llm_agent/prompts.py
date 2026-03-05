from pathlib import Path


# 提示词目录约定：统一放在 backend/data/prompts 下
PROMPTS_DIR = Path(__file__).resolve().parents[1] / "data" / "prompts"
INITIAL_SYSTEM_PROMPT = PROMPTS_DIR / "初始提示词.md"


def load_prompt(_: str) -> str:
    """
    提示词读取入口（骨架占位）。

    说明：此处只保留接口，不实现具体策略。
    """
    raise NotImplementedError("TODO: 在思考层接入具体提示词读取策略")

