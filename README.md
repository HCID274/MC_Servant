# MC_Servant 项目文档

**MC_Servant** 是一个基于 **Neuro-Symbolic（神经符号）** 架构的智能 Minecraft NPC 后端系统。它结合了 LLM 的语义理解能力与传统编程的确定性逻辑，旨在展示如何构建一个具备长期记忆、复杂任务规划和环境交互能力的自主 Agent。

本项目目前作为 **Portfolio/MVP** 展示项目，重点在于架构设计与技术实现。

---

## 🏗️ 核心架构

系统主要由两部分组成：

1.  **Python Backend (核心)**:
    -   基于 FastAPI 和 Mineflayer (通过 `javascript` 库)。
    -   负责所有的智能决策、任务规划、记忆管理和 Bot 控制。
    -   采用 **Universal Runner** 统一任务执行框架。
    -   实现了 **L0/L1/L2 分级记忆系统** 和 **RAG (检索增强生成)**。

2.  **Java Plugin (连接器)**:
    -   基于 Paper/Spigot API。
    -   作为 Minecraft 服务器与 Python 后端的通信桥梁。
    -   通过 WebSocket 转发玩家聊天、事件，并接收后端的指令。

---

## 🚀 快速启动

### 1. 环境准备
-   Minecraft Server 1.20.x (推荐 Paper)
-   Python 3.10+
-   Node.js 18+ (用于 Mineflayer)
-   PostgreSQL (用于记忆存储)
-   Maven (用于编译插件)

### 2. 启动 Minecraft 服务器
```powershell
cd MC_Server_1.20.6
.\start.bat
```

### 3. 启动 Python 后端
```powershell
cd MC_Servant
# 确保已安装依赖: pip install -r requirements.txt
.\start.bat
```

### 4. 游戏内交互
```
/servant hello
```

---

## 📚 详细文档目录

请参考各子目录下的 `README.md` 获取详细技术实现说明：

-   **[Backend 架构](./backend/README.md)**: 后端整体设计。
    -   **[Task 系统](./backend/task/README.md)**: UniversalRunner, StackPlanner, 意图识别。
    -   **[Bot 动作](./backend/bot/README.md)**: Meta-Action, Mineflayer 适配器。
    -   **[State & Memory](./backend/state/README.md)**: 状态机, MemoryFacade, 上下文管理。
    -   **[LLM 模块](./backend/llm/README.md)**: 模型工厂, Context Manager。
    -   **[Database](./backend/db/README.md)**: 数据模型, 存储库。
-   **[Java Plugin](./plugin/README.md)**: 插件源码与通信协议。
-   **[Scripts](./scripts/README.md)**: 工具脚本与知识库构建。
-   **[项目文档](./00Docs/MC_Servant/)**: 包含架构图、开发日志和未来规划。

---

## 🛠️ 主要技术特性

*   **Neuro-Symbolic Task Planning**: 结合 LLM 的灵活性与符号逻辑的可靠性。
*   **Universal Runner**: 基于 "Tick Loop" (Observe-Act-Normalize-Execute-Reflect) 的统一任务运行时。
*   **Meta-Action Library**: 封装高层语义动作，解耦 LLM 与底层 API。
*   **RAG-based Memory**: 基于 Postgres 的向量检索，实现跨会话的长期记忆与经验复用。
*   **Dynamic Perception**: 结合 Regex 与 LLM 的语义化环境感知。

---

## ⚠️ 注意事项

*   修改配置请编辑 `backend/config.py`。
*   如需重新编译 Java 插件，请在 `plugin/` 目录下运行 `mvn clean package`。
*   本项目使用 `pydantic-settings` 管理配置，支持 `.env` 文件。
