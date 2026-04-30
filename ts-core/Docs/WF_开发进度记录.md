# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-041` ~ `T-050`
- 当前已完成任务：`T-041` ~ `T-045`
- 当前活跃任务：`T-046`（任务四十六） `collect`（捡拾）单技能独立验收与接入前验证：先以独立 probe（探针） 文件验证真实捡拾语义，再在同一任务内并入 `/svs`（服务端女仆命令）→ planner（规划器）→ 执行队列 → BotActor（机器人执行代理） 主链路。
- 当前批次摘要：上一批次 `T-031`（任务三十一） 到 `T-040`（任务四十） 已完成对话智能增强、记忆与状态注入、MC（Minecraft，我的世界）事实源、反射动作，以及 Fabric（模组加载器）端服务端桥接基线。新批次默认沿 Fabric mod（Fabric 模组） ↔ TS Core（TypeScript 单核心）真实通信链路推进；`skill`（技能）任务按单技能独立验收执行，并新增 probe（探针） 先行规则：每个技能先在 `ts-core/scripts/probes/` 做独立验证，再在同一任务内并入主程序。
- 当前批次硬约束：不得破坏 BotActor（机器人执行代理）单写者边界；server-bridge（服务端桥接）入口默认 `observe_only`（仅观测），不得绕过 game-chat（游戏聊天） / conversation（对话）队列直接写 Bot（机器人）；不得把 Java（编程语言）或 OkHttp（网络客户端）实现细节渗入 TS Core（TypeScript 单核心）；不得在同一任务内合并多个 `skill`（技能）接入；每个 `skill`（技能） 必须先完成独立 probe（探针） 验证后，才能在同任务内并入主程序。

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

### T-043 — Server Bridge（服务端桥接）长期运行稳定性批量补强

- 状态：已完成（2026-04-27）
- 核心文件：
  - `ts-core/src/interfaces/server-bridge/protocol.ts`
  - `ts-core/src/interfaces/server-bridge/route.ts`
  - `ts-core/src/app/bootstrap/env.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  - `ts-core/README.md`
  - `plugin/src/main/java/com/mcservant/bridge/OkHttpServerBridgeTransport.java`
  - `plugin/src/main/java/com/mcservant/bridge/ServerBridgeConfig.java`
  - `plugin/src/main/java/com/mcservant/bridge/ServerBridgeTransport.java`
  - `plugin/src/main/java/com/mcservant/command/SvsCommand.java`
  - `plugin/README.md`
  - `plugin/BUILD.md`
- 变更快照：
  - TS Core（TypeScript 单核心）端新增 Server Bridge（服务端桥接）生命周期诊断事件：`server_bridge.connected`（已连接）、`server_bridge.closed`（正常关闭）、`server_bridge.disconnected`（异常断开）、`server_bridge.heartbeat_timeout`（心跳超时），并统一写入在线 replay（补拉）流。
  - 协议策略收口为确定性行为：未握手前拒绝 `heartbeat`（心跳）与 `player_message`（玩家消息），重复 `hello`（握手）返回 `duplicate_hello`（重复握手），重复 `message_id`（消息标识）返回 `duplicate_message_id`（重复消息标识），协议版本不匹配返回错误并关闭连接。
  - `message_id`（消息标识）去重从无界 `Set`（集合）改为 1024 条有界 FIFO（先进先出）窗口，避免长连接内存增长；窗口内重复拒绝，窗口外最旧记录淘汰。
  - `SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS`（服务端桥接心跳超时毫秒数）接入 `pnpm start`（启动命令）配置；所有 replay（补拉）事件继续携带 `runtime_effect: "observe_only"`（运行时影响：仅观测），未接入 conversation（对话）主线。
  - Fabric mod（Fabric 模组）端新增指数退避重连、`AUTH_FAILED`（鉴权失败）、`PROTOCOL_INCOMPATIBLE`（协议不兼容）、`RECONNECTING`（重连中）等状态，并让 `/svs`（服务端女仆命令）在不可用时给出明确脱敏提示。
- 审查与验证：
  - 首轮审查打回：`seenMessageIds`（已见消息标识集合）无界增长；修复为有界 FIFO（先进先出）窗口并补淘汰测试。
  - 二次审查打回：lifecycle（生命周期）测试存在 20ms（毫秒）竞态；修复为正常关闭与心跳超时分离测试，并在 route（路由）状态中加入 `closed`（已关闭）守卫。
  - `git diff --check` 通过。
  - `bash ts-core/scripts/pre_review.sh` 通过：循环依赖 161 个文件无循环，TypeScript（类型检查）通过，Biome（代码检查）通过，Vitest（测试）30 个测试文件 / 204 条测试全部通过。
  - `cd plugin && ./gradlew build --no-daemon` 通过，`BUILD SUCCESSFUL in 26s`。
  - 本任务未触碰 LLM（大语言模型）链路、Prompt（提示词）、parser（解析器）或 conversation（对话）路由，无需真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。

### T-044 — `/svs`（服务端女仆命令）接入 conversation（对话）主线

- 状态：已完成（2026-04-27）
- 核心文件：
  - `ts-core/src/app/bootstrap/env.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  - `ts-core/README.md`
  - `plugin/README.md`
  - `plugin/BUILD.md`
