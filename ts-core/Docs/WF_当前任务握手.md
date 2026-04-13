# 当前任务握手区

【任务序号】: T-009
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `db`（数据库接入） 与 `data`（数据 / 配置） 边界上的最小强类型契约，收口 PostgreSQL（关系型数据库） 连接参数、Redis（缓存） 键命名 / 状态缓存、JSONL（结构化日志） 根目录与保留期、Bot 级 `config`（配置） 覆盖语义，以及 migration（迁移） / extension（扩展） 元信息，为后续本地应用装配和首轮无 MC（Minecraft） 冒烟闭环提供稳定的基础设施入口；但不接入真实 PostgreSQL（关系型数据库） 客户端、Redis（缓存） 客户端、Drizzle（类型安全 ORM） 迁移执行、文件系统写入或网络 I/O（输入输出）。

**上下文说明**:
1. `T-008` 已稳定 `conversation`（对话） / `workers`（工作线程） 的路由、队列与中断桥接骨架；当前主线最接近的结构缺口转为“这些模块未来从哪里拿 PG（关系型数据库） / Redis（缓存） / 日志目录 / 环境变量配置”。
2. `01_ARCHITECTURE.md` 已明确 `db/`（数据库） 与 `data/`（数据） 的职责分离：`db/` 负责 Drizzle schema（模式）、migrations（迁移） 与 PG（关系型数据库） 连接池，`data/` 负责资源画像、词汇映射与 `config`（配置）；模块间只能通过类型接口通信，不能在业务模块中散落连接常量或环境变量名。
3. `05_DATA_SPEC.md` 已定义 PG（关系型数据库） schema（模式）、Redis（缓存） key（键） 约定、BullMQ（队列） key pattern（键模式）、冷热日志目录、写入顺序、migration（迁移） 目录结构与环境变量清单。本任务应把这些规则沉淀为可测试的纯类型 / 纯函数边界，而不是直接创建连接、迁移执行器或真实缓存实例。
4. 仓库长期约束已经明确：TS Core（TypeScript 单核心） 默认使用 PostgreSQL（关系型数据库） 作为业务真理源；本地 `ts-core`（主线工程） 后续通过环境变量或本地配置接入实际部署拓扑，不能把主机名、端口、日志路径或 tunnel（隧道） 语义硬编码到实现中。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 与 `Redis`（缓存） / `PostgreSQL`（关系型数据库） / `JSONL`（结构化日志） / `db`（数据库） / `data`（数据） 相关段落，第 15 节《模块划分》、第 16 节《目录结构》、第 18 节《Phase 1 范围》、第 19 节《技术栈速查表》
2. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》、第 2.1-2.4 节《PostgreSQL Schema 设计》、第 4.1 节《目录结构》、第 5 节《冷热分离策略》、第 8 节《Redis 数据约定》、第 9 节《数据一致性约定》、第 10.1 节《Drizzle Migration》、第 12 节《配置参数速查》、第 13 节《后续文档依赖》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/src/index.ts` — 全文件
6. `ts-core/src/domain/contracts.ts` — 全文件
7. `ts-core/src/runtime/contracts.ts` — 全文件
8. `ts-core/src/workers/queues.ts` — 全文件
9. `ts-core/src/data/index.ts` — 全文件
10. `ts-core/src/data/contracts.ts` — 全文件
11. `ts-core/src/data/logs.ts` — 全文件
12. `ts-core/src/data/schema.ts` — 全文件
13. `ts-core/src/diagnostics/contracts.ts` — 全文件
14. `ts-core/src/db/index.ts` — 全文件（允许新建）
15. `ts-core/src/db/contracts.ts` — 全文件（允许新建）
16. `ts-core/src/db/keys.ts` — 全文件（允许新建）
17. `ts-core/src/db/connection.ts` — 全文件（允许新建）
18. `ts-core/src/db/migrations.ts` — 全文件（允许新建）
19. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
20. `ts-core/src/__tests__/data-model.spec.ts` — 全文件
21. `ts-core/src/__tests__/db-config-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `db`（数据库） 模块中至少拆清四类边界：PostgreSQL（关系型数据库） 连接参数 / schema（模式） / extension（扩展） 元信息、Redis（缓存） key（键） 命名规则、状态缓存结构、migration（迁移） 目录与入口元信息；不得接入真实 `pg`（驱动）、`ioredis`（缓存驱动）、Drizzle（类型安全 ORM） 客户端或迁移执行器。
2. `config`（配置） 语义必须集中建模，而不是在多个模块散落硬编码环境变量名。至少要收口 PG（关系型数据库）、Redis（缓存）、日志目录、保留期、Embedding（向量） 维度等默认值 / 环境变量名，并允许对 `bots.config`（机器人配置覆盖） 做纯函数 overlay（覆盖合并）；不得直接把自由 `Record<string, unknown>`（任意键值对象） 作为运行时可消费配置向外暴露。
3. Redis（缓存） / BullMQ（队列） key（键） 规则必须与 `workers/queues.ts`（工作线程队列命名） 和 `05_DATA_SPEC.md`（数据规范） 对齐，不得再造平行命名集合；例如 `bot:{botId}:intent_epoch`、`bot:{botId}:state` 与 `bull:msg:{botId}:*` / `bull:bot:{botId}:exec:*` / `bull:brain:*` 的关系应能从类型或纯函数边界中直接读出。
4. 日志目录与保留期契约必须与现有 `data/logs.ts`（数据日志规则） / `diagnostics`（诊断） 对齐；若文档中的环境变量别名与现有常量存在历史差异，必须通过显式别名映射统一收口，不能继续扩散魔法字符串。
5. 测试优先覆盖：根导出、PG（关系型数据库） / Redis（缓存） / migration（迁移） 元信息、环境变量默认值与别名归一化、Bot 级配置 overlay（覆盖合并）、Redis key（键） 命名与状态缓存、负向校验；不要写依赖真实数据库、真实 Redis（缓存）、文件系统或网络的测试。

