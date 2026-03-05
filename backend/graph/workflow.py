from langgraph.graph import StateGraph

from schemas import MaidState


def build_workflow() -> StateGraph:
    """
    LangGraph 工作流定义入口（骨架占位）。
    """
    raise NotImplementedError("TODO: 在编排层连接 Router/Planner/Grounding/Executor 节点")

