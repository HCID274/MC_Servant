# Python 项目分层架构图 (执行流向标注)

以下数字 **[0] ~ [7]** 标注了从 `main` 函数开始，一条指令从进入系统到最终执行的完整生命周期流向。

```text
backend/
│
├── [0] [入口层] (main.py)
│   ├── main.py                              <-- [0] 系统启动点：FastAPI 创建、WS 绑定、原始字节流入口
│   ├── config.py                            [配置] 环境变量读取
│   ├── protocol.py                          [协议] WebSocket 消息模型定义
│   └── schemas.py                           [状态] LLM/Graph 结构化数据模型定义
│
├── [1] [websocket 层] (通信基础设施)
│   └── websocket/
│       └── connection_manager.py            <-- [1] 通信中转：维护长连接，处理原始数据的收发与超时清理
│
├── [2] [application 层] (流程编排层)
│   └── application/
│       ├── message_router.py                <-- [2] 路由分发：识别消息类型 (MessageType)，分拨至对应处理器
│       ├── player_handler.py                <-- [3] 业务总导演：编排玩家交互主流程，决定走 LLM 决策还是基础指令
│       ├── context.py                       [上下文] AppRuntime 共享依赖容器
│       ├── bot_runtime.py                   [Bot运行时] Bot 名称解析与按需拉起保障
│       ├── response_sender.py               [统一回包] npc/error/hologram/init_config 响应封装
│       ├── servant_handler.py               [管理命令] 处理 claim/release/list/status 等管理员操作
│       └── presence_handler.py              [在线态同步] 处理 player_join/quit/login 等在线状态同步
│
├── [3] [graph 层] (决策编排层)
│   └── graph/
│       ├── workflow.py                      <-- [4] 思考流：驱动 LangGraph 状态机，开启 Router -> Planner 思考链
│       ├── conditions.py                    [条件分流] Router 意图分支判断
│       └── knowledge_loader.py              [知识注入] 根据意图动态加载并注入 active_knowledge
│
├── [4] [llm_agent 层] (认知层)
│   └── llm_agent/
│       ├── router.py                        [意图识别] 调用 LLM 识别核心意图 (Chat/Task)
│       ├── planner.py                       [任务拆解] 调用 LLM 将宏观目标细化为原子步骤
│       ├── prompts.py                       [提示词装载] 管理并动态填充提示词模板资源
│       └── prompts/...                      [提示词资源] .md 格式的各种 Planner 核心提示词
│
├── [5] [execution 层] (任务调度层)
│   └── execution/
│       ├── task_queue.py                    <-- [5] 任务入队：接收 Planner 产出的步骤序列，按 Bot 维度压入队列
│       ├── task_worker.py                   [消费循环] 开启串行工作线程，逐一从队列中提取并执行任务
│       └── task_executor.py                 [原子执行器] 执行单步动作，负责调用翻译层并将结果下发
│
├── [6] [grounding 层] (语义对齐层)
│   └── grounding/
│       ├── task_translator.py               <-- [6] 语义映射：将 LLM 的“模糊目标”转换为执行层的“精确参数”
│       ├── snapshot_builder.py              [环境快照] 为决策层构建实时的 3D 坐标与背包环境数据
│       ├── cluster_selector.py              [定位算法] 处理 mine 等动作所需的 BFS 聚类与最近目标选择
│       ├── translator.py                    [兼容模块] 既有聊天动作的语义映射实现
│       └── env_client.py                    [环境接口] 预留用于查询游戏世界方块数据的客户端接口
│
└── [7] [bot 层] (物理驱动层)
    └── bot/
        ├── mineflayer_adapter.py            <-- [7] 物理躯干：Mineflayer 适配器，真正执行 jump/chat/look 等动作
        ├── interfaces.py                    [能力契约] 定义 IBotController/Actions 等标准能力规范
        └── README.md                        [文档] 适配器使用说明
```

---

## 指令执行生命周期 (Execution Lifecycle)

1.  **[0] 入口层 (`main.py`)**: 系统接通 WebSocket 信号，原始 JSON 数据流入。
2.  **[1] 通信层 (`connection_manager.py`)**: 管理器 `touch` 活跃连接，确保链路可用，并将数据传给路由。
3.  **[2] 路由层 (`message_router.py`)**: 判定这是否为一条玩家对话 (`PLAYER_MESSAGE`)，并丢给处理器。
4.  **[3] 逻辑层 (`player_handler.py`)**: 启动 `_try_handle_with_graph`，准备向大模型寻求决策建议。
5.  **[4] 决策层 (`graph/workflow.py`)**: LangGraph 引擎运转，驱动 **[认知层]** 思考出任务清单。
6.  **[5] 调度层 (`execution/task_queue.py`)**: 规划好的任务序列被存入对应 Bot 的专属队列，等待 Worker 轮询。
7.  **[6] 翻译层 (`grounding/task_translator.py`)**: 执行前，将清单中的语义（如 `master_front`）即时计算为物理动作包。
8.  **[7] 执行层 (`bot/mineflayer_adapter.py`)**: 驱动 Mineflayer 躯干在 Minecraft 服务器中完成跳跃、移动或挖掘。

---

## 重构后的核心价值

- **[0->2] 通信解耦**: 保证了无论底层 WS 怎么变，业务逻辑层 (`application`) 永远接收的是结构化后的消息。
- **[3->4] 思考异步**: 决策过程在独立线程运行，不阻塞 WebSocket 的高并发心跳处理。
- **[5->7] 执行隔离**: 同一个 Bot 的多个动作被压入队列串行执行，彻底解决了“一边走一边挖”导致的物理引擎冲突问题。
