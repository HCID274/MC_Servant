# Database Layer (数据库层)

`backend/db/` 模块负责所有持久化数据的管理。项目使用 **SQLAlchemy (Async)** 作为 ORM，**PostgreSQL** 作为数据库。

## 🗄️ 数据库 Schema

核心模型定义在 `models.py` 中：

### 1. Players (`players` 表)
存储玩家信息。
-   `uuid`: Minecraft UUID。
-   `username`: 游戏名。
-   `trust_level`: 信任等级（用于权限控制）。

### 2. Bots (`bots` 表)
存储 Bot 自身的信息。
-   `name`: Bot 名称。
-   `config`: 个性化配置。

### 3. Conversation Contexts (`conversation_contexts` 表)
存储分级记忆。
-   `tier`: 记忆层级 (L0/L1/L2)。
-   `content`: 具体的对话或任务内容。
-   `embedding`: 向量嵌入（用于语义检索）。

### 4. Experience Logs (`experience_logs` 表)
存储任务执行经验，用于 RAG。
-   `task_description`: 任务描述。
-   `execution_plan`: 成功的执行计划。
-   `outcome`: 执行结果。

## 🏭 Repositories (仓储模式)

为了解耦业务逻辑与数据库操作，我们使用 Repository 模式：

-   `BotRepository`: Bot 数据的 CRUD。
-   `PlayerRepository`: 玩家数据的 CRUD。
-   `ContextRepository`: 记忆上下文的 CRUD。
-   `ExperienceRepository`: 经验日志的存取。

**安全规范**:
所有的 Repository 方法都必须包裹在 `try/except` 块中，并在发生数据库错误时记录日志并返回安全的默认值（如 `None` 或空列表），严禁让 SQL 异常导致 WebSocket 断开或服务崩溃。

## 📜 Migrations

使用 Alembic 进行数据库迁移。
-   `alembic revision --autogenerate -m "message"`: 生成迁移脚本。
-   `alembic upgrade head`: 应用迁移。
