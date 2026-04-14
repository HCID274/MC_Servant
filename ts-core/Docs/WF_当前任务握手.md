# 当前任务握手区

【任务序号】: T-019
【当前状态】: 待领取

---

## Manager 任务指令

**任务目标**: 在 `workers`（工作线程） + `interfaces`（接口边界） + `app`（应用装配） 这一组紧邻模块内，接入真实 BullMQ（任务队列） 队列实例与 Fastify（接口网关） 启动骨架，使系统具备可启动、可监听、可关闭的最小 HTTP 服务与任务入队能力；本任务不实现消息处理逻辑、不连接 Mineflayer（Minecraft 协议客户端）、不启动 Socket.io（实时推送）。

**上下文说明**:
1. `T-018`（任务十八） 已完成 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂（`db/connection.ts`），提供了基于 `ioredis`（Redis 客户端库） 的可复用连接与 BullMQ（任务队列） 兼容选项（`maxRetriesPerRequest: null` / `lazyConnect` / `enableReadyCheck`）。
2. `workers/queues.ts`（工作线程队列） 已有三队列命名目录（`msg:{botId}`、`bot:{botId}:exec`、`brain`）和并发模型声明，但还没有真实 BullMQ（任务队列） `Queue` 实例。
3. `interfaces/api.ts`（接口路由） 已有 `API_ROUTE_DEFINITIONS`（路由定义目录） 和 `HealthResponse` / `StatusResponse` / `ReplayResponse` 等纯类型，但还没有真实 Fastify（接口网关） 服务器和路由处理器。
4. `app/contracts.ts`（应用装配契约） 已定义完整的 `lifecycle`（生命周期） 启动 / 关闭步骤序列，其中 `start_workers` 依赖 `prepare_runtime` + `prepare_redis`，`start_http` 依赖 `prepare_runtime` + `start_realtime`；关闭顺序为 `stop_workers` → `stop_http` → … → `release_redis` → `release_postgres`。
5. `app/bootstrap.ts`（应用装配） 的 `AppRuntimeResources`（真实资源句柄） 目前只包含 `postgres` 和 `redis`；本任务需要在其上层或旁路新增 BullMQ（任务队列） 队列 + Fastify（接口网关） 服务器的运行时句柄，使下一任务可以直接在队列里入队消息并通过 HTTP 端口收到响应。
6. 依据 01_ARCHITECTURE（架构文档），Phase 1（第一阶段） 最少需要三个 HTTP 端点：`POST /api/message`（入队返回 202）、`GET /api/status`（Redis 缓存读取）、`GET /api/health`（健康检查）。本任务可额外注册 `GET /api/replay`（事件补拉），但不实现真实持久化读取逻辑——返回空数组的强类型占位即可。
7. BullMQ（任务队列） 依赖 `ioredis`（Redis 客户端库），而非 `redis`（Node Redis）。`T-018`（任务十八） 已选定 `ioredis` 并锁死兼容配置，BullMQ（任务队列） 可直接复用同一 ioredis 实例。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节《七层技术架构》（Fastify、BullMQ 段）；第 3 节《三队列异步架构》
2. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
3. `ts-core/scripts/pre_review.sh` — 全文件
4. `ts-core/package.json` — 全文件
5. `ts-core/pnpm-lock.yaml` — 全文件
6. `ts-core/README.md` — 全文件
7. `ts-core/tsconfig.json` — 全文件
8. `ts-core/src/workers/queues.ts` — 全文件
9. `ts-core/src/workers/contracts.ts` — 全文件
10. `ts-core/src/workers/index.ts` — 全文件
11. `ts-core/src/workers/bullmq.ts` — 全文件（可新建）
12. `ts-core/src/interfaces/api.ts` — 全文件
13. `ts-core/src/interfaces/contracts.ts` — 全文件
14. `ts-core/src/interfaces/realtime.ts` — 全文件
15. `ts-core/src/interfaces/index.ts` — 全文件
16. `ts-core/src/interfaces/server.ts` — 全文件（可新建）
17. `ts-core/src/app/bootstrap.ts` — 全文件
18. `ts-core/src/app/contracts.ts` — 全文件
19. `ts-core/src/app/smoke.ts` — 全文件
20. `ts-core/src/app/index.ts` — 全文件
21. `ts-core/src/app/entrypoint.ts` — 全文件
22. `ts-core/src/db/connection.ts` — 全文件（只读参考，获取 Redis 连接类型）
23. `ts-core/src/db/index.ts` — 全文件（只读参考）
24. `ts-core/src/data/contracts.ts` — 全文件（只读参考，获取配置类型）
25. `ts-core/src/index.ts` — 全文件（如需补齐根导出）
26. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
27. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
28. `ts-core/src/__tests__/workers-bullmq-model.spec.ts` — 全文件（可新建）
29. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须基于 T-018 提供的 `RedisRuntimeResource`（或等价 ioredis 连接）创建**三组真实 BullMQ `Queue` 实例**（`msg:{botId}`、`bot:{botId}:exec`、`brain`），每个 Queue 必须暴露明确的 `close()` 生命周期边界。本轮**不创建 BullMQ `Worker` 处理器**——队列只负责接受入队请求，消费逻辑留给后续任务。队列工厂必须支持依赖注入，使测试可以不依赖真实 Redis。
2. 必须创建可 `listen()` / `close()` 的**真实 Fastify 实例**，至少注册四条路由：`GET /api/health`（返回已有 `HealthResponse` 结构）、`GET /api/status`（返回已有 `StatusResponse` 结构的最小占位——可接受返回 `initializing` 状态的默认值）、`POST /api/message`（接受 `MessageSubmissionRequest`，返回 HTTP 202 和 `job_id` 占位——本轮不真正入队）、`GET /api/replay`（返回空事件列表的强类型占位）。路由处理器在本轮可以是硬编码占位，但返回体结构必须与 `interfaces/contracts.ts` 和 `interfaces/api.ts` 中已有类型一致。Fastify 服务器工厂必须支持依赖注入，使测试可以通过 `fastify.inject()` 验证路由而不需要真实监听端口。
3. 必须把 BullMQ 队列和 Fastify 服务器纳入应用装配层的运行时资源体系，明确与已有 `AppRuntimeResources`（postgres + redis）的组合关系、启动顺序和关闭顺序。关闭时必须先关 Fastify（停止接受新请求）、再关 BullMQ 队列（停止入队）、最后才关 Redis / PostgreSQL（基础设施资源）。创建 / 关闭逻辑的失败清理策略必须与 T-018 建立的模式一致（即使前一步失败也继续清理后续资源）。
4. 测试必须以**无真实外部服务依赖**的方式锁住边界：BullMQ 队列通过注入假连接或假 Queue 工厂验证创建 / 关闭边界和队列名匹配；Fastify 路由通过 `fastify.inject()` 验证响应结构和状态码；应用装配层的组合启动 / 关闭顺序也必须有测试覆盖。
5. 本任务**不允许**：实现消息处理 / 分诊逻辑、启动 Socket.io 实时推送、连接 Mineflayer、修改 conversation / sandbox / observation / runtime 核心语义、修改 db/connection.ts 或 db/migrations.ts 的已有接口。

