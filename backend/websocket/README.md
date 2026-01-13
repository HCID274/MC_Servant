# WebSocket Protocol (通信协议)

`backend/websocket/` 模块负责 Python 后端与 Java 插件之间的实时全双工通信。

## 📡 架构设计

-   **Server**: Python (FastAPI WebSocket Endpoint)。
-   **Client**: Java Plugin (Java-WebSocket)。
-   **Protocol**: JSON 消息。

## 🔐 认证机制

为了防止未授权的连接，连接建立时必须进行握手认证：
1.  **Header**: 客户端在 HTTP 握手阶段必须携带 `x-access-token` 头。
2.  **Validation**: 服务器使用 `secrets.compare_digest` 校验 Token 是否与 `settings.ws_access_token` 匹配。

## 📨 消息协议

消息定义在 `backend/protocol.py` 中。

### Client (Java) -> Server (Python)
-   **ChatMessage**: 玩家聊天内容。
-   **Event**: 游戏内事件（如方块破坏、实体死亡）。
-   **StateUpdate**: Bot 状态同步（心跳）。

### Server (Python) -> Client (Java)
-   **Action**: 指令 Bot 执行动作。
-   **Response**: 聊天回复。

## 💓 连接保活
`ConnectionManager` (`connection_manager.py`) 负责维护连接状态。
-   **Last Seen**: 仅在收到客户端消息时更新 `last_seen` 时间戳。
-   **Pruning**: 定期清理超时的僵尸连接。
