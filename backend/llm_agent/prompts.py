from pathlib import Path


# 提示词资源路径约定
PROMPTS_DIR = (Path(__file__).resolve().parent / "prompts").resolve()
KNOWLEDGE_DIR = (PROMPTS_DIR / "knowledge").resolve()


def _load_prompt(filename: str) -> str:
    """模板装载器：从物理磁盘读取指定名称的提示词 Markdown 源文件。"""
    path = PROMPTS_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"Prompt file missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def _load_knowledge_file(filename: str) -> str:
    """知识文件读取：从受限目录加载特定的知识索引或条目。"""
    path = (KNOWLEDGE_DIR / filename).resolve()
    if KNOWLEDGE_DIR not in path.parents:
        raise ValueError(f"Invalid knowledge path: {filename}")
    if not path.exists():
        raise FileNotFoundError(f"Knowledge file missing: {path}")
    return path.read_text(encoding="utf-8").strip()


def get_router_agent_prompt() -> str:
    """获取意图路由 Agent 的系统提示词模板。"""
    return _load_prompt("intent_router_agent.md")


def get_chat_planner_agent_prompt() -> str:
    """获取对话规划 Agent 的系统提示词模板。"""
    return _load_prompt("node_chat_planner_agent.md")


def get_task_planner_agent_prompt() -> str:
    """获取任务规划 Agent 的系统提示词模板。"""
    return _load_prompt("node_task_planner_agent.md")


def get_step_summary_agent_prompt() -> str:
    """获取步骤总结 Agent 的系统提示词模板。"""
    return _load_prompt("node_step_summary_agent.md")


def get_knowledge_index_prompt() -> str:
    """获取知识库索引数据，用于引导模型进行知识装载决策。"""
    return _load_knowledge_file("index.json")


def load_router_system_prompt() -> str:
    """兼容性接口：获取路由层提示词。"""
    return get_router_agent_prompt()
