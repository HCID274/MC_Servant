# Repository Guidelines

## 0. Agent 入口与协作工作流

本仓库采用三角色 Agent 协作开发机制（Manager / Coder / Consultant）。

**所有 AI Agent 进入仓库后，必须先读 `ts-core/agent.md`（索引入口），再按角色执行对应工作流。**

| 文件 | 用途 |
|---|---|
| `ts-core/agent.md` | Agent 协作索引入口（三角色共同起点） |
| `ts-core/Docs/09_AGENT_WORKFLOW.md` | 工作流完整规范：角色定义、职责边界、状态流转、Prompt 模板 |
| `ts-core/Docs/WF_当前任务握手.md` | 当前活跃任务（Manager 写 / Coder 读+填反馈） |
| `ts-core/Docs/WF_开发进度记录.md` | 当前批次的详细进度记录（仅 Manager 写入） |
| `ts-core/Docs/WF_任务阶段压缩记录.md` | 已完成批次的压缩归档（仅 Manager 写入，默认优先读取） |
| `ts-core/Docs/WF_开发进度明细归档/` | 已完成批次的详细明细归档（仅 Manager 写入，按需展开） |
| `ts-core/Docs/WF_需求变更索引.md` | 需求变更摘要（Consultant 追加 / Manager 读取） |

如果你不是以特定角色启动的（即没有收到 Manager/Coder/Consultant 的 Prompt），仍然必须遵守本文件中的所有约束。

### 0.1 任务切分与排序规则

- 任务切分继续遵循**按模块批量下发**：优先圈定 2-4 个相邻模块，避免把一个模块拆成大量步骤级碎任务。
- 当核心主干已经具备较完整的纯契约 / 纯函数骨架后，后续任务排序必须切换为**MVP（最小可运行闭环） 关键路径优先**，优先推进真实 I/O（输入输出） 接入与可运行 demo（演示）：
  1. PostgreSQL（关系型数据库） / Redis（缓存） 真实连接与迁移
  2. BullMQ（任务队列） / Fastify（接口网关） 真实启动
  3. Mineflayer（Minecraft 协议客户端） / observation（观测） / BotActor（机器人执行代理） 最小上线闭环
  4. ConversationWorker（对话工作线程） / BotWorker（机器人工作线程） / sandbox（沙箱） 真实执行链路
  5. 端到端联调与可运行 demo（演示）
- BrainWorker（摘要工作线程） 增强契约、部署文档补写、纯诊断占位等**不在“bot 先跑起来”关键路径上的任务**，默认后移到可运行链路打通之后。
- 若当前活跃任务尚未完成，但因新优先级需要重排，允许**保持原任务序号不变**并重写该任务的目标、白名单、验收标准与队列预览；**已完成任务不得改号、不得重排历史顺序**。

---

## 1. 当前路线

- 当前路线为"路线 A：旧项目保留为参考库，同级目录新开 `ts-core/` 做 TS 单核心重构"。
- 未经用户明确要求，不在本仓旧系统上继续推进新架构，不把旧 `backend/` 当成未来主线实现。
- 新实现默认落在 `ts-core/`；旧 `backend/`、`plugin/` 仅作为参考库、维护对象或兼容对象，不作为默认开发落点。
- 旧设计文档已归档到 `backend/Docs/`，作为历史资料，与后续新设计文档区分。
- TS Core 相关的迁移导航与沉淀文档，统一放在 `docs/legacy-*.md`。

## 2. 用户强约束

- 若输入存在模棱两可、关键约束缺失，或会影响目录结构、外部接口、协议、数据格式、执行语义、范围边界，我不得自行补全后直接编码，必须先向用户确认。
- 当需求或架构方向存在关键不确定性时，我必须先给出两个当前更优、且强调高内聚低耦合的候选方案；每个方案只列核心优点、核心缺点与适用前提，再由用户选择后继续实现。
- 若约束不足但风险确实很低，才允许按最小假设推进，并在结果中明确假设。
- 我在回复里只要使用英文名词，后面必须紧跟中文释义，不得只写英文。
- 若与用户达成新的长期共识，我需要主动把具体架构内容写入对应文档；若该共识属于长期协作规则，还需要同步更新 `AGENTS.md`。
- `ts-core` 新主线默认使用 PostgreSQL 作为主持久化，不再把 SQLite 作为新后端业务主库。
- 当前默认部署拓扑为：`Paper + plugin + ts-core` 先运行在本地 Windows；阿里云只承载入口层、隧道服务端与 PostgreSQL。
- 本地 `Paper` 与本地 `ts-core` 后续默认通过安全隧道访问云上 PostgreSQL，而不是把数据库继续留在本地。

