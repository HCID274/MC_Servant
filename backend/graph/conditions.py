from schemas import MaidState
from langgraph.graph import END


def router_branch(state: MaidState) -> str:
    """根据意图决定是否入队。"""
    intent = state.get("intent")
    if intent == "task":
        return "enqueue_task"
    return END


def verifier_branch(_: MaidState) -> str:
    """
    Verifier 条件边判断（骨架占位）。
    """
    raise NotImplementedError("TODO: 在编排层实现 Verifier 条件分流")
