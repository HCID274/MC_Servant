# Database 模块文档

`backend/db/` 目录包含了数据库交互层的所有代码，使用 SQLAlchemy (AsyncIO) 作为 ORM 框架，PostgreSQL 作为数据库。

## 目录结构

-   `migrations/`: Alembic 数据库迁移脚本。
-   `__init__.py`: 导出常用模块。
-   `database.py`: 数据库连接配置、Session 管理器初始化。
-   `models.py`: 定义所有数据库表结构 (ORM 模型)。
-   `*repository.py`: 数据访问对象 (DAO) 模式实现，封装具体的数据库操作。

## 核心模型 (`models.py`)

### 1. 基础数据
-   `Player`: 存储玩家信息 (UUID, 名称, 在线状态)。
-   `Bot`: 存储 Bot 信息 (名称, 人格, 主人, 皮肤)。

### 2. 记忆系统 (Memory System)
-   `ConversationContext`: 存储玩家与 Bot 的对话上下文，实现了三级记忆结构：
    -   **L0**: 原始对话缓冲 (Raw Buffer)。
    -   **L1**: 情景记忆 (Episodic Memory, 摘要)。
    -   **L2**: 核心记忆 (Core Memory, 高密度信息)。
-   `CompressionLog`: 记录记忆压缩过程的日志，用于调试和追溯。

### 3. 经验系统 (RAG)
-   `TaskExperience`: 存储 Bot 的任务执行经验，用于 RAG (检索增强生成)。
    -   包含任务目标、向量嵌入 (Embedding)、执行步骤、结果状态和环境指纹。

## Repository 层

Repository 模式用于解耦业务逻辑与数据库实现，并统一处理异常。

-   `bot_repository.py`: Bot 数据的增删改查。
-   `player_repository.py`: 玩家数据的管理。
-   `context_repository.py`: 对话上下文的存取与更新。
-   `experience_repository.py`: 任务经验的向量检索与存储。

## 设计原则

1.  **异步优先**: 所有数据库操作均为 `async/await`。
2.  **容错性**: Repository 方法通常包含 `try/except` 块，确保数据库错误不会导致 WebSocket 断开或主进程崩溃。
3.  **时区处理**: 统一使用 UTC+8 (北京时间) 进行存储和记录。
