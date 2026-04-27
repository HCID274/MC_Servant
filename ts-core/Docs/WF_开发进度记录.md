# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-041` ~ `T-050`
- 当前已完成任务：`T-041` ~ `T-042`
- 当前活跃任务：`T-043`（任务四十三） Server Bridge（服务端桥接）稳定性批量补强：集中完成 TS Core（TypeScript 单核心）接收端与 Fabric mod（Fabric 模组）客户端的重连、心跳、版本、断线诊断、状态投影与部署文档收口。
- 当前批次摘要：上一批次 `T-031`（任务三十一） 到 `T-040`（任务四十） 已完成对话智能增强、记忆与状态注入、MC（Minecraft，我的世界）事实源、反射动作，以及 Fabric（模组加载器）端服务端桥接基线。新批次默认沿 Fabric mod（Fabric 模组） ↔ TS Core（TypeScript 单核心）真实通信链路推进；任务切分按模块批量合并，同一 Server Bridge（服务端桥接）模块内的稳定性项不再拆成多个小任务。
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

### T-042 — 在线启动配置与 MC（Minecraft，我的世界）实服烟测入口收口

- 状态：已完成（2026-04-27）
- 核心文件：
  - `ts-core/src/main.ts`
  - `ts-core/src/app/bootstrap/env.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  - `ts-core/README.md`
  - `plugin/README.md`
  - `plugin/BUILD.md`
- 变更快照：
  - 默认 `pnpm start`（启动命令） 入口已支持 `SERVER_BRIDGE_ENABLED`（是否启用）、`SERVER_BRIDGE_ACCESS_TOKEN`（访问令牌） 与 `SERVER_BRIDGE_PATH`（服务端桥接路径）；未配置时关闭，配置 token（令牌） 时启用，显式禁用优先，显式启用但缺 token（令牌） 启动失败。
  - `main.ts`（默认入口） 将解析后的 Server Bridge（服务端桥接）依赖注入 `startAppOnlineRuntime()`（真实在线启动入口），不再要求用户编写自定义入口来启用 `/ws/server-bridge`（服务端桥接 WebSocket）。
  - 外部认证继续采用 EasyAuth（离线服认证模组）“方案二”：TS Core（TypeScript 单核心）只持有机器人自己的明文密码并经 BotActor（机器人执行代理）单写者路径发送 `/login <secret>`（登录命令）；公开状态和 replay（补拉）事件只允许 `/login <redacted>`（脱敏登录命令）。
  - 文档补齐最短实服烟测：启动 PostgreSQL（关系型数据库）/ Redis（缓存）/ TS Core（TypeScript 单核心）/ Fabric server（Fabric 服务端），配置 `mcservant.bridge.*`（服务端桥接参数），执行 `/svs hello`（服务端女仆命令），再检查 `/api/status`（状态接口） 与 `/api/replay`（补拉接口）。
  - 本轮未触碰 LLM（大语言模型）、Prompt（提示词）、parser（解析器） 或 conversation（对话）路由，因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- 审查与验证：
  - 首轮审查因 `ts-core/src/app/bootstrap/index.ts`（引导桶导出）越界导出 `env.ts` 被打回；修复后改为 `main.ts` 和测试直接从 `app/bootstrap/env.js` 导入。
  - `git diff --check` 通过。
  - `bash ts-core/scripts/pre_review.sh` 通过：循环依赖 161 个文件无循环，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 30 个测试文件 / 199 条测试全部通过。
  - 真实 Fabric server（Fabric 服务端）现场加载仍待用户按 README（说明文档） 手测回报；代码验收已给出最小回报项。
