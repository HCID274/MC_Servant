# WebSocket 模块文档

`backend/websocket/` 目录负责处理 WebSocket 连接、消息路由和客户端管理。

## 核心组件

### 1. `connection_manager.py` - 连接管理器
-   `ConnectionManager`: 维护活跃的 WebSocket 连接。
    -   **功能**:
        -   管理连接池 (`active_connections`).
        -   支持单播 (`send_personal`) 和广播 (`broadcast`).
        -   **心跳检测**: 定期清理超时的僵尸连接 (`cleanup_stale`).
        -   **认证**: 校验 `x-access-token`。

### 2. `handlers.py` - 消息处理器
-   `MessageRouter`: 消息路由中心。
    -   **职责**: 根据消息类型 (`type`) 将请求分发给相应的处理器。
    -   **处理逻辑**:
        -   `chat`: 调用状态机或 LLM 处理对话。
        -   `command`: 解析并执行管理指令。
        -   `event`: 处理游戏内事件（如玩家加入）。
    -   集成 `BotManager`, `StateMachine`, `ContextManager` 等核心组件，协调业务流程。

## 通信协议

通信协议定义在 `backend/protocol.py` 中。WebSocket 消息通常为 JSON 格式，包含 `type` 字段用于区分消息类别。

-   **Client -> Server**:
    -   `player_message`: 玩家聊天。
    -   `heartbeat`: 心跳包。
    -   `bot_spawned`: Bot 生成事件。
-   **Server -> Client**:
    -   `npc_response`: NPC 回复。
    -   `hologram_update`: 更新头顶全息文字。
    -   `action_request`: 请求执行动作（针对某些无法由服务端直接控制的动作，如有）。
