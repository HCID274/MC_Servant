# Backend 架构概览

`backend/` 是 MC_Servant 的核心大脑，承载了所有的智能逻辑。采用分层架构，确保模块的低耦合与高内聚。

## 📁 目录结构

```
backend/
├── main.py               # 应用程序入口 (FastAPI + WebSocket)
├── config.py             # 全局配置
├── protocol.py           # 通信协议定义
├── bot/                  # Bot 控制与动作层
│   ├── meta_actions/     # 高级动作库 (Meta-Actions)
│   └── mineflayer_adapter.py # Mineflayer 适配器
├── task/                 # 任务规划与执行层
│   ├── universal_runner.py # 通用任务运行时 (Tick Loop)
│   └── stack_planner.py  # 栈式规划器
├── state/                # 状态管理层
│   ├── machine.py        # 有限状态机
│   └── memory_facade.py  # 统一记忆接口
├── db/                   # 数据持久层 (SQLAlchemy)
├── llm/                  # 大模型集成层
├── perception/           # 感知层 (KnowledgeBase)
└── websocket/            # WebSocket 服务端实现
```

## 🏗️ 核心设计模式

### 1. Neuro-Symbolic (神经符号架构)
系统不完全依赖 LLM 进行决策。
-   **符号层 (Fast Path)**: 处理确定性逻辑（如合成配方、寻路算法、状态检查）。
-   **神经层 (Slow Path)**: 处理模糊指令、复杂规划和自然语言理解。
这种混合架构大幅降低了 Token 消耗，提高了系统的稳定性。

### 2. Dependency Injection (依赖注入)
各模块之间通过接口交互，而非具体实现。例如 `runner_factory.py` 负责组装 `Context`，将 `Memory`、`Actions` 等依赖注入到 Runner 中。

### 3. The Tick Loop (通用运行时)
所有的任务执行（无论是简单的聊天还是复杂的建筑）都运行在 `UniversalRunner` 的 Tick Loop 中：
1.  **Observe**: 获取当前 Bot 状态和环境信息。
2.  **Act**: 调用 Planner (StackPlanner) 决定下一步操作。
3.  **Normalize**: 规范化参数，从知识库补充细节。
4.  **Execute**: 调用 Meta-Action 执行动作。
5.  **Reflect**: 检查执行结果，更新记忆，决定是否重试或恢复。

## 🔧 启动与配置

入口文件为 `main.py`。

### 环境变量
推荐使用 `.env` 文件配置：
```ini
MC_HOST=localhost
MC_PORT=25565
BOT_USERNAME=MCServant
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql+asyncpg://user:pass@localhost/dbname
```

### 开发规范
-   **代码注释**: 必须使用中文。
-   **类型提示**: 全面使用 Python Type Hints。
-   **异步编程**: 核心 IO 操作均使用 `asyncio`。
