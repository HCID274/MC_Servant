from schemas import MaidState
from langgraph.graph import END


def router_branch(state: MaidState) -> str:
    """流向守卫：根据意图识别结果，决定是立即结束还是进入任务规划链路。"""
    intent = state.get("intent")
    if intent == "task":
        return "knowledge_loader"
    if intent == "chat":
        return "chat_planner"
    return END


def verifier_branch(_: MaidState) -> str:
    """反馈决策：根据步骤执行的物理反馈决定是否需要局部修正或重规划。"""
    raise NotImplementedError("TODO: 在编排层实现 Verifier 条件分流")
