# 当前任务握手区

【任务序号】: T-021
【当前状态】: 待开发（重定义，原 T-021 / T-022 / T-023 已合并为本任务的纵向上线切片）

---

## Manager 任务指令

**任务目标**:
在 `runtime`（运行时） + `workers`（工作线程） + `interfaces`（接口边界） + `app`（应用装配） 这一组相邻模块内，**一次性打通"HTTP 消息 → BullMQ → ConversationWorker → BotActor 单写者 chat 写 → 真实 Minecraft 服务器内可见女仆回复"的最窄端到端链路**，并完成真实连服与 EasyAuth（离线服认证模组） 登录命令注入。本任务是 MVP（最小可运行闭环） 的硬门槛任务，验收时必须能在真实本地 MC（Minecraft，我的世界） 服务器中亲眼看到女仆上线并对一条 HTTP 消息作出聊天回复。

**上下文说明**:
1. `T-018`（任务十八） 已完成 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂；`T-019`（任务十九） 已完成 BullMQ（任务队列） / Fastify（接口网关） 真实启动骨架；`T-020`（任务二十） 已完成 Mineflayer（Minecraft 协议客户端） 传输、`observation`（观测） 缓存与 BotActor（机器人执行代理） 最小生命周期。
2. `BotActor` 当前只有 `start()` / `shutdown()` / `getSnapshot()`，缺一个**唯一的单写者写入口**：把外部请求的"说一句话"动作经由 Mineflayer 真实写到游戏聊天频道。这是本任务必须补齐的最小动作能力。
3. `POST /api/message`（消息提交接口） 当前仍走默认 stub 响应，没有真正写进 `msg:{botId}` BullMQ（任务队列）；ConversationWorker（对话工作线程） 也没有真实消费端实现。本任务必须把这两段一起补齐。
4. 真实运行入口（`src/main.ts`） 当前只打印装配摘要，**不连服**。本任务必须让 `pnpm start`（或等价命令） 在本地配置下真实连接 MC 服务器并完成 EasyAuth（离线服认证模组） 登录命令发送（`/login <secret>`） 后停留在线，可被 HTTP 消息驱动。
5. 本任务允许且必须打破之前 T-021 的以下"禁止"：允许 Mineflayer（Minecraft 协议客户端） chat（聊天） 写、允许执行 EasyAuth（离线服认证模组） 登录命令（仅按 `T-016` 的一次性 `ExternalAuthExecutionPlan`（外部认证执行计划） 注入路径，不读写 EasyAuth SQLite）、允许在 `app`（应用装配） 真实启动序列里串联以上链路。
6. 本任务**仍然不做**：真实 LLM（大语言模型） 调用、Socket.io（实时推送） 真实广播、BotWorker（机器人工作线程） 消费 exec（执行） 队列、`sandbox_code`（沙箱代码） 执行、`task` / `modify` 路径的真实规划落地、复杂技能（goTo / mine / cutTree / collect / equip）；这些留给 T-022 起的后续任务。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏约束》；第 2 节《七层架构》；第 3 节《三队列模型》；第 4 节《消息流》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2 节《BotActor 状态机》；第 5 节《单写者执行模型》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》；第 3.4 节《Triage 容错》；第 4.3 节《回复输出处理》
4. `ts-core/Docs/06_INTERFACE_SPEC.md` — 全文件（如已存在）；不存在则跳过
5. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/package.json` — 全文件
8. `ts-core/.env.example` — 全文件
9. `ts-core/README.md` — 全文件
10. `ts-core/src/domain/contracts.ts` — 全文件（只读参考）
11. `ts-core/src/domain/invariants.ts` — 全文件（只读参考）
12. `ts-core/src/runtime/contracts.ts` — 全文件
13. `ts-core/src/runtime/state-machine.ts` — 全文件（只读参考）
14. `ts-core/src/runtime/tasking.ts` — 全文件（只读参考）
15. `ts-core/src/runtime/events.ts` — 全文件（只读参考）
16. `ts-core/src/runtime/transport.ts` — 全文件
17. `ts-core/src/runtime/actor.ts` — 全文件
18. `ts-core/src/runtime/index.ts` — 全文件
19. `ts-core/src/conversation/contracts.ts` — 全文件（只读参考）
20. `ts-core/src/conversation/triage.ts` — 全文件（只读参考）
21. `ts-core/src/conversation/chat.ts` — 全文件（只读参考）
22. `ts-core/src/conversation/index.ts` — 全文件（只读参考）
23. `ts-core/src/workers/queues.ts` — 全文件（只读参考）
24. `ts-core/src/workers/contracts.ts` — 全文件
25. `ts-core/src/workers/bullmq.ts` — 全文件
26. `ts-core/src/workers/conversation-worker.ts` — 全文件（可新建）
27. `ts-core/src/workers/index.ts` — 全文件
28. `ts-core/src/interfaces/contracts.ts` — 全文件（只读参考）
29. `ts-core/src/interfaces/api.ts` — 全文件（只读参考）
30. `ts-core/src/interfaces/server.ts` — 全文件
31. `ts-core/src/interfaces/index.ts` — 全文件
32. `ts-core/src/app/contracts.ts` — 全文件
33. `ts-core/src/app/bootstrap.ts` — 全文件
34. `ts-core/src/app/smoke.ts` — 全文件
35. `ts-core/src/app/entrypoint.ts` — 全文件
36. `ts-core/src/app/index.ts` — 全文件
37. `ts-core/src/main.ts` — 全文件
38. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
39. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
40. `ts-core/src/__tests__/workers-bullmq-model.spec.ts` — 全文件
41. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
42. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
43. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
44. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 全文件（如已存在）
45. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件（可新建）
46. `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts` — 全文件（可新建）
47. `ts-core/src/__tests__/runtime-broadcast-reply-model.spec.ts` — 全文件（可新建）
48. `ts-core/src/__tests__/main-entrypoint-online-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:

