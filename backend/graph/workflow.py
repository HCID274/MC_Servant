import json
import logging
import sys
from typing import Any, Optional

from langgraph.graph import END, START, StateGraph

from graph.conditions import router_branch
from graph.knowledge_loader import load_knowledge_node
from grounding.snapshot_builder import normalize_env_snapshot
from llm_agent.agents.chat_planner import invoke_chat_planner
from llm_agent.agents.planner import invoke_task_planner
from llm_agent.agents.router import invoke_task_router
from schemas import ChatPlannerOutput, MaidState, RouterOutput, RoutedIntent, TaskPlannerOutput
from tracing.store import TraceStore


logger = logging.getLogger(__name__)


def _format_task_queue_for_log(steps: list[dict[str, Any]]) -> str:
    """日志排版：规划后的步骤序列按单步换行输出。"""
    if not steps:
        return "  (empty)"

    lines: list[str] = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            lines.append(f"  [{index}] <invalid_step> {step!r}")
            continue
        action = str(step.get("action") or "").strip() or "<missing>"
        target = str(step.get("target") or "").strip() or "<empty>"
        count = step.get("count")
        reason = str(step.get("reason") or "").strip() or "<empty>"
        count_suffix = f" count={count}" if count is not None else ""
        lines.append(f"  [{index}] action={action} target={target}{count_suffix} reason={reason}")
    return "\n".join(lines)


def _invoke_task_router(user_input: str):
    """便捷入口：调用底层路由 Agent 进行意图识别。"""
    return invoke_task_router(user_input)


def _load_knowledge_node(state: MaidState):
    """便捷入口：执行知识动态装载逻辑。"""
    return load_knowledge_node(state)


def _normalize_route(route_payload: Any) -> Optional[RouterOutput]:
    """路由收口：兼容检查点恢复后 route 退化成 dict 的场景。"""
    if isinstance(route_payload, RouterOutput):
        return route_payload
    if isinstance(route_payload, dict):
        try:
            return RouterOutput.model_validate(route_payload)
        except Exception:
            return None
    return None


def _build_task_planner_context(state: MaidState) -> str:
    """规划上下文拼装：采用强隔离的 XML 标签，让 LLM 清晰区分原始目标与当前危机。"""
    
    # 1. 永远存在的：原始任务目标
    user_input = str(state.get("user_input") or "").strip()
    parts = [f"<original_goal>\n{user_input}\n</original_goal>"]

    failure_reason = str(state.get("failure_reason") or "").strip()
    execution_result = state.get("execution_result") or {}
    compressed_history = state.get("compressed_history") or[]

    # 2. 如果存在失败原因或历史，说明进入了【重规模式】
    is_replan = bool(failure_reason or execution_result or compressed_history)
    
    if is_replan:
        parts.append("<replan_context>")
        
        # 注入：已经做过的事情（避免重复）
        if isinstance(compressed_history, list) and compressed_history:
            history_lines: list[str] =[]
            for item in compressed_history:
                if not isinstance(item, dict):
                    continue
                summary_id = str(item.get("summary_id") or "").strip()
                summary_text = str(item.get("summary_text") or "").strip()
                if not summary_text:
                    continue
                history_lines.append(f"  [{summary_id}] {summary_text}")
            
            if history_lines:
                parts.append("  <history>\n  " + "\n  ".join(history_lines) + "\n  </history>")

        # 注入：致命危机的案发现场（必须解决的核心）
        if failure_reason or execution_result:
            parts.append("  <crisis>")
            
            if isinstance(execution_result, dict):
                failed_step = execution_result.get("failed_step_index")
                failed_action = execution_result.get("failed_action")
                failed_target = execution_result.get("failed_target")
                if failed_step is not None:
                    parts.append(f"    <failed_location>第 {failed_step} 步: {failed_action}({failed_target})</failed_location>")
            
            if failure_reason:
                parts.append(f"    <failure_reason>{failure_reason}</failure_reason>")
                
            parts.append("  </crisis>")
            
        parts.append("</replan_context>")

    return "\n\n".join(parts)


def _build_chat_planner_context(state: MaidState) -> str:
    """聊天上下文拼装：保留原始用户输入，供 Chat Planner 结合快照生成 grounded 回复。"""
    user_input = str(state.get("user_input") or "").strip()
    return f"<user_input>\n{user_input}\n</user_input>"


