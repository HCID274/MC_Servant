import json
import sys

from langgraph.graph import END, START, StateGraph

from graph.conditions import router_branch
from graph.knowledge_loader import load_knowledge_node
from llm_agent.planner import invoke_task_planner
from llm_agent.router import invoke_task_router
from schemas import MaidState, TaskPlannerOutput, TaskRouterOutput


def _invoke_task_router(user_input: str):
    """便于测试 monkeypatch 的路由调用入口。"""
    return invoke_task_router(user_input)


def _load_knowledge_node(state: MaidState):
    """便于测试 monkeypatch 的知识装载入口。"""
    return load_knowledge_node(state)


def _invoke_task_planner(state: MaidState):
    """便于测试 monkeypatch 的任务规划入口。"""
    env_snapshot = state.get("env_snapshot") or {}
    return invoke_task_planner(
        context=state.get("user_input", ""),
        active_knowledge=state.get("active_knowledge", "") or "",
        inventory=env_snapshot.get("inventory", {}),
        nearby_blocks=env_snapshot.get("nearby_blocks", []),
        bot_pos=env_snapshot.get("bot_pos", {}),
        player_pos=env_snapshot.get("player_pos", {}),
        bot_name=env_snapshot.get("bot_name", "Maid"),
        master_name=env_snapshot.get("master_name", "Master"),
    )


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


def knowledge_loader_node(state: MaidState):
    """节点2：按 Router 的 required_knowledge 注入知识卡带。"""
    loaded = _load_knowledge_node(state)
    active_knowledge = loaded.get("active_knowledge", "")
    if active_knowledge:
        print("[*] 已加载任务相关知识卡带")
    return loaded


def task_planner_node(state: MaidState):
    """节点3：基于 active_knowledge 进行任务拆解。"""
    route = state.get("route")
    if route is None:
        return {}

    planned = _invoke_task_planner(state)
    if isinstance(planned, TaskPlannerOutput) and planned.plan:
        tasks = [step.model_dump() for step in planned.plan]
        print(f"[*] Task Planner 产出 {len(tasks)} 个子任务")
        return {"planned_tasks": tasks}

    fallback_task = {"action": route.action, "target": route.target}
    print(f"[*] Task Planner 无结果，回退为 Router 单任务: {fallback_task}")
    return {"planned_tasks": [fallback_task]}


def enqueue_task_node(state: MaidState):
    """节点4：task 入队。"""
    planned_tasks = state.get("planned_tasks") or []
    if planned_tasks:
        print(f"[*] 已将任务序列压入队列: {planned_tasks}")
        return {"task_queue": planned_tasks}

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
    graph.add_node("knowledge_loader", knowledge_loader_node)
    graph.add_node("task_planner", task_planner_node)
    graph.add_node("enqueue_task", enqueue_task_node)
    graph.add_edge(START, "router")
    graph.add_conditional_edges("router", router_branch, {"knowledge_loader": "knowledge_loader", END: END})
    graph.add_edge("knowledge_loader", "task_planner")
    graph.add_edge("task_planner", "enqueue_task")
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
