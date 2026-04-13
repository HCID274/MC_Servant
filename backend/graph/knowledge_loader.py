from domain_catalog import build_tool_context
from grounding.snapshot_builder import normalize_env_snapshot
from schemas import MaidState, RouterOutput, RoutedIntent


def _normalize_route(route_payload: object) -> RouterOutput | None:
    """兼容状态恢复：将 dict 或模型实例统一收口为 RouterOutput。"""
    if isinstance(route_payload, RouterOutput):
        return route_payload
    if isinstance(route_payload, dict):
        try:
            return RouterOutput.model_validate(route_payload)
        except Exception:
            return None
    return None


def load_knowledge_node(state: MaidState) -> dict:
    """结构化工具上下文装载点：为 Planner 注入确定性查询结果。"""
    route = _normalize_route(state.get("route"))
    if route is None:
        return {"tool_context": {}}
    task_intent = route.first_task_intent()
    if not isinstance(task_intent, RoutedIntent):
        return {"tool_context": {}}

    env_snapshot = normalize_env_snapshot(
        state.get("env_snapshot") or {},
        bot_name=(state.get("env_snapshot") or {}).get("bot_name", "Maid"),
        player=(state.get("env_snapshot") or {}).get("master_name", "Master"),
    )
    tool_context = build_tool_context(
        user_input=str(state.get("user_input") or ""),
        route_action="task",
        route_target=task_intent.goal,
        env_snapshot=env_snapshot,
    )
    return {"tool_context": tool_context}
