# 当前任务握手区

【任务序号】: T-003
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `data` 模块的持久化契约层，沉淀 PostgreSQL（关系型数据库）核心表结构、`event_log`/`task_history` 对齐映射、`log_ref`/`code_ref` 相对路径规则与 JSONL（逐行 JSON 日志）目录抽象，为后续接入真实连接与迁移脚本提供稳定边界。

**上下文说明**:
1. `T-002` 已完成 `runtime`/`domain` 的执行态模型，本任务要把这些运行时契约落到持久化表达层，但仍然不接入真实 PostgreSQL、文件系统写入或 migration（迁移）执行。
2. 设计文档要求 PostgreSQL 是唯一业务真理源，`event_log` 是 append-only（只追加）事件流，JSONL 是冷日志，二者通过 `log_ref` 等相对路径指针衔接。
3. 当前工程还没有 `Drizzle ORM（轻量 SQL 生成器）` 依赖与数据模块细分文件；本任务允许在最小范围内补齐依赖与纯 schema（模式）定义出口。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》、第 8.2 节《append-only Event Log》、第 13 节《日志存储与冷热分离》、第 14 节《数据与持久化边界》
2. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》、第 2 节《PostgreSQL Schema 设计》、第 4.1 节《目录结构》、第 4.5 节《日志写入实现》、第 5 节《冷热分离策略》、第 6 节《event_log 查询模式》、第 9 节《数据一致性约定》、第 10.1 节《Drizzle Migration》、第 12 节《配置参数速查》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/package.json` — 全文件
6. `ts-core/pnpm-lock.yaml` — 全文件（允许新建）
7. `ts-core/src/index.ts` — 全文件
8. `ts-core/src/domain/contracts.ts` — 全文件
9. `ts-core/src/runtime/events.ts` — 全文件
10. `ts-core/src/runtime/tasking.ts` — 全文件
11. `ts-core/src/data/index.ts` — 全文件
12. `ts-core/src/data/contracts.ts` — 全文件（允许新建）
13. `ts-core/src/data/schema.ts` — 全文件（允许新建）
14. `ts-core/src/data/logs.ts` — 全文件（允许新建）
15. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
16. `ts-core/src/__tests__/data-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `data` 模块中拆清三类概念：表结构契约、日志引用/目录规则、模块边界导出；不要把真实连接池、查询函数或文件写入逻辑混进来。
2. 用 `Drizzle ORM（轻量 SQL 生成器）` 或等价的类型安全 schema 表达方式，明确表示 `mc_servant` 下的核心表与关键字段，至少覆盖 `bots`、`owner_bots`、`sessions`、`chat_messages`、`event_log`、`task_history`、`task_summaries`、`session_summaries`。
3. `event_log` 与 `task_history` 的类型边界必须对齐现有 `runtime`/`domain` 契约：事件类型复用运行时事件常量，任务状态与任务类型复用现有枚举，不得再发明平行字符串集。
4. 抽出 `log_ref`、`code_ref`、JSONL 目录分类与保留期常量；规则必须体现“只保存相对路径、不允许绝对路径或向上跳目录”的约束，但保持为纯函数/纯常量。
5. 测试优先覆盖 schema 关键字段、事件/状态对齐、相对路径校验与冷热分层常量；不要写依赖真实 PostgreSQL 或文件系统的测试。

**验收标准**:
1. `data` 模块新增内容均为纯类型、纯函数、schema 定义或常量映射；没有真实 PostgreSQL 连接、查询执行、迁移执行或文件写入代码。
2. `mc_servant` 核心表与关键索引/约束在代码中有可读出口，且 `event_log`、`task_history` 的事件类型/状态类型直接复用现有契约。
3. `log_ref`/`code_ref` 规则被集中表达，并且测试覆盖至少一个合法相对路径和两个非法路径（绝对路径、`..` 跳目录）场景。
4. `data/index.ts` 的占位导出说明已升级为真实持久化契约出口，不再停留在 `createDataPlaceholder` 骨架。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过，且测试文件中包含针对 `data` 模块的新断言。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-003`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实 PostgreSQL 连接、迁移执行或文件系统写入
- [ ] 事件类型、任务状态与路径规则均对齐白名单文档
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- **问题定位**: （文件名、函数名或行号）
- **期望行为**: （具体说明应该怎么改）
- **修改范围**: （明确只需改哪些地方）
- **历史反馈保留**: 是/否

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-003
- **修改文件**: （列表）
- **执行摘要**: （简述做了什么）
- **自检结果**: （逐项勾选）
- **预检输出摘要**: （粘贴脚本关键输出）
- **遗留疑问**: （如有）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-004: 建立 `observation` 与 `world-model` 的只读快照模型，补齐双数据源融合、威胁评估输入输出与快照边界。
- T-005: 建立 `skills` 模块的 Phase 1 技能目录与 `skill_call` 参数契约，连接执行任务模型与后续沙箱/技能分派边界。
- T-006: 建立 `interfaces`/会话边界的最小契约，补齐 `sessions`、鉴权入口与 `event_log` 断线补拉所需类型出口。
