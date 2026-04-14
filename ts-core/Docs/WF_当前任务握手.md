# 当前任务握手区

【任务序号】: T-018
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 在 `db`（数据库） + `data`（数据配置） + `app`（应用装配） 这一组紧邻模块内，完成第一块真实 I/O（输入输出） 接入：把现有 PostgreSQL（关系型数据库） / Redis（缓存） 纯描述符推进为**可实例化、可关闭、可被后续 BullMQ（任务队列） / Fastify（接口网关） 复用**的最小运行时资源工厂，并补齐 Drizzle（数据库工具） migration（迁移） 真实执行入口；本任务不启动 HTTP（超文本传输协议） 服务、不实例化 BullMQ（任务队列） 队列、不连接 Mineflayer（Minecraft 协议客户端）。

**上下文说明**:
1. 当前批次到 `T-017`（任务十七） 为止，主干纯契约已经覆盖 `runtime`（运行时） / `interfaces`（接口边界） / `workers`（工作线程） / `data`（数据） / `db`（数据库） / `app`（应用装配） 等核心模块，但尚未接入任何真实外部资源。
2. 依据新的批次调度规则，`T-018`（任务十八） 起优先推进 MVP（最小可运行闭环） 关键路径，而不是继续补 BrainWorker（摘要工作线程） / 文档 / 诊断占位等支线纯契约。
3. 当前 `db/connection.ts`（数据库连接） 和 `db/migrations.ts`（数据库迁移） 仍主要停留在描述符层；`app/bootstrap.ts`（应用装配） 也还没有真实资源生命周期边界。这会推迟真实配置映射、依赖选型、关闭顺序等集成风险暴露。
4. 本任务目标不是“一步到位把服务跑起来”，而是把**真实 PostgreSQL（关系型数据库） / Redis（缓存） 资源**先立起来，供下一任务直接挂 BullMQ（任务队列） / Fastify（接口网关）。
5. 仍需遵守五条不可破坏约束，尤其是“最小闭环优先”与“模块解耦”：本轮只处理资源工厂、迁移入口、装配生命周期，不顺手扩散到对话、执行、观测或网页层。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节《七层技术架构》；第 7 节中 PostgreSQL（关系型数据库） / Redis（缓存） / 启停相关段落
2. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》；第 2 节《PostgreSQL Schema 设计》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/package.json` — 全文件
6. `ts-core/pnpm-lock.yaml` — 全文件
7. `ts-core/README.md` — 全文件
8. `ts-core/.env.example` — 全文件
9. `ts-core/tsconfig.json` — 全文件（如需最小脚本入口补充）
10. `ts-core/src/data/contracts.ts` — 全文件
11. `ts-core/src/data/index.ts` — 全文件
12. `ts-core/src/db/contracts.ts` — 全文件
13. `ts-core/src/db/connection.ts` — 全文件
14. `ts-core/src/db/migrations.ts` — 全文件
15. `ts-core/src/db/index.ts` — 全文件
16. `ts-core/src/db/migrate.ts` — 全文件（可新建）
17. `ts-core/drizzle.config.ts` — 全文件（可新建）
18. `ts-core/src/app/contracts.ts` — 全文件
19. `ts-core/src/app/bootstrap.ts` — 全文件
20. `ts-core/src/app/index.ts` — 全文件
21. `ts-core/src/app/smoke.ts` — 全文件
22. `ts-core/src/app/entrypoint.ts` — 全文件（如需最小启动摘要更新）
23. `ts-core/src/main.ts` — 全文件（如需最小启动接线）
24. `ts-core/src/__tests__/db-config-model.spec.ts` — 全文件
25. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
26. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件（如需更新根导出断言）
27. `ts-core/src/__tests__/db-runtime-io-model.spec.ts` — 全文件（可新建）
28. `ts-core/src/index.ts` — 全文件（如需最小导出补齐）

**核心逻辑要求**:
1. 必须把 PostgreSQL（关系型数据库） 从“纯描述符”推进为**真实运行时资源工厂**：至少能基于现有 `DataConfig`（数据配置） 构建 `pg`（Node PostgreSQL 驱动） / Drizzle（数据库工具） 可用客户端或等价资源句柄，并暴露明确的 `close`（关闭） 生命周期边界；不得继续只返回元信息对象冒充真实连接。
2. 必须为 Redis（缓存） 建立**真实连接工厂**，并明确其与后续 BullMQ（任务队列） 复用的关系；本轮不实例化队列，但连接形态不能和下一轮的 BullMQ（任务队列） 接线冲突。若需在 `redis`（官方客户端） 与 `ioredis`（Redis 客户端库） 间做选择，应以“下一轮最小成本挂 BullMQ（任务队列）”为准。
3. 必须补齐 Drizzle（数据库工具） migration（迁移） 真实执行入口：包括共享配置、命令脚本或入口文件，使后续可以在同一份 PostgreSQL（关系型数据库） 配置上执行迁移；不得再停留在“命令字符串元信息”层。
4. `app/bootstrap.ts`（应用装配） 必须新增或更新真实资源装配边界，至少明确：运行时资源创建顺序、关闭顺序、失败时的最小清理策略、以及对外暴露给下一任务的资源目录；但本轮不得顺手启动 Fastify（接口网关） / BullMQ（任务队列） / Mineflayer（Minecraft 协议客户端）。
5. 测试必须以**无真实外部服务依赖**的方式锁住上述边界：允许通过依赖注入、假工厂、干运行配置断言等方式验证资源工厂和迁移入口；不得把单元测试改成依赖本机 PostgreSQL（关系型数据库） / Redis（缓存） 实例。
6. 本任务不允许顺手修改 `conversation`（对话） / `workers`（工作线程） 任务语义、接口路由协议、外部认证语义、沙箱执行逻辑或观测快照结构。

**验收标准**:
1. 已存在可复用的 PostgreSQL（关系型数据库） 真实资源工厂与 Redis（缓存） 真实连接工厂，且都具备明确的创建 / 关闭边界。
2. Drizzle（数据库工具） migration（迁移） 已有真实入口与共享配置，不再只是命令元信息常量。
3. `app`（应用装配） 已能把 PostgreSQL（关系型数据库） / Redis（缓存） 资源装配进统一生命周期目录，并明确失败清理与关闭顺序。
4. 已新增或更新测试，至少覆盖：配置到真实资源工厂的映射、迁移入口配置复用、资源关闭顺序或清理策略；且测试不依赖真实 PostgreSQL（关系型数据库） / Redis（缓存） 服务。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-018`
- [ ] 仅读取并修改白名单内文件
- [ ] PostgreSQL（关系型数据库） 已从纯描述符推进为可实例化、可关闭的真实资源工厂
- [ ] Redis（缓存） 已具备可复用给后续 BullMQ（任务队列） 的真实连接工厂
- [ ] Drizzle（数据库工具） migration（迁移） 已补齐真实执行入口与共享配置
- [ ] `app`（应用装配） 已明确真实资源创建 / 关闭顺序与失败清理边界
- [ ] 未顺手启动 Fastify（接口网关） / BullMQ（任务队列） / Mineflayer（Minecraft 协议客户端），也未修改对话、观测、沙箱和接口协议语义
- [ ] 已新增或更新测试覆盖资源工厂、迁移入口与生命周期边界，且不依赖真实外部服务
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-019: 在 `workers`（工作线程） + `interfaces`（接口边界） + `app`（应用装配） 内接入真实 BullMQ（任务队列） 队列实例、Fastify（接口网关） 启动骨架与 `/api/health`（健康检查） / `/api/status`（状态） / `/api/replay`（补拉） 最小可访问路由。
- T-020: 在 `runtime`（运行时） + `observation`（观测） + `app`（应用装配） 内接入真实 Mineflayer（Minecraft 协议客户端） 连接、最小 observation（观测） 缓存刷新与 BotActor（机器人执行代理） 的 `INITIALIZING → IDLE`（初始化到空闲） 生命周期闭环。
- T-021: 在 `conversation`（对话） + `workers`（工作线程） + `interfaces`（接口边界） 内打通最小真实消息链路：消息入队、分诊调用、模板回复或执行任务出队。
