# State & Memory System (状态与记忆系统)

`backend/state/` 模块实现了 Bot 的状态机和统一记忆访问接口。它是连接执行层与数据层的枢纽。

## 🌟 核心组件

### 1. MemoryFacade (记忆门面)
位于 `memory_facade.py`。
这是应用层访问记忆系统的唯一入口。它隐藏了底层数据库和向量检索引擎的复杂性。

**主要功能:**
-   **Conversation History**: 获取和追加聊天记录。
-   **Context Management**: 维护当前的对话上下文（L0/L1/L2 记忆层级）。
-   **Experience Retrieval**: 通过 RAG (检索增强生成) 获取过去类似任务的经验。

**BackgroundTaskManager**:
`MemoryFacade` 内置了一个后台任务管理器，用于处理异步的 "Fire-and-Forget" 记忆写入操作（如日志记录），确保不阻塞主线程，并在系统关闭时优雅完成所有挂起任务。

### 2. State Machine (状态机)
位于 `machine.py` 和 `states.py`。
管理 Bot 的宏观生命周期状态。

**主要状态:**
-   `IdleState`: 空闲，等待指令。
-   `ListeningState`: 正在处理用户输入。
-   `ThinkingState`: 正在进行 LLM 规划。
-   `WorkingState`: 正在执行任务（UniversalRunner 运行中）。
    -   **On Exit**: `WorkingState` 退出时会强制清理 `TaskExecutor`，防止死锁。

### 3. BotContext (上下文)
位于 `context.py`。
这是一个贯穿整个应用生命周期的上帝对象。它持有：
-   `bot`: 当前的 Bot 实例引用。
-   `memory`: `MemoryFacade` 实例。
-   `state_machine`: 状态机实例。
-   `events`: 事件总线。

## 🧠 记忆分级设计

系统实现了类似人类的记忆模型：

-   **L0 (Working Memory)**: 当前正在进行的对话和任务上下文。保存在内存中，随会话结束丢失。
-   **L1 (Short-term Memory)**: 最近的几轮对话历史。
-   **L2 (Long-term Memory)**: 持久化的历史记录和总结。
-   **Semantic Memory (RAG)**: 存储在向量数据库中的知识和经验，通过语义检索调用。
