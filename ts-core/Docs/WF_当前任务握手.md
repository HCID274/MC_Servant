# 当前任务握手区

【任务序号】: T-001
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `ts-core` 主线工程的配置基线、目录骨架与模块入口，占稳后续运行时、数据层与观察层的开发边界。

**上下文说明**:
1. 当前 `ts-core/` 仅有文档与预检脚本，尚未形成可执行工程。
2. 本任务只做工程骨架，不写 Bot 业务逻辑、不接旧系统桥接、不补充 Phase 1 范围外能力。
3. 所有新建导出符号必须带中文文档注释，且不得写死任何 Minecraft 事实数据。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》、第 2 节《七层技术架构》、第 3.1 节《队列划分》、第 3.4 节《Phase 1 部署模型》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》、第 2.1 节《状态枚举》、第 3.1 节《InterruptSignal 类型定义》
3. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 1 节《沙箱的核心定位》、第 2.3 节《Isolate 池管理》、第 4.1 节《顶层结构》
4. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》、第 2.2 节《调用流程》、第 5.1 节《输出格式选择：skill_call 优先》
5. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》、第 2.1 节《Schema 隔离》、第 2.3 节《全表一览》
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/package.json` — 全文件（允许新建）
8. `ts-core/tsconfig.json` — 全文件（允许新建）
9. `ts-core/biome.json` — 全文件（允许新建）
10. `ts-core/vitest.config.ts` — 全文件（允许新建）
11. `ts-core/README.md` — 全文件（允许新建）
12. `ts-core/src/index.ts` — 全文件（允许新建）
13. `ts-core/src/runtime/index.ts` — 全文件（允许新建）
14. `ts-core/src/runtime/contracts.ts` — 全文件（允许新建）
15. `ts-core/src/skills/index.ts` — 全文件（允许新建）
16. `ts-core/src/observation/index.ts` — 全文件（允许新建）
17. `ts-core/src/world-model/index.ts` — 全文件（允许新建）
18. `ts-core/src/diagnostics/index.ts` — 全文件（允许新建）
19. `ts-core/src/domain/index.ts` — 全文件（允许新建）
20. `ts-core/src/domain/contracts.ts` — 全文件（允许新建）
21. `ts-core/src/data/index.ts` — 全文件（允许新建）
22. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 建立 `pnpm` 工程基线：`package.json` 必须固定 `packageManager`，脚本至少覆盖 `dev`、`build`、`typecheck`、`lint`、`format`、`test`，并与 `pre_review.sh` 调用保持一致。
2. 建立严格类型配置：`tsconfig.json` 必须启用 `strict`、`module: "NodeNext"`、`moduleResolution: "NodeNext"`，并让 `src/` 与测试文件可被类型检查。
3. 建立最小可维护目录骨架：只创建本任务白名单中的模块入口与契约文件，用类型、枚举、接口、占位工厂或占位清单表达模块边界，不实现真实运行时、数据库、网络或 Mineflayer 行为。
4. `runtime/contracts.ts` 与 `domain/contracts.ts` 需要沉淀后续高频复用的基础契约，至少覆盖 Bot 状态、任务类型、消息来源、事件日志基础结构、中断信号等核心边界；命名需与白名单文档保持一致，不得自造冲突概念。
5. 测试只允许做工程骨架级验证，例如入口导出、关键枚举或模块清单存在性；不要写假业务流程测试，不要引入额外沉重依赖。

**验收标准**:
1. `ts-core/` 形成可安装、可类型检查、可 lint、可测试的最小 TypeScript 工程骨架，且 `pre_review.sh` 所需脚本全部存在。
2. `src/` 下出现 `runtime`、`skills`、`observation`、`world-model`、`diagnostics`、`domain`、`data` 七个模块目录及其入口文件，入口导出关系清晰。
3. 基础契约文件中已定义后续可直接复用的核心类型，且导出符号均附中文文档注释。
4. 未修改白名单外文件，未引入旧 `backend/` 或 `plugin/` 的实现耦合，未写入任何 Minecraft 配方、掉落、工具等级等事实常量。
5. `ts-core/src/__tests__/scaffold.spec.ts` 能验证工程骨架的关键导出或模块结构，而不是空测试。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-001`
- [ ] 仅读取并修改白名单内文件
- [ ] 新建导出符号均补充中文文档注释
- [ ] 未实现业务逻辑，仅落工程骨架与基础契约
- [ ] 未写死任何 Minecraft 事实数据
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- **问题定位**: （文件名、函数名或行号）
- **期望行为**: （具体说明应该怎么改）
- **修改范围**: （明确只需改哪些地方）
- **历史反馈保留**: 是/否

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-001
- **修改文件**: （列表）
- **执行摘要**: （简述做了什么）
- **自检结果**: （逐项勾选）
- **预检输出摘要**: （粘贴脚本关键输出）
- **遗留疑问**: （如有）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-002: 建立 `runtime` 与 `domain` 的执行态模型，补齐 BotActor 状态流转、任务载荷与事件类型映射。
- T-003: 建立 `data` 模块的 PostgreSQL/日志边界，沉淀 schema 常量、表结构定义与日志引用抽象。
- T-004: 建立 `observation` 与 `world-model` 的只读快照骨架，明确双数据源融合与威胁评估输入输出。