def _invoke_task_planner(
    state: MaidState,
    *,
    trace_repo: Optional[TraceStore] = None,
):
    """思考适配器：封装规划器调用逻辑并注入链路追踪上下文。"""
    raw_env_snapshot = state.get("env_snapshot") or {}
    env_snapshot = normalize_env_snapshot(
        raw_env_snapshot,
        bot_name=raw_env_snapshot.get("bot_name", "Maid"),
        player=raw_env_snapshot.get("master_name", "Master"),
    )
    route = _normalize_route(state.get("route"))
    task_intent = route.first_task_intent() if route is not None else None
    trace_ctx = state.get("trace_ctx") or {}
    return invoke_task_planner(
        goal=task_intent.goal if isinstance(task_intent, RoutedIntent) else str(state.get("user_input") or ""),
        context=_build_task_planner_context(state),
        env_snapshot=env_snapshot,
        tool_context=state.get("tool_context") or {},
        bot_name=env_snapshot.get("bot_name", "Maid"),
        master_name=env_snapshot.get("master_name", "Master"),
        trace_repo=trace_repo,
        trace_ctx=trace_ctx,
    )


def _invoke_chat_planner(
    state: MaidState,
    *,
    trace_repo: Optional[TraceStore] = None,
):
    """聊天适配器：封装 Chat Planner 调用并注入标准环境快照。"""
    raw_env_snapshot = state.get("env_snapshot") or {}
    env_snapshot = normalize_env_snapshot(
        raw_env_snapshot,
        bot_name=raw_env_snapshot.get("bot_name", "Maid"),
        player=raw_env_snapshot.get("master_name", "Master"),
    )
    route = _normalize_route(state.get("route"))
    trace_ctx = state.get("trace_ctx") or {}
    return invoke_chat_planner(
        goal=route.primary_goal if isinstance(route, RouterOutput) else str(state.get("user_input") or ""),
        context=_build_chat_planner_context(state),
        env_snapshot=env_snapshot,
        bot_name=env_snapshot.get("bot_name", "Maid"),
        master_name=env_snapshot.get("master_name", "Master"),
        trace_repo=trace_repo,
        trace_ctx=trace_ctx,
    )


def router_node(state: MaidState, *, trace_repo: Optional[TraceStore] = None):
    """分流节点：分析用户原始输入并产出初步的意图路由决策。"""
    existing_route = _normalize_route(state.get("route"))
    existing_intent = str(state.get("intent") or "").strip()
    if existing_route is not None and existing_intent in {"task", "chat"}:
        if existing_intent == "task":
            print("[*] 检测到任务重规划，跳过 Router Agent，直接复用既有任务语义")
        else:
            print("[*] 检测到预路由结果，跳过重复 Router 调用")
        return {"intent": existing_intent, "route": existing_route, "error_msg": None}

    user_input = state.get("user_input", "")
    print(f"[*] 正在分析主人指令: {user_input}")

    trace_ctx = state.get("trace_ctx") or {}
    if trace_repo is None and not trace_ctx:
        routed = _invoke_task_router(user_input)
    else:
        routed = invoke_task_router(user_input, trace_repo=trace_repo, trace_ctx=trace_ctx)
    
    # 异常处理：若 LLM 无法解析，则回退至常规对话模式
    if routed is None:
        return {"intent": "chat", "error_msg": "LLM_PARSE_ERROR"}

    if routed.reply_text and routed.primary_intent == "task":
        print(f"\n女仆: {routed.reply_text}\n")
    return {"intent": routed.primary_intent, "route": routed, "error_msg": None}


def knowledge_loader_node(state: MaidState):
    """注入节点：根据任务目标构造结构化工具查询上下文。"""
    loaded = _load_knowledge_node(state)
    tool_context = loaded.get("tool_context") or {}
    if tool_context:
        print("[*] 已构造任务结构化工具上下文")
    return loaded


