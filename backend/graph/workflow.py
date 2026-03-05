import json
import sys

from langgraph.graph import END, START, StateGraph

from graph.conditions import router_branch
from llm_agent.router import invoke_task_router
from schemas import MaidState
from schemas import TaskRouterOutput


def _invoke_task_router(user_input: str):
    """便于测试 monkeypatch 的路由调用入口。"""
    return invoke_task_router(user_input)


def router_node(state: MaidState):
    """节点1：思考层路由。"""
    user_input = state.get("user_input", "")
    print(f"[*] 正在分析主人指令: {user_input}")

    routed = _invoke_task_router(user_input)
    if routed is None:
        return {"intent": "chat", "error_msg": "LLM_PARSE_ERROR"}

    if isinstance(routed, TaskRouterOutput):
        return {"intent": "task", "route": routed, "error_msg": None}

    if routed.reply_text:
        print(f"\n女仆: {routed.reply_text}\n")
    return {"intent": routed.intent, "route": routed, "error_msg": None}


def enqueue_task_node(state: MaidState):
    """节点2：task 入队。"""
    route = state.get("route")
    if route:
        new_task = {"action": route.action, "target": route.target}
        print(f"[*] 已将任务压入队列: {new_task}")
        return {"task_queue": [new_task]}
    return {}


def build_workflow():
    """构建并编译 LangGraph 工作流。"""
    graph = StateGraph(MaidState)
    graph.add_node("router", router_node)
    graph.add_node("enqueue_task", enqueue_task_node)
    graph.add_edge(START, "router")
    graph.add_conditional_edges("router", router_branch, {"enqueue_task": "enqueue_task", END: END})
    graph.add_edge("enqueue_task", END)
    return graph.compile()


def build_graph():
    """兼容旧命名。"""
    return build_workflow()


app = build_workflow()


def main() -> None:
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        text = input("主人>>> ").strip()

    result = app.invoke({"user_input": text})
    print("\n--- 最终状态检查 ---")
    print(f"Intent 意图: {result.get('intent')}")
    print("Task Queue (任务队列):", json.dumps(result.get("task_queue", []), ensure_ascii=False))


if __name__ == "__main__":
    main()