- 变更快照：
  - 新增 `SERVER_BRIDGE_CONVERSATION_ENABLED`（服务端桥接对话启用）配置，默认 `false`，保持 T-043（任务四十三） 的 `observe_only`（仅观测） replay（补拉）行为。
  - 显式启用后，仅 `player_message`（玩家消息）会被转换为 `createConversationWorkerTask()`（创建对话工作线程任务）并入 `msg:{botId}`（消息队列）；`hello`（握手）、`heartbeat`（心跳）和 lifecycle（生命周期）诊断不会入对话队列。
  - 入队 `jobId`（任务标识）使用 `message_id`（消息标识），并追加 `task.accepted`（任务已接受） replay（补拉）诊断，便于从 `/api/replay`（补拉接口）确认 `/svs` 已进入主链路。
  - 回复出口继续复用 ConversationWorker（对话工作线程）既有 `broadcastReplySink`（广播回复汇点）到 BotActor（机器人执行代理）`broadcastReply()`（广播回复）；Server Bridge（服务端桥接）层没有直接调用 Mineflayer（Minecraft 协议客户端）聊天出口。
  - 在线入口集成测试覆盖默认未启用不入队、启用后 `/svs` 普通闲聊入队并写回聊天、显式 cancel（取消）不触发额外 LLM（大语言模型）调用且仍发中断和模板回执。
- 审查与验证：
  - `git diff --check` 通过。
  - Manager（管理代理）真实 LLM（大语言模型）复验通过：`POST http://127.0.0.1:8045/v1/chat/completions`，`api_key`（接口密钥）=`sk-local-dev`，`model`（模型）=`bl-auto`，返回内容 `T-044 LLM 复验通过。`，实际上游模型为 `qwen3-max-2026-01-23`。
  - `bash ts-core/scripts/pre_review.sh` 通过：循环依赖 161 个文件无循环，TypeScript（类型检查）通过，Biome（代码检查）通过，Vitest（测试）30 个测试文件 / 205 条测试全部通过。

### T-045 — `goTo`（前往坐标）单技能独立验收与接入前验证

- 状态：已完成（2026-04-30）
- 核心文件：
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/conversation/llm/client.ts`
  - `ts-core/src/conversation/llm/errors.ts`
  - `ts-core/src/conversation/llm/parsers.ts`
  - `ts-core/src/conversation/llm/prompts/plan.ts`
  - `ts-core/src/conversation/llm/skill-plan-table.ts`
  - `ts-core/src/conversation/llm/types.ts`
  - `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts`
  - `ts-core/src/workers/conversation-worker/helpers.ts`
  - `ts-core/src/workers/conversation-worker/types.ts`
  - `ts-core/src/workers/bot-worker.ts`
  - `ts-core/src/runtime/actor.ts`
  - `ts-core/src/runtime/transport/go-to.ts`
  - `ts-core/src/runtime/transport/runtime.ts`
  - `ts-core/src/runtime/transport/types.ts`
  - `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
  - `ts-core/src/__tests__/runtime-actor-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- 变更快照：
  - 在线 planner（规划器） 可执行技能集合收紧为仅 `goTo`（前往坐标）；Prompt（提示词）、策略表、快照上下文与在线入口全部只暴露 `goTo`（前往坐标）。
  - ConversationWorker（对话工作线程） / BotWorker（机器人工作线程） / BotActor（机器人执行代理） 三层同时加门禁：`mine`（挖掘） / `collect`（捡拾） / `equip`（装备） / `cutTree`（砍树） 无论来自 LLM（大语言模型） 非法输出还是绕过对话层直接入队，都不会进入执行路径。
  - 新增 `ConversationLlmSkillNotEnabledError`（LLM 技能未启用错误），把 `cannot_plan`（无法规划） 中的 `skill_not_enabled`（技能未启用） 以及 LLM（大语言模型） 直接返回禁用 `skill_call`（技能调用） 两条路径统一收口为明确门禁语义，不再泛化成 `planner_failed`（规划失败）。
  - `goTo`（前往坐标） 运行时补齐实服修复：寻路允许必要挖掘并提高挖掘代价、兼容 `mineflayer-pathfinder`（Mineflayer 寻路插件） 默认导出 `GoalBlock`（方块目标） 构造器、在 `login/respawn`（登录/重生） 时同步维度 `minY/height`（最低高度/高度） 以适配 Multiworld（多世界模组）。
- 审查与验证：
  - 首轮审查打回的“未启用技能被记成 `planner_failed`（规划失败）”问题已修复；复审通过。
  - Coder（编码代理） 真实 LLM（大语言模型） 验收通过：`/svs 去到 -16 104 10` 仅产出 `goTo`（前往坐标） `skill_call`（技能调用）。
  - Coder（编码代理） 真实 MC（Minecraft，我的世界） 烟测通过：`createMineflayerRuntimeTransport`（创建 Mineflayer 运行时传输） 到 `(-16, 104, 10)` 返回 `result.reached=true`。
  - `bash ts-core/scripts/pre_review.sh` 通过：循环依赖检测通过，TypeScript（类型检查）通过，Biome（代码检查）通过，Vitest（测试）30 个测试文件 / 208 条测试全部通过。