def task_planner_node(state: MaidState, *, trace_repo: Optional[TraceStore] = None):
    """规划节点：结合环境快照与专业知识，将目标拆解为原子动作序列。"""
    route = _normalize_route(state.get("route"))
    if route is None:
        return {}

    planned = _invoke_task_planner(state, trace_repo=trace_repo)
    if isinstance(planned, TaskPlannerOutput) and planned.plan:
        tasks = [step.model_dump() for step in planned.plan]
        print(f"[*] Task Planner 产出 {len(tasks)} 个子任务")
        return {
            "plan": planned,
            "opening_reply_text": planned.opening_reply_text or (route.reply_text if isinstance(route, RouterOutput) else None),
            "planned_tasks": tasks,
        }

    # 兜底逻辑：若规划器未产出结果，则保留目标语义但不构造非法旧任务结构。
    task_intent = route.first_task_intent()
    fallback_goal = task_intent.goal if isinstance(task_intent, RoutedIntent) else "unknown_goal"
    print(f"[*] Task Planner 无结果，保留 Router 目标但不下发空心旧任务: goal={fallback_goal}")
    fallback_plan = TaskPlannerOutput(plan=[])
    return {
        "plan": fallback_plan,
        "opening_reply_text": route.reply_text,
        "planned_tasks": [],
    }


def chat_planner_node(state: MaidState, *, trace_repo: Optional[TraceStore] = None):
    """聊天节点：基于标准环境快照生成 grounded 回复与轻互动计划。"""
    route = _normalize_route(state.get("route"))
    if route is None:
        return {}

    planned = _invoke_chat_planner(state, trace_repo=trace_repo)
    if isinstance(planned, ChatPlannerOutput):
        chat_plan = [step.model_dump() for step in planned.plan]
        if chat_plan:
            logger.info("[*] Chat Planner 产出 %s 个轻互动步骤", len(chat_plan))
        return {
            "chat_reply_text": planned.reply_text,
            "chat_plan": chat_plan,
        }

    return {
        "chat_reply_text": route.reply_text or "我在呢主人喵~",
        "chat_plan": [],
    }


def enqueue_task_node(state: MaidState):
    """分发节点：将最终生成的原子任务序列压入异步执行队列。"""
    planned_tasks = state.get("planned_tasks") or []
    if planned_tasks:
        logger.info("[*] 已将任务序列压入队列:\n%s", _format_task_queue_for_log(planned_tasks))
        return {"task_queue": planned_tasks}
    return {}


def build_workflow(
    *,
    checkpointer: Any = None,
    trace_repo: Optional[TraceStore] = None,
    interrupt_before: Optional[list[str]] = None,
    interrupt_after: Optional[list[str]] = None,
):
    """状态机构建：通过 LangGraph 编排女仆大脑的决策拓扑结构。"""
    graph = StateGraph(MaidState)
    graph.add_node("router", lambda state: router_node(state, trace_repo=trace_repo))
    graph.add_node("knowledge_loader", knowledge_loader_node)
    graph.add_node("chat_planner", lambda state: chat_planner_node(state, trace_repo=trace_repo))
    graph.add_node("task_planner", lambda state: task_planner_node(state, trace_repo=trace_repo))
    graph.add_node("enqueue_task", enqueue_task_node)
    
    # 拓扑连通定义
    graph.add_edge(START, "router")
    graph.add_conditional_edges(
        "router",
        router_branch,
        {
            "knowledge_loader": "knowledge_loader",
            "chat_planner": "chat_planner",
            END: END,
        },
    )
    graph.add_edge("knowledge_loader", "task_planner")
    graph.add_edge("chat_planner", END)
    graph.add_edge("task_planner", "enqueue_task")
    graph.add_edge("enqueue_task", END)
    
    return graph.compile(
        checkpointer=checkpointer,
        interrupt_before=interrupt_before,
        interrupt_after=interrupt_after,
    )


def build_graph():
    """兼容性接口：获取默认编排应用。"""
    return build_workflow()


app = build_workflow()


def main() -> None:
    """CLI 入口：支持命令行交互式测试大脑决策流程。"""
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        text = input("主人>>> ").strip()

    result = app.invoke({"user_input": text})
    print("\n--- 最终状态检查 ---")
    print(f"Intent 意图: {result.get('intent')}")
    print("Task Queue (任务队列):", json.dumps(result.get("task_queue", []), ensure_ascii=False))


if __name__ == "__main__":
    main()