1. **BotActor 单写者写入口（runtime/actor.ts）**：
   - 新增 `broadcastReply({ message_id, content })` 异步方法，只接受非空字符串 content。
   - 调用方必须先满足 `ready_gate.is_ready === true`（已 `IDLE` 且外部认证已 `authenticated` 或 `not_required`）；否则抛错且不调用 transport。
   - 通过 `MineflayerBotHandle` 暴露的 chat 能力把 content 发送到游戏聊天频道（在 `transport.ts` 中扩展最小 `chat(text)` 适配器，允许测试通过依赖注入替换；真实路径调用 mineflayer `bot.chat(text)`）。
   - 调用过程必须串行化（不允许并发两次写），并把每次写产生的 `broadcast_reply` 事件追加到 `emitted_events` 或新增的对外可观测列表。
   - 严守"单写者"：除 BotActor 之外的任何模块都不得直接调用 mineflayer 的 chat 写 API；ConversationWorker / Fastify handler 一律通过 `BotActor.broadcastReply()` 间接写。

2. **ConversationWorker 真实最小处理器（workers/conversation-worker.ts）**：
   - 新建文件，导出 `createConversationWorkerRuntime({ queue, dependencies })`，内部基于 BullMQ Worker 消费 `msg:{botId}` 队列。
   - Job payload 必须是现有 `createConversationWorkerTask()`（创建对话工作线程任务） 产物，不允许另造松散 JSON。
   - 依赖注入项至少包括：`triage`（默认安全回退 `chat` + `Normal`）、`replyGenerator`（默认模板回复，必须经 `ensureReplyEndsWithMeow()`）、`broadcastReplySink`（默认指向 `BotActor.broadcastReply`）、可选 `planner`（本任务**不**注入，留给后续任务）。
   - 处理 `chat` 路径：生成回复 → 调用 `broadcastReplySink`；处理 `cancel` 路径：仅记录日志（不落 Mineflayer 写）；处理 `task` / `modify` 路径：在没有 planner 时拒绝并发 `task.discarded` 生命周期事件，不入 exec 队列。
   - 必须暴露 `start()` / `close()` 生命周期，可被 `app` 装配关停。

3. **POST /api/message 真实入队（interfaces/server.ts + app/bootstrap.ts）**：
   - 默认 message handler 必须把请求转成 `ConversationWorkerTask` 并写入 `msg:{botId}` BullMQ 队列，返回 `202` + 真实 BullMQ `job.id`。
   - 跨 Bot、空白输入仍按 `T-019` 规则返回 `400`。
   - bootstrap 串联：BullMQ 队列实例 → message handler → Fastify 注册 → ConversationWorker 启动 → 共享同一 BullMQ 连接。

4. **真实运行入口连服 + EasyAuth 登录（src/main.ts + app/entrypoint.ts）**：
   - `pnpm start` 必须按以下序列启动：装配 → 真实 PG/Redis 连接 → 真实 BullMQ → 真实 Fastify listen → 真实 Mineflayer connect → 若 `external_auth.status === "pending"` 则在 spawn 后通过 BotActor 单写者发出 `/login <secret>` 命令（一次性，使用 `T-016` 的 `ExternalAuthExecutionPlan` 中的明文 secret，发送后立即从内存清除引用）→ ConversationWorker 启动 → 进入待消息状态。
   - 关闭顺序逆序，确保 Mineflayer 优先 `quit("ts-core shutdown")`、BullMQ Worker close、Fastify close、Redis/PG close。
   - main.ts 不得包含业务逻辑，所有装配仍在 `app/bootstrap.ts` / `app/entrypoint.ts`。

