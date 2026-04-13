# 当前任务握手区

【任务序号】: T-003
【当前状态】: 待审查

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
- [x] 任务序号核对为 `T-003`
- [x] 仅读取并修改白名单内文件
- [x] 新增导出符号均补充中文文档注释
- [x] 未引入真实 PostgreSQL 连接、迁移执行或文件系统写入
- [x] 事件类型、任务状态与路径规则均对齐白名单文档
- [x] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- **问题定位**:
  - `ts-core/src/data/logs.ts:87` 的 `createDatedStorageRef()` 先用 `path.join()` 归一化，再做整串校验；当 `fileName` 或 `date` 带 `..` 时，会被静默折叠成别的合法路径，例如 `../escape.jsonl` 会变成 `tasks/escape.jsonl`。
  - `ts-core/src/data/schema.ts:92` 的 `idx_sessions_token` 没按 `05_DATA_SPEC.md:144` 做 `WHERE expires_at > now()` 的部分索引，只保留了普通索引。
  - `ts-core/src/data/schema.ts:168-203` 只声明了 `task_summaries` / `session_summaries` 的时间索引，缺失 `05_DATA_SPEC.md:259-304` 要求的 `summary_tsv` 生成列、全文索引与向量索引。
- **期望行为**:
  - `createDatedStorageRef()` 必须对输入片段本身做约束，显式拒绝绝对路径、反斜杠、空片段和 `..` 跳目录；不能依赖 `join()` 归一化后的结果来“掩盖”非法输入。测试要补一个 `fileName` 或 `date` 含 `..` 的回归用例。
  - `sessions` 表的 token 索引要与文档一致，明确表达“仅对未过期 session 生效”的部分索引语义，而不是降级成普通索引。
  - `task_summaries` / `session_summaries` 要把检索边界补完整：至少暴露 `summary_tsv` 生成列，以及全文索引、向量索引这两类关键索引；测试要覆盖这些出口确实存在。
- **修改范围**:
  - 只需修改 `ts-core/src/data/logs.ts`
  - 只需修改 `ts-core/src/data/schema.ts`
  - 只需修改 `ts-core/src/__tests__/data-model.spec.ts`
- **历史反馈保留**: 是

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-003
- **修改文件**:
  - `ts-core/package.json`
  - `ts-core/pnpm-lock.yaml`
  - `ts-core/src/data/index.ts`
  - `ts-core/src/data/contracts.ts`
  - `ts-core/src/data/schema.ts`
  - `ts-core/src/data/logs.ts`
  - `ts-core/src/__tests__/data-model.spec.ts`
- **执行摘要**:
  - 修正 `createDatedStorageRef()`：先对 `date` / `fileName` 片段本身做校验，显式拒绝绝对路径、反斜杠、空片段与 `..` 跳目录，避免 `path.join()` 归一化掩盖非法输入。
  - 调整 `schema.ts` 的高级契约出口：移除误导性的普通 `idx_sessions_token`，改为显式导出带 `WHERE expires_at > now()` 的部分索引契约。
  - 为 `task_summaries` / `session_summaries` 补充 `summary_tsv` 生成列契约，以及全文检索 / 向量检索索引契约，保持后续 `brain（摘要检索）` 层依赖边界稳定。
  - 扩充 `data-model.spec.ts`，新增路径逃逸回归用例，并校验部分索引、生成列与检索索引出口存在。
- **自检结果**:
  - [x] 任务序号核对为 `T-003`
  - [x] 仅读取并修改白名单内文件
  - [x] 新增导出符号均补充中文文档注释
  - [x] 未引入真实 PostgreSQL 连接、迁移执行或文件系统写入
  - [x] 事件类型、任务状态与路径规则均对齐白名单文档
  - [x] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过
- **预检输出摘要**:
  - `TypeScript typecheck` 通过
  - `Biome lint` 通过（Checked 23 files, no fixes applied）
  - `Vitest` 通过（3 个测试文件，12 个测试全部通过）
  - 脚本结束输出：`===== 预检全部通过 =====`
- **遗留疑问**: 无

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-004: 建立 `observation` 与 `world-model` 的只读快照模型，补齐双数据源融合、威胁评估输入输出与快照边界。
- T-005: 建立 `skills` 模块的 Phase 1 技能目录与 `skill_call` 参数契约，连接执行任务模型与后续沙箱/技能分派边界。
- T-006: 建立 `interfaces`/会话边界的最小契约，补齐 `sessions`、鉴权入口与 `event_log` 断线补拉所需类型出口。
