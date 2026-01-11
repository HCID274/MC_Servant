# Java Plugin 目录文档

`plugin/` 目录包含了 MC_Servant 的 Minecraft 服务器端插件源码，使用 Java (Spigot/Paper API) 编写。

## 目录结构

-   `src/main/java/com/mcservant/`: Java 源代码。
-   `src/main/resources/`: 资源文件（`plugin.yml`, 默认配置）。
-   `pom.xml`: Maven 项目构建配置。

## 核心功能

该插件作为连接 Minecraft 服务器与 Python 后端的桥梁（Access Layer），主要职责包括：

1.  **WebSocket 客户端**: 连接到 Python 后端的 WebSocket 服务 (`ws://localhost:8765`)。
2.  **指令转发**: 注册 `/bot` 等游戏内指令，将玩家输入转发给后端处理。
3.  **NPC 渲染**:
    -   使用 `Citizens` 或 `NMS` (如果有) 生成 NPC 实体。
    -   处理全息文字 (Holograms) 显示（如 "思考中...", "正在砍树"）。
4.  **事件监听**:
    -   监听玩家聊天 (`AsyncPlayerChatEvent`) 并转发给 Bot。
    -   监听玩家交互（右键 NPC）触发对话。
5.  **环境同步**:
    -   (可选) 向后端同步部分难以通过 Bot 客户端获取的服务器状态。

## 架构

插件采用轻量级设计，复杂的逻辑（LLM、寻路决策）全部卸载到 Python 后端。插件仅负责：
-   **I/O**: 接收后端指令，发送游戏事件。
-   **View**: 在游戏内渲染 Bot 的状态和反馈。
