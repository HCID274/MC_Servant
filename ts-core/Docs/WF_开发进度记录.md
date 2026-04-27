# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-041` ~ `T-050`
- 当前已完成任务：`T-041`
- 当前活跃任务：`T-042`（任务四十二） 在线启动配置与 MC（Minecraft，我的世界）实服烟测入口收口：让 `pnpm start`（启动命令） 可通过环境变量启用 Server Bridge（服务端桥接）与 EasyAuth（离线服认证模组）登录命令，并输出用户可执行的最短实服手测口径。
- 当前批次摘要：上一批次 `T-031`（任务三十一） 到 `T-040`（任务四十） 已完成对话智能增强、记忆与状态注入、MC（Minecraft，我的世界）事实源、反射动作，以及 Fabric（模组加载器）端服务端桥接基线。新批次默认沿 Fabric mod（Fabric 模组） ↔ TS Core（TypeScript 单核心）真实通信链路推进。
- 当前批次硬约束：不得破坏 BotActor（机器人执行代理）单写者边界；server-bridge（服务端桥接）入口默认 `observe_only`（仅观测），不得绕过 game-chat（游戏聊天） / conversation（对话）队列直接写 Bot（机器人）；不得把 Java（编程语言）或 OkHttp（网络客户端）实现细节渗入 TS Core（TypeScript 单核心）。

---

## 详细记录

### T-041 — Server Bridge（服务端桥接）双端最小集成闭环

- 状态：已完成（2026-04-27）
- 核心文件：
  - `ts-core/src/interfaces/server-bridge/protocol.ts`
  - `ts-core/src/interfaces/server-bridge/route.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  - `plugin/src/main/java/com/mcservant/bridge/ServerBridgeTransport.java`
  - `plugin/src/main/java/com/mcservant/bridge/OkHttpServerBridgeTransport.java`
  - `plugin/src/main/java/com/mcservant/command/SvsCommand.java`
  - `plugin/src/main/java/com/mcservant/MCServantMod.java`
  - `plugin/README.md`
  - `plugin/BUILD.md`
  - `ts-core/README.md`
- 变更快照：
  - TS Core（TypeScript 单核心）新增 `/ws/server-bridge`（服务端桥接 WebSocket）真实接收端，使用 `Authorization: Bearer <token>`（授权头）校验，解析 `hello`（握手）/ `heartbeat`（心跳）/ `player_message`（玩家消息），返回 `ack/error`（确认 / 错误）帧。
  - 通过 `appendRealtimeEvent`（追加实时事件）把 `server_bridge.*`（服务端桥接事件）写入 replay（补拉）流，并在载荷中保留 `runtime_effect: "observe_only"`（运行时影响：仅观测），未接入 conversation（对话）/ exec（执行）/ BotActor（机器人执行代理）写入口。
  - Fabric mod（Fabric 模组）新增 `/svs <message>`（服务端女仆命令），经 `ServerBridgeTransport.sendPlayerMessage()`（发送玩家消息）发出 `player_message` 帧；普通玩家无权限时返回明确红色提示，不发送帧。
  - `@fastify/websocket`（Fastify WebSocket 插件）、`ws`（WebSocket 客户端库）与 `@types/ws`（类型定义）作为最小依赖加入 `ts-core`。
  - 补齐裸路由和在线入口级集成测试：真实监听 Fastify（接口网关）端口，WebSocket 发送三类帧后从 `/api/replay`（补拉接口）读到 `server_bridge.*` 事件，且响应不含 token（令牌）。
- 审查与验证：
  - `bash ts-core/scripts/pre_review.sh` 通过：30 个测试文件、198 条测试全部通过。
  - `cd plugin && ./gradlew build --no-daemon` 通过。
  - `cd plugin && ./gradlew dependencies --configuration include --no-daemon` 显示 OkHttp（网络客户端）、Okio（输入输出库）与 Kotlin stdlib（Kotlin 标准库）闭包仍在 `include`（嵌入依赖）配置内。
  - `git diff --check` 通过。
