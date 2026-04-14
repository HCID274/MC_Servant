# 当前任务握手区

【任务序号】: T-015
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 在 `db`（数据库元信息） / `data`（数据持久化契约） / `diagnostics`（诊断） / `interfaces`（接口补拉） 这一组紧邻模块内，集中收口 `event_log`（事件日志） / `task_history`（任务历史） / `JSONL`（结构化日志） / `replay`（补拉） 的纯契约边界，为后续真实写入层与补拉接口实现预留一致、可测试、不可变的持久化模型；本任务不接入真实 PostgreSQL（关系型数据库） 查询、不写真实文件、不启动真实 HTTP（超文本传输协议） 服务。

**上下文说明**:
1. `T-012` 已完成 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 的任务生命周期事件闭环，当前已经有稳定的 `task.accepted` / `task.started` / `task.discarded` / `task.completed` / `task.failed` / `task.interrupted` 强类型事件载荷可作为持久化层输入。
2. `01_ARCHITECTURE.md`（系统架构） 第 8.2、8.3 节与 `05_DATA_SPEC.md`（数据规格） 第 6 节已明确：`event_log`（事件日志） 是 append-only（仅追加） 的补拉真理源，长断线恢复通过 `bot_id + seq` 范围查询实现，`replay`（补拉） 返回当前状态快照与事件批次。
3. `05_DATA_SPEC.md`（数据规格） 第 2、4、7、9 节已定义 `event_log` / `task_history` / `task_summaries`（任务摘要） / `session_summaries`（会话摘要） 表结构、`JSONL`（结构化日志） 目录与写入顺序；当前任务应先把这些规则收成 TypeScript（类型系统） 纯契约，避免后续真实写入层再造平行字段集。
4. `02_RUNTIME_SPEC.md`（运行时规格） 第 9、10 节已规定：BotActor（机器人执行代理） 的关键状态转换、任务终态与错误分类都必须同时落到 `event_log`（事件日志） 与 `JSONL`（结构化日志） 侧；因此本任务要优先清掉“运行时事件名、持久化事件名、补拉事件名”三套命名各自漂移的风险。
5. 本任务仍坚持模块级集中交付：允许在 `db`（数据库元信息） / `data`（数据持久化契约） / `diagnostics`（诊断） / `interfaces`（接口补拉） 及其相关测试内成组修改；不得顺手接入真实 Drizzle（数据库 ORM） 仓储、真实文件写入器、真实 Fastify（接口网关） 路由处理器或 BrainWorker（摘要工作线程） 调用链。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 8.2 节《append-only Event Log》、第 8.3 节《断线重连协议》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 9 节《诊断事件清单》、第 10 节《错误分类》
3. `ts-core/Docs/05_DATA_SPEC.md` — `event_log`、`task_history`、`task_summaries`、`session_summaries` 四个表定义；第 4 节《JSONL 日志规格》；第 6 节《event_log 查询模式》；第 7 节《BrainWorker 数据写入流》；第 9 节《数据一致性约定》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/Docs/WF_需求变更索引.md` — 2026-04-14《MC 认证真理源确认（EasyAuth + SQLite）》条目
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/src/runtime/events.ts` — 全文件
8. `ts-core/src/runtime/tasking.ts` — 全文件
9. `ts-core/src/db/contracts.ts` — 全文件
10. `ts-core/src/db/index.ts` — 全文件
11. `ts-core/src/data/contracts.ts` — 全文件
12. `ts-core/src/data/schema.ts` — 全文件
13. `ts-core/src/data/logs.ts` — 全文件
14. `ts-core/src/data/index.ts` — 全文件
15. `ts-core/src/diagnostics/contracts.ts` — 全文件
16. `ts-core/src/diagnostics/logs.ts` — 全文件
17. `ts-core/src/diagnostics/index.ts` — 全文件
18. `ts-core/src/interfaces/api.ts` — 全文件
19. `ts-core/src/interfaces/realtime.ts` — 全文件
20. `ts-core/src/interfaces/contracts.ts` — 全文件
21. `ts-core/src/interfaces/index.ts` — 全文件
22. `ts-core/src/__tests__/db-config-model.spec.ts` — 全文件
23. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件
24. `ts-core/src/__tests__/interfaces-model.spec.ts` — 全文件
25. `ts-core/src/__tests__/runtime-worker-event-model.spec.ts` — 全文件
26. `ts-core/src/__tests__/data-model.spec.ts` — 全文件
27. `ts-core/src/__tests__/persistence-replay-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须把 `runtime/events.ts`（运行时事件） 中可持久化的事件名、`data/contracts.ts`（数据持久化契约） 中的 `PersistedEventType`（持久化事件类型） 与 `interfaces/realtime.ts`（实时事件包） / `interfaces/api.ts`（补拉接口） 中的补拉事件载荷对齐到同一套命名与字段语义，不允许再维护平行事件字符串集。
2. 必须补齐 `event_log`（事件日志） / `task_history`（任务历史） / `diagnostics`（诊断日志） 三者之间的纯映射边界，至少能稳定表达：accepted（已接受） / started（已开始） / progress（进度） / terminal（终态） 的持久化记录、`log_ref` / `code_ref`（相对路径引用） 规则，以及崩溃恢复所需的“未闭合任务”检测输入 / 输出结构；不得直接写真实 SQL（查询语句） 执行器。
3. `replay`（补拉） 纯契约必须显式落实文档中的边界：默认上限 `50`、`bot_id + after_seq`（机器人标识 + 事件序号） 范围语义、事件按序返回、状态快照与事件批次组合返回；同时要保证事件载荷对调用方深只读。
4. 若新增“写入顺序描述器”或“持久化计划构造器”，必须把 PG（关系型数据库） 真理源、JSONL（结构化日志） 冷日志与 BrainWorker（摘要工作线程） 异步聚合之间的顺序关系编码为可测试纯数据，而不是散落在注释里。
5. 本任务只允许建立纯契约、纯构造器与纯校验器；不得顺手实现真实 repository（仓储） 层、文件系统追加器、HTTP（超文本传输协议） 控制器或 Socket.io（实时推送） 长断线补拉逻辑。

**验收标准**:
1. `event_log`（事件日志） / `task_history`（任务历史） / `JSONL`（结构化日志） / `replay`（补拉） 相关类型与纯构造器之间不存在平行事件名或字段语义漂移，运行时终态事件可以无歧义地映射到持久化与补拉边界。
2. 已存在可测试的纯模型，能够表达长断线补拉请求与响应、事件批次排序 / 限额规则，以及“未闭合任务检测”所需的最小输入输出结构。
3. `log_ref` / `code_ref`（相对路径引用） 与 `diagnostics`（诊断） 通道规则保持一致，且所有对外暴露的事件 / 日志 / 补拉对象都经过深只读切边。
4. 已新增或更新测试，至少覆盖：事件名对齐、补拉边界、持久化计划顺序、未闭合任务检测模型，以及 `task.failed` / `task.interrupted`（任务失败 / 任务中断） 的持久化字段完整性。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-015`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增平行事件字符串集、平行状态集或平行 `log_ref` / `code_ref` 规则
- [ ] `replay`（补拉） 纯契约已锁定默认上限 `50`、按序返回和状态快照 + 事件批次组合语义
- [ ] 新增或更新的持久化 / 补拉对象均经过深只读切边
- [ ] 未接入真实 PostgreSQL（关系型数据库） / 文件系统 / Fastify（接口网关） / Socket.io（实时推送） IO（输入输出）
- [ ] 新增或更新测试覆盖事件名对齐、未闭合任务检测与持久化顺序边界
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-016: 在部署骨架稳定后，规划受控登录入口执行骨架，把外部认证纯契约接到实际运行时动作，但仍保持外部认证源只读。
- T-017: 处理低优先级横切项：基础 `invariants`（不变量） / `guards`（守卫） 工具沉淀与架构文档中的 `domain`（领域） 横切层补记。
- T-018: 在 `conversation`（对话） / `brain`（摘要） 相关模块内收口摘要输入与检索契约，为后续 pgvector（向量检索） 接入做纯模型准备。