**验收标准**:
1. 已存在三组真实 BullMQ `Queue` 实例工厂，基于 ioredis 连接，具备创建 / 关闭边界和依赖注入能力。
2. 已存在可 listen / close 的 Fastify 服务器实例，至少注册 `/api/health`、`/api/status`、`/api/message`、`/api/replay` 四条路由，返回体类型与已有契约一致。
3. BullMQ 队列和 Fastify 服务器已纳入应用装配层的资源目录，启动 / 关闭顺序与 `lifecycle` 计划一致。
4. 已新增测试覆盖 BullMQ 队列工厂、Fastify 路由响应、应用装配层组合启动 / 关闭顺序，且不依赖真实外部服务。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-019`
- [ ] 仅读取并修改白名单内文件
- [ ] BullMQ 三组 Queue 已创建，基于 ioredis，具备 close 和依赖注入
- [ ] Fastify 服务器已创建，至少注册 4 条路由，返回体类型与已有契约一致
- [ ] 未创建 BullMQ Worker 处理器，未实现消息处理逻辑
- [ ] 未启动 Socket.io、未连接 Mineflayer
- [ ] 应用装配层已明确 BullMQ + Fastify 的启动 / 关闭顺序与失败清理策略
- [ ] 已新增测试覆盖队列工厂、路由响应和组合生命周期，且不依赖真实外部服务
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-020: 在 `runtime`（运行时） + `observation`（观测） + `app`（应用装配） 内接入真实 Mineflayer（Minecraft 协议客户端） 连接、最小 observation（观测） 缓存刷新与 BotActor（机器人执行代理） 的 `INITIALIZING → IDLE`（初始化到空闲） 生命周期闭环。
- T-021: 在 `conversation`（对话） + `workers`（工作线程） + `interfaces`（接口边界） 内打通最小真实消息链路：消息入队、分诊调用、模板回复或执行任务出队。
- T-022: 端到端集成测试 — 从 HTTP 消息入口到 BullMQ 出队到 BotActor 执行到 Socket.io 广播的最小可观测闭环。
