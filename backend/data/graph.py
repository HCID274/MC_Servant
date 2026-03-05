import json
import sys
from pathlib import Path

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

from schemas import MaidState, RouterOutput

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "初始提示词.md"
LLM_BASE_URL = "http://127.0.0.1:8000/v1"
LLM_MODEL = "qwen3.5-2b" # 注意：2B模型可能能力较弱，建议测试时多观察
LLM_API_KEY = "EMPTY"

def _load_router_prompt() -> str:
    # 确保文件存在，不然直接报错清晰一点
    if not PROMPT_PATH.exists():
        return "你是一个可爱的猫娘女仆，判断主人说话是 chat 还是 task。"
    return PROMPT_PATH.read_text(encoding="utf-8").strip()

def _invoke_task_router(user_input: str) -> RouterOutput | None:
    # 推荐使用 ChatPromptTemplate，这是 LangChain 的标准写法
    prompt_template = ChatPromptTemplate.from_messages([
        ("system", _load_router_prompt()),
        ("human", "{input}")
    ])
    
    llm = ChatOpenAI(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0.4,
        max_retries=1,
    )
    
    structured_llm = llm.with_structured_output(RouterOutput)
    chain = prompt_template | structured_llm
    
    try:
        # 必须加 try-catch，防范小模型胡言乱语
        return chain.invoke({"input": user_input})
    except Exception as e:
        print(f"[-] LLM 解析失败: {e}")
        return None

# ================= 节点定义 =================

def router_node(state: MaidState):
    """节点1：大脑思考与解析"""
    user_input = state.get("user_input", "")
    print(f"[*] 正在分析主人指令: {user_input}")
    
    routed = _invoke_task_router(user_input)
    
    if routed is None:
        # 解析失败时的降级处理
        return {"intent": "chat", "error_msg": "LLM_PARSE_ERROR"}
        
    # 立刻输出女仆的回复（异步感）
    print(f"\n女仆: {routed.reply_text}\n")
    
    return {
        "intent": routed.intent,
        "route": routed,
        "error_msg": None,
    }

def enqueue_task_node(state: MaidState):
    """节点2：如果是干活(task)，则压入任务队列"""
    route = state.get("route")
    if route:
        new_task = {"action": route.action, "target": route.target}
        print(f"[*] 已将任务压入队列: {new_task}")
        # 因为在 schemas 里用了 Annotated[list, operator.add]
        # 我们只需返回一个新的列表，LangGraph 会自动把新列表合并（追加）到旧列表里！
        return {"task_queue":[new_task]} 
    return {}

# ================= 路由条件函数 =================
def route_condition(state: MaidState) -> str:
    """根据 intent 决定图的走向"""
    intent = state.get("intent")
    if intent == "task":
        return "enqueue_task" # 去干活
    else:
        return END # 只是闲聊，直接结束当前流转

# ================= 构建图 (只编译一次) =================
def build_graph():
    graph = StateGraph(MaidState)
    
    graph.add_node("router", router_node)
    graph.add_node("enqueue_task", enqueue_task_node)

    graph.add_edge(START, "router")
    
    # 【核心修正】：引入条件边 (Conditional Edge)
    graph.add_conditional_edges(
        "router", 
        route_condition, 
        {"enqueue_task": "enqueue_task", END: END}
    )
    
    graph.add_edge("enqueue_task", END)

    return graph.compile()

# 全局单例编译，避免每次对话重复编译
app = build_graph()

def main() -> None:
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        text = input("主人>>> ").strip()

    # 初始化状态（注意 task_queue 初始不传或者传空列表）
    initial_state = {"user_input": text}
    
    # 运行图
    result = app.invoke(initial_state)

    print("\n--- 最终状态检查 ---")
    print(f"Intent 意图: {result.get('intent')}")
    print("Task Queue (任务队列):", json.dumps(result.get("task_queue",[]), ensure_ascii=False))

if __name__ == "__main__":
    main()