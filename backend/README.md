# Backend 目录说明

`backend/` 目录包含了 MC_Servant 项目的所有 Python 后端代码。这是一个基于 FastAPI 和 Mineflayer (通过 `javascript` 库) 构建的 Minecraft 智能 NPC 服务。

## 目录结构

-   **bot/**: 机器人控制核心，包含与 Mineflayer 的交互逻辑、动作封装和生命周期管理。
-   **data/**: 静态数据文件（如配置、提示词模板等）。
-   **db/**: 数据库相关代码（SQLAlchemy 模型、仓库层）。
-   **llm/**: 大语言模型（LLM）集成层，负责与 OpenAI/Claude 等 API 交互。
-   **perception/**: 感知系统，负责理解环境、识别方块和实体。
-   **state/**: 状态机与上下文管理，控制 Bot 的宏观行为模式（如空闲、聊天、任务执行）。
-   **task/**: 任务规划与执行系统，包含 LLM 规划器、执行器和运行时。
-   **utils/**: 通用工具函数。
-   **websocket/**: WebSocket 服务器与通信协议，处理与 Java 插件的实时通讯。
-   **tests/**: 单元测试和集成测试。

## 核心文件

-   `main.py`: 应用程序入口点。初始化 FastAPI 应用、WebSocket 服务器、数据库连接、LLM 客户端和 Bot 管理器。
-   `config.py`: 全局配置管理，使用 Pydantic 读取环境变量。
-   `protocol.py`: 定义前后端通信的数据协议（Pydantic 模型）。
-   `requirements.txt`: Python 依赖列表。

## 架构概览

本项目采用分层架构：

1.  **接入层 (WebSocket/FastAPI)**: 处理外部请求和事件。
2.  **决策层 (State Machine/LLM)**: 决定 Bot "做什么" (Intent)。
3.  **规划层 (Task Planner)**: 将 Intent 分解为具体的任务序列。
4.  **执行层 (Task Executor)**: 调度和执行具体任务。
5.  **动作层 (Bot Actions)**: 封装底层的 Mineflayer API，提供语义化的动作接口 (Layer 2)。
6.  **感知层 (Perception)**: 提供环境信息供上层决策。
7.  **记忆层 (Memory)**: 统一管理对话历史、任务经验和长期记忆。