**验收标准**:
1. `db`（数据库） 模块已落地并接入 `src/`（源代码） 根导出，职责边界与 `01_ARCHITECTURE.md`（架构文档） 中的 `db/`（数据库） 定位一致。
2. PostgreSQL（关系型数据库） 连接参数、扩展名、migration（迁移） 元信息、Redis（缓存） key（键） 规则与状态缓存结构均具备强类型模型或纯函数构造边界。
3. 环境变量默认值、别名映射、日志根目录 / 保留期与 Bot 级配置 overlay（覆盖合并） 已集中收口，不存在多模块平行魔法字符串与自由配置对象外泄。
4. Redis（缓存） / BullMQ（队列） 键命名与现有 `workers`（工作线程） 队列命名、`data`（数据） / `diagnostics`（诊断） 日志契约保持一致，不引入真实连接器或跨模块实现耦合。
5. 新增测试覆盖根导出、PG（关系型数据库） / Redis（缓存） / migration（迁移） 元信息、配置归一化、Bot 级配置覆盖、负向校验，且执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-009`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实 PostgreSQL（关系型数据库） / Redis（缓存） 客户端、迁移执行器、文件系统写入或网络 I/O（输入输出）
- [ ] PG（关系型数据库） / Redis（缓存） / JSONL（结构化日志） / 环境变量名已集中收口，无平行魔法字符串集合
- [ ] Redis（缓存） / BullMQ（队列） 键命名与 `workers/queues.ts`（工作线程队列） 和 `05_DATA_SPEC.md`（数据规范） 对齐
- [ ] Bot 级 `config`（配置） overlay（覆盖合并） 已收口为纯函数边界，未向外暴露自由配置对象
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: `T-009`
- **修改文件**:
  - （待 Coder 填写）
- **执行摘要**:
  - （待 Coder 填写）
- **自检结果**:
  - [ ] 任务序号核对为 `T-009`
  - [ ] 仅读取并修改白名单内文件
  - [ ] 新增导出符号均补充中文文档注释
  - [ ] 未引入真实 PostgreSQL（关系型数据库） / Redis（缓存） 客户端、迁移执行器、文件系统写入或网络 I/O（输入输出）
  - [ ] PG（关系型数据库） / Redis（缓存） / JSONL（结构化日志） / 环境变量名已集中收口，无平行魔法字符串集合
  - [ ] Redis（缓存） / BullMQ（队列） 键命名与 `workers/queues.ts`（工作线程队列） 和 `05_DATA_SPEC.md`（数据规范） 对齐
  - [ ] Bot 级 `config`（配置） overlay（覆盖合并） 已收口为纯函数边界，未向外暴露自由配置对象
  - [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过
- **预检输出摘要**:
  - （待 Coder 填写）
- **遗留疑问**:
  - （待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-010: 建立本地应用装配与首轮无 MC（Minecraft） 冒烟闭环骨架，串起 `interfaces`（接口层）、`workers`（工作线程）、`runtime`（运行时）、`db`（数据库） 与 `sandbox`（沙箱） 的启动边界。
- T-011: 建立 `game-chat`（游戏聊天适配） / `server-bridge`（服务端桥接） 的最小 ingress（入口） 契约，收口网页与游戏双端消息进入主线的统一包结构。
- T-012: 建立首轮 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 的无 MC（Minecraft） 事件闭环模型，补齐 accepted / started / terminal（接受 / 开始 / 终态） 的最小装配约束。