## 3. Minecraft 事实来源约束

- 禁止在代码或 prompt 中写死 Minecraft 领域事实数据，如配方、掉落、工具等级、方块组、运行时规则。
- Minecraft 任务事实真源优先使用 `mineflayer`、`minecraft-data` 与实时环境快照。
- 未经用户明确允许，禁止回退到自维护知识库 JSON 作为主规划依据。
- 中文用户输入到标准英文目标 id 的词汇映射可以维护在数据文件中，但只负责"中文 -> 标准 id"翻译，不能承载配方、掉落、工具等级等事实规则。

## 4. Legacy 索引工作流

- 需要参考旧项目实现时，先从 `docs/legacy-migration-index.md` 找到专题文档与目标条目。
- 再按专题查看：
  - `docs/legacy-runtime-index.md`
  - `docs/legacy-skills-index.md`
  - `docs/legacy-observation-index.md`
  - `docs/legacy-world-model-index.md`
  - `docs/legacy-trace-index.md`
  - `docs/legacy-bridge-pitfalls.md`
  - `docs/legacy-data-index.md`
- `backend/Docs/legacy-*.md` 仅保留为历史副本，不再作为 TS Core 的主导航入口。
- 后续 AI 或人工在写 TS Core 前，必须先读索引，再决定是否真的需要下钻到旧文件或旧函数；不要默认重新全仓扫描旧代码。
- 若索引已覆盖目标模块，优先按索引中的这些字段精确查看：`legacy_path`、`migration_symbols`、`ts_target`、`do_not_copy`、`notes`。
- 若条目标记为 `DROP` 或 `migration_fit: drop`，只能把它当反例，不得照搬。
- 若条目标记为 `phase: phase2` 或 `phase: drop`，Phase 1 内默认不实现，除非用户明确改变范围。
- 若发现索引缺口，应先补 `docs/legacy-*.md`，再继续写代码，避免未来重复扫描旧仓。

## 5. ts-core 工具链与工程基线

- `ts-core/` 是新的主线工程，默认使用 `pnpm` 作为包管理器。
- 在 `ts-core/package.json` 中固定 `packageManager` 字段；优先使用 Corepack 管理包管理器版本。
- 若 `ts-core` 仍为单包工程，则暂不引入 workspace；只有当仓库内出现多个 TS 包时，才新增 `pnpm-workspace.yaml`。
- `ts-core` 使用 TypeScript，默认启用严格类型检查。
- Node 运行时项目优先使用 `module: "NodeNext"` 与 `moduleResolution: "NodeNext"`。
- 代码格式化与 lint 默认使用 `Biome`；未经用户明确要求，不额外引入沉重或重复的前端工具链。
- `ts-core` 默认使用 `Vitest` 作为单元测试与轻量集成测试框架；具体测试脚本与约定优先维护在 `ts-core/README.md` 或局部测试文档中。
- `ts-core` 的依赖、脚本、编译配置统一放在 `package.json`、`tsconfig.json`、`biome.json` 或 `biome.jsonc` 中，不把工具链约束散落到其他文档。
- 未经用户明确允许，不为小项目提前引入 monorepo orchestration、复杂 bundler、过度代码生成或非必要脚手架。

## 6. 目录约束

- 新实现统一放在同级目录 `ts-core/`，不在旧 `backend/` 内继续长出新架构。
- Phase 1 推荐目录：
  - `ts-core/src/runtime/`
  - `ts-core/src/skills/`
  - `ts-core/src/observation/`
  - `ts-core/src/world-model/`
  - `ts-core/src/diagnostics/`
  - `ts-core/src/domain/`
  - `ts-core/src/data/`
- `docs/legacy-*.md` 继续作为旧代码迁移索引；`ts-core` 内不重复堆旧系统说明。
- 若索引足够覆盖目标模块，优先按索引实现；不要默认回旧仓大面积扫描。

## 7. 仓库结构认知

- `ts-core/`：新 TypeScript 单核心工程；当前主线开发默认落点。
  - `ts-core/agent.md`：Agent 协作索引入口。
  - `ts-core/Docs/`：设计文档（01-09）+ 工作流动态文件（WF_*）。
  - `ts-core/scripts/`：工具脚本（pre_review.sh 等）。
  - `ts-core/src/`：源代码（Coder 工作区）。
- `backend/`：旧 Python FastAPI + Mineflayer 适配层；当前定位为参考库与维护对象，不是未来主线架构。
- `plugin/`：Java Paper/Spigot 插件。
- `scripts/`：工具脚本。
- `docs/`：迁移索引（`legacy-*.md`）。
- 根入口：`README.md`、历史启动脚本与项目说明文件。