5. **不允许的事项**：
   - 真实 LLM API 调用、Socket.io 真实广播、BotWorker 消费 exec 队列、sandbox 执行、Mineflayer 移动 / 挖掘 / 装备 / 拾取等任何非 chat 写、EasyAuth SQLite 直接读写、新增对话路由优先级或中断语义。
   - 不得绕过 BotActor 直接调用 mineflayer chat。
   - 不得在 ready_gate 未就绪时发任何聊天消息（除 EasyAuth 受控登录命令外，且登录命令路径必须显式打标 `external_auth_login` 不走 broadcastReply）。

**验收标准**:

1. **真实 MC 服务器手测验收（硬门槛）**:
   - 操作员在本地 Fabric + EasyAuth 服务器启动 ts-core，设置 `.env.example` 中的 MC host / port / username / EasyAuth secret。
   - 执行 `pnpm start`，看到日志：连接成功 → spawn → EasyAuth 登录命令已发送 → ready。
   - 在 MC 客户端进入同一服务器，能看到女仆账号在线。
   - 操作员对 ts-core 发送 `curl -X POST http://localhost:<port>/api/message -d '{"bot_id":"...","message_id":"...","content":"你好"}'`，**返回 202**。
   - **MC 聊天频道里能看到女仆账号说出一条以"喵"结尾的回复**。
   - 操作员附上 1 张 MC 客户端聊天截图 + 1 段 ts-core 日志摘录到 Coder 反馈区。

2. **自动化测试覆盖**:
   - `BotActor.broadcastReply()` 在 ready / not-ready / 重复并发三种情况下行为正确（注入假 transport）。
   - ConversationWorker 在无真实 LLM 注入下处理 chat / cancel / task 三类路径行为正确（注入假 triage / sink / queue）。
   - `POST /api/message` 在装配默认路径下真实入队 BullMQ（注入假 BullMQ 客户端验证 add 调用）。
   - main.ts 的启动序列与关闭序列在注入桩资源下顺序正确。
   - 既有跨 Bot 拒绝、空白输入 400、资源失败逆序清理测试仍保持通过。

3. **预检通过**:
   - `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-021`
- [ ] 仅读取并修改白名单内文件
- [ ] BotActor 已新增 `broadcastReply()` 单写者入口，且 ready_gate 未就绪时拒绝
- [ ] ConversationWorker 真实消费 `msg:{botId}` 队列，chat 路径走 broadcastReply
- [ ] `POST /api/message` 默认 handler 真实写 BullMQ，返回真实 job.id
- [ ] `pnpm start` 启动序列：连服 → EasyAuth 登录命令 → ConversationWorker 启动
- [ ] 关闭序列逆序执行，无悬挂 Mineflayer 连接 / Worker / 端口
- [ ] **真实 MC 服务器手测通过**（截图 + 日志摘录粘在反馈区）
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写。必须包含：MC 客户端聊天截图路径、ts-core 启动日志摘录、`pre_review.sh` 输出末尾。）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-022**: 在 `runtime`（运行时） + `workers`（工作线程） + `skills`（技能） 内接入 BotWorker（机器人工作线程） 最小真实执行链：消费 `bot:{botId}:exec`（执行队列） → 调用 BotActor（机器人执行代理） 单写者动作入口（新增 `executeSkill()`） → 覆盖 1 个低风险技能（建议 `goTo`，复用 mineflayer-pathfinder）。验收门槛：HTTP POST "去 (x,y,z)" → 女仆在 MC 中走过去。
- **T-023**: 在 `interfaces`（接口层） + `realtime`（实时推送） + `diagnostics`（诊断） 内补齐 Socket.io（实时推送） 真实广播 + replay（补拉） 真实事件出口；前端能订阅 task lifecycle 事件实时看到女仆动作进度。
- **T-024**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 isolated-vm 真实沙箱与 Facade API 桥接，打通 `sandbox_code` 路径；验收门槛：HTTP POST 一段沙箱代码 → 女仆按代码顺序执行多步动作。
- **T-025**: 在 `conversation`（对话） + `workers`（工作线程） 内接入真实 LLM（大语言模型） 调用与两阶段 triage / planner，替换 T-021 的注入式 stub；验收门槛：HTTP POST 自然语言任务 → 真实 LLM 规划 → 女仆执行。
- **T-026**: BrainWorker（摘要工作线程） 真实落地（摘要写入 task_summaries / session_summaries + pgvector 写入 + 混合检索查询接入）。
- **T-027**: 部署文档 + Docker Compose 拓扑 + 本地 Fabric + EasyAuth 运维约束补齐。
