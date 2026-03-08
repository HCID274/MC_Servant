# Python 项目分层架构图 (执行流向标注)

以下层级编号 **[0] ~ [8]** 标注了从 `main` 函数开始，一条指令从进入系统到最终执行的完整生命周期流向。

```text
backend/
│
├── [0] [入口层] (main.py)
│   ├── main.py                              <-- [0] 系统启动点：FastAPI 创建、WS 绑定、原始字节流入口
│   ├── config.py                            [配置] 环境变量读取、Trace DB / Checkpoint DB 路径配置
│   ├── protocol.py                          [协议] WebSocket 消息模型定义
│   └── schemas.py                           [状态] LLM/Graph 结构化数据模型定义（含 trace_ctx / opening_reply_text / failure_reason）
│
├── [1] [websocket 层] (通信基础设施)
│   └── websocket/
│       └── connection_manager.py            <-- [1] 通信中转：维护长连接，处理原始数据的收发与超时清理
│       └── session_runtime.py               [会话调度] 解耦“收包循环”和“业务处理循环”，为每个 client 建立入站队列
│
├── [2] [application 层] (流程编排层)
│   └── application/
│       ├── handlers/
│       │   ├── message_router.py            <-- [2] 路由分发：识别消息类型 (MessageType)，分拨至对应处理器
│       │   ├── player_handler.py            <-- [3] 玩家用例编排：统一经 Graph 决策，优先回传 Planner 开场白，并将 run_id/thread_id 与任务上下文带入任务队列
│       │   ├── servant_handler.py           [管理命令] 处理 claim/release/list/status 等管理员操作
│       │   └── presence_handler.py          [在线态同步] 处理 player_join/quit/login 等在线状态同步
│       ├── services/
│       │   ├── graph_runner.py              [图执行用例] 生成 run_id/thread_id、执行 LangGraph、提取根图 checkpoint 摘要
│       │   └── task_job_runner.py           [任务消费编排] 消费队列任务并回传执行进度，同时写入执行事件留痕
│       └── core/
│           ├── context.py                   [上下文] AppRuntime 共享依赖容器（含 checkpointer / trace_repo）
│           ├── bot_runtime.py               [Bot运行时] Bot 名称解析与按需拉起保障
│           └── response_sender.py           [统一回包] npc/error/hologram/init_config 响应封装
│
├── [3] [graph 层] (决策编排层)
│   └── graph/
│       ├── workflow.py                      <-- [4] 思考流：驱动 LangGraph 状态机，写回 plan/opening_reply_text，并在编译时挂载 Checkpointer 与断点配置
│       ├── conditions.py                    [条件分流] Router 意图分支判断
│       └── knowledge_loader.py              [知识注入] 根据意图动态加载并注入 active_knowledge
│
├── [4] [tracing 层] (运行留痕层)
│   └── tracing/
│       ├── repository.py                    [审计仓储] 管理 agent_run / llm_call / run_event 三张 SQLite 审计表
│       └── __init__.py                      [导出] 暴露 TraceRepository 供上层接入
│
├── [5] [llm_agent 层] (认知层)
│   └── llm_agent/
│       ├── router.py                        [意图识别] 调用 LLM 识别核心意图，并记录原始 Prompt / Output
│       ├── planner.py                       [任务拆解] 调用 LLM 将宏观目标细化为原子步骤，并输出计划开场白 opening_reply_text
│       ├── structured_output.py             [结构化解析] 从 LLM 原始文本中提取 JSON 并做 Pydantic 校验
│       ├── prompts.py                       [提示词装载] 管理并动态填充提示词模板资源
│       └── prompts/...                      [提示词资源] .md 格式的各种 Planner 核心提示词
│
├── [6] [execution 层] (任务调度层)
│   └── execution/
│       ├── task_queue.py                    <-- [6] 任务入队：接收 Planner 产出的步骤序列与原始上下文，按 Bot 维度压入队列
│       ├── task_worker.py                   [消费循环] 开启串行工作线程，逐一从队列中提取并执行任务
│       └── task_executor.py                 [原子执行器] 通过动作/命令注册表执行原子步骤，避免大段 if-else
│
├── [7] [grounding 层] (语义对齐层)
│   └── grounding/
│       ├── task_translator.py               <-- [7] 语义映射：将 LLM 的“模糊目标”转换为执行层的“精确参数”
│       ├── snapshot_builder.py              [环境快照] 聚合 Mineflayer 的 bot/玩家坐标、背包、装备、生命饱食度与附近方块摘要，并作为 run 输入快照持久化
│       ├── cluster_selector.py              [定位算法] 处理 mine 等动作所需的 BFS 聚类与最近目标选择
│       ├── translator.py                    [兼容模块] 既有聊天动作的语义映射实现
│       └── env_client.py                    [环境接口] 预留用于查询游戏世界方块数据的客户端接口
│
└── [8] [bot 层] (物理驱动层)
    └── bot/
        ├── mineflayer_adapter.py            <-- [8] 物理躯干：Mineflayer 适配器，既执行 jump/chat/look 等动作，也委托本地 JS 聚合环境快照
        ├── interfaces.py                    [能力契约] 定义 IBotController/Actions 等标准能力规范
        └── README.md                        [文档] 适配器使用说明
```