## 8. 常用命令

### ts-core（主线）
- 安装依赖：`cd ts-core && pnpm install`
- 类型检查：`cd ts-core && pnpm typecheck`
- 测试：`cd ts-core && pnpm test`
- 测试监听：`cd ts-core && pnpm test:watch`
- lint：`cd ts-core && pnpm lint`
- format：`cd ts-core && pnpm format`
- 开发：`cd ts-core && pnpm dev`
- 构建：`cd ts-core && pnpm build`
- 预检（Coder 自检）：`bash ts-core/scripts/pre_review.sh`

### 旧 backend（仅维护）
- 安装依赖：
  - `cd backend && pip install -r requirements.txt`
  - `cd backend && npm install`
- 运行：
  - `.\start.bat`
  - `cd backend && python main.py`
- 测试：
  - `cd backend && pytest -q`

### plugin
- 构建：`cd plugin && .\mvnw.cmd clean package -DskipTests`

## 9. 编码规范

### 编辑 ts-core 时（主线）
- 使用 TypeScript，不写新的纯 JavaScript 业务模块，除非第三方工具脚本确有必要。
- 优先使用 `type` / `interface` 明确边界，避免滥用 `any`。
- 类型、类使用 `PascalCase`，变量、函数使用 `camelCase`。
- 模块职责单一，禁止新增 god file。
- 能做纯函数的模块优先纯函数化，尤其是 `world-model`、`summary-input`、`domain`。
- `ts-core` 代码默认要求中文文档注释：每个导出的类、函数、接口、类型都应有中文注释；关键状态流转、协议转换、并发门控和异常分支应有中文块注释解释原因与边界。

### 编辑旧 Python 代码时
- 保持现有 type-hinted 风格。
- 使用 4 空格缩进。
- 命名遵循 `snake_case` / `PascalCase`。
- 注释和文档字符串以中文为主，保持一致。

### 编辑旧 Java 代码时
- 保持标准 4 空格缩进。
- 命名遵循 `camelCase` / `PascalCase`。

## 10. TypeScript 配置规则

- `ts-core` 默认启用严格模式 `strict`。
- Node 运行时项目优先采用 `module: "NodeNext"` 与 `moduleResolution: "NodeNext"`。
- 若未来改成 bundler-first 架构，再单独评估是否切换配置；未经用户明确确认，不擅自切换。

## 11. 文档规则

- **设计文档**统一维护在 `ts-core/Docs/`（01-09 系列），由 `ts-core/Docs/00_目录.md` 提供总索引。
- **迁移索引**统一维护在 `docs/legacy-*.md`。
- **工作流动态文件**统一维护在 `ts-core/Docs/WF_*.md`。
- `AGENTS.md` 只保留约束、工作流路由、范围线、禁止事项与文档索引；不要继续堆积阶段性实现细节。
- 不把具体架构设计细节直接堆进 `AGENTS.md`；架构设计落在 `ts-core/Docs/01-08` 系列中。
- 旧 `backend/Docs/` 保留为历史资料，不再作为 TS Core 的主实现导航入口。
- 旧 `docs/architecture-*.md` 已被 `ts-core/Docs/01-08` 系列取代，仅保留为历史参考。
- `ts-core` 自身的运行说明、脚本说明、模块说明，优先放在 `ts-core/README.md` 或其局部文档中，不反向堆回 `AGENTS.md`。
- `ts-core/Docs/WF_开发进度记录.md` 只保留当前批次（每 10 个任务一批）的详细记录，避免后续协作默认读取过长历史。
- 一个批次完成后，由 Manager 将该批次：
  1. 压缩写入 `ts-core/Docs/WF_任务阶段压缩记录.md`
  2. 详细明细迁入 `ts-core/Docs/WF_开发进度明细归档/`
  3. 再将 `ts-core/Docs/WF_开发进度记录.md` 重置为下一批次的空白详细账本
- 历史上下文默认先读压缩记录；只有需要追具体实现细节时，才按需读取 `WF_开发进度明细归档/` 中对应批次文件。

## 12. 安全与配置

- 不要提交真实密钥、访问令牌或数据库密码。
- 使用本地 `.env` 或配置文件，保持 plugin 与 backend 的通信配置一致。
- 新增 `ts-core` 配置时，优先通过环境变量或本地配置文件注入，不把敏感配置硬写进源码或 prompt。

## 13. 额外约束

- 不要把阶段性实现细节重新堆进 `AGENTS.md` 或旧 `backend/Docs/`。
- 不要把项目总纲与仓库执行规范混写；项目架构和目标看 `ts-core/Docs/` 设计文档，仓库操作规则看 `AGENTS.md`。
