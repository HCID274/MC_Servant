# Bot 模块文档

`backend/bot/` 目录实现了 Bot 的底层控制逻辑，充当 Python 后端与 Minecraft 游戏世界（通过 Mineflayer）之间的桥梁。

## 核心组件

### 1. `interfaces.py` - 核心接口定义
定义了 Bot 系统的核心抽象接口，遵循依赖倒置原则：
-   `IBotController`: 基础控制接口（连接、断开、聊天、基础移动）。
-   `IBotActions`: 高级动作接口（Layer 2），定义了 `goto`, `mine`, `craft` 等语义化动作。
-   `ActionResult`: 统一的动作执行结果格式。

### 2. `mineflayer_adapter.py` - Mineflayer 适配器
实现了 `IBotController` 和 `IBotManager`。
-   使用 `javascript` 库加载 `mineflayer` Node.js 库。
-   管理 Bot 实例的创建、生成、销毁。
-   处理 AuthMe 登录逻辑（密码自动隐藏）。
-   提供底层的事件监听（如 `chat`, `spawn`, `kicked`）。

### 3. `actions.py` - 动作实现 (Layer 2)
实现了 `IBotActions` 接口 (`MineflayerActions` 类)。
-   封装了复杂的 Mineflayer 插件调用（如 `pathfinder`, `tool`, `pvp`）。
-   **功能亮点**:
    -   **智能寻路**: 自动处理 `goto` 请求。
    -   **自动采集**: `mine` 动作包含寻路、选工具、挖掘全流程。
    -   **合成系统**: `craft` 动作自动查配方、找工作台。
    -   **语义感知**: `find_location` 使用 Python 逻辑分析地形特征（如最高点、平地）。
    -   **容错机制**: 内置超时处理和重试逻辑。

### 4. `lifecycle_manager.py` - 生命周期管理
-   管理 Bot 的上下线逻辑。
-   处理所有者（Owner）的登录/登出事件。
-   实现超时自动下线（如主人离线 10 小时后下线）。

### 5. `tag_resolver.py`
-   辅助工具，用于解析 Minecraft 的标签（Tags）和方块 ID。

## 目录结构

-   `meta_actions/`: (如果有) 定义更高级的元动作。
-   `drivers/`: (如果有) 特定功能的驱动实现。
-   `systems/`: (如果有) 独立的子系统实现。

## 设计理念

该模块的核心是将 Mineflayer 的底层 API（回调、事件驱动）转换为 Python 的 `async/await` 接口，并提供高层次的语义动作，使得上层（LLM 或状态机）无需关心具体的寻路算法或数据包细节。
