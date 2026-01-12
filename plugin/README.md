# MC_Servant Java Plugin

本目录包含 MC_Servant 的 Java 插件源码，基于 Spigot/Paper API 开发。

## 🎯 功能职责

该插件作为 "傀儡" 客户端，主要职责是：
1.  **连接器**: 建立并维护与 Python 后端的 WebSocket 连接。
2.  **传感器**: 监听 Minecraft 服务器内的事件（聊天、交互、实体变化）并转发给后端。
3.  **执行器**: 接收后端的文本回复指令并显示在游戏中。
    *注意：复杂的物理动作（移动、挖掘）由 Python 端的 Mineflayer Bot 直接处理，不通过此插件。*
4.  **身份管理**: 管理 Bot 的身份标识（使用 `PersistentDataContainer`）。

## 🔧 技术栈

-   **Java 17+**
-   **Paper API 1.20.6**
-   **Java-WebSocket**: WebSocket 客户端库。
-   **CommandAPI**: 简化的命令注册库。
-   **Maven**: 构建工具。

## 🏗️ 核心类

-   `MCServant`: 插件主类，负责生命周期管理和配置读取。
-   `NetworkClient`: 封装 WebSocket 连接逻辑，包含断线重连机制。
-   `EventListener`: Spigot 事件监听器。

## ⚙️ 编译指南

在 `plugin/` 目录下运行：
```powershell
./mvnw clean package
```
构建产物位于 `target/MC_Servant-1.0.0.jar`。

## 📝 配置文件 `config.yml`

```yaml
backend-url: "ws://localhost:8765/ws/bot"
auth-token: "YOUR_SECRET_TOKEN"
bot:
  default_name: "MCServant_Bot"
```