---

## 指令执行生命周期 (Execution Lifecycle)

1.  **[0] 入口层 (`main.py`)**: WebSocket 收到原始 JSON；`heartbeat` 直接快路径回包，不进入业务队列。
2.  **[1] 会话调度 (`session_runtime.py`)**: 非心跳消息进入每个 `client_id` 的入站队列，由独立 dispatcher 异步消费。
3.  **[2] 路由层 (`message_router.py`)**: 按消息类型分流到 player/servant/presence 处理器。
4.  **[3] 应用编排 (`application/handlers/player_handler.py`)**: 所有玩家自然语言输入统一经 `application/services/graph_runner.py` 调用 LangGraph，并优先向玩家发送 Planner 返回的 `opening_reply_text`。
5.  **[4] 运行留痕 (`tracing/repository.py`)**: `agent_run / llm_call / run_event` 审计表保存请求、Prompt/Output 与执行事件；LangGraph Checkpointer 负责节点级 State 存档。
6.  **[5] 决策层 (`graph/workflow.py`)**: LangGraph 运转并产出任务队列（或 chat 回复），同时把 `plan / opening_reply_text` 写回共享状态；每个节点结束后由 Checkpointer 自动落本地检查点。
7.  **[6] 调度层 (`execution/task_queue.py`)**: 快捷动作与规划动作统一按 Bot 维度串行入队，防止同 Bot 并发冲突。
8.  **[6] 任务消费 (`application/services/task_job_runner.py`)**: 队列消费者编排执行顺序并统一发送进度消息，同时记录 task_step 级执行事件。
9.  **[7] 翻译层 (`grounding/task_translator.py`)**: 执行前完成语义到参数的落地转换。
10. **[8] 执行层 (`bot/mineflayer_adapter.py`)**: Mineflayer 执行真实物理动作，并从游戏世界抓取规划所需的环境状态。

---

## 重构后的核心价值

- **[0->2] 收包/处理解耦**: `main.py` 只负责接收与心跳快回，业务处理下沉到 `session_runtime` dispatcher，降低头阻塞。
- **[3->5] 节点可追溯**: LangGraph 原生 Checkpointer 为每次 run 保存节点状态快照，支持后续 `get_state_history()` 回放与恢复。
- **[4->5] Prompt 可审计**: Router/Planner 不再只保留结构化结果，额外保存原始 Prompt、原始输出、解析结果和耗时。
- **[7->8] 环境可感知**: `snapshot_builder` 不再只存空壳字段，而是通过 Mineflayer 适配器调用本地 JS 聚合逻辑，一次性拉取背包、装备、生命饱食度和附近方块摘要，为任务规划提供真实上下文。
- **[1] 会话背压可控**: 入站队列具备容量上限，队列满时主动降载，避免雪崩式堆积。
- **[3->6] 高内聚编排**: `player_handler` 仅做用例路由，图调用、任务消费、留痕存储拆分到独立模块；所有自然语言输入统一走 Graph，避免关键字硬编码分流，任务 Job 会携带原始输入、初始快照与开场白上下文，供后续 Bark 预取与失败重规使用。
- **[6->8] 执行隔离**: 快捷动作与任务动作统一入执行队列，同一个 Bot 严格串行，避免物理动作冲突。
