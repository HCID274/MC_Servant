# Repository Guidelines

## 0. Agent 协作

本仓库采用三角色 Agent 协作:**Planner A / Coder B / Reviewer C**。

入口:`ts-core/agent.md`
工作流:`ts-core/Docs/WORKFLOW.md`(角色定义、信息流、Prompts)
工程规范:`ts-core/Docs/ENGINEERING_PRINCIPLES.md`(B 自检 + C 审查共同标准)
进度:`ts-core/Docs/PROGRESS.md`(C 通过后追加)

如果你不是以特定角色启动的,仍必须遵守本文件中的所有约束。

## 1. 当前路线

- 路线 A:旧项目保留为参考库,同级目录新开 `ts-core/` 做 TS 单核心重构
- 新实现默认落在 `ts-core/`;旧 `backend/`、`plugin/` 仅作为参考库或维护对象
- 迁移导航统一放在 `docs/legacy-*.md`

## 2. 用户强约束

- 输入存在模棱两可、关键约束缺失,或会影响目录结构 / 外部接口 / 协议 / 数据格式 / 执行语义 / 范围边界时,**不得自行补全后直接编码**,必须先向用户确认
- 需求或架构方向有关键不确定性时,先给两个候选方案(各列核心优劣与适用前提),由用户选择
- 回复中使用英文名词后必须紧跟中文释义
- 与用户达成新的长期共识时,主动写入对应文档;协作规则同步更新本文件
- `ts-core` 默认使用 PostgreSQL 作为主持久化
- 默认部署拓扑:`Paper + plugin + ts-core` 在本地 Windows;阿里云只承载入口层、隧道服务端与 PostgreSQL
- 本地 ts-core 通过安全隧道访问云上 PostgreSQL,不把数据库留在本地

## 3. Minecraft 事实来源

- 禁止在代码或 prompt 中写死 MC 领域事实(配方、掉落、工具等级、方块组、运行时规则)
- 事实真源:`mineflayer` + `minecraft-data` + 实时环境快照
- 中文输入到标准英文 id 的词汇映射可维护在数据文件中,但只负责翻译,不承载事实规则

## 4. Legacy 索引工作流

- 先从 `docs/legacy-migration-index.md` 入手
- 按专题查 `docs/legacy-*-index.md`(runtime / skills / observation / world-model / trace / data / bridge-pitfalls)
- 标记为 `DROP` / `migration_fit: drop` 的条目仅作反例,不照搬
- 标记为 `phase: phase2` / `phase: drop` 的条目 Phase 1 默认不实现
- 索引缺口先补索引,再写代码;不要默认全仓扫描旧代码
- `backend/Docs/legacy-*.md` 仅为历史副本,不再作为主导航

## 5. ts-core 工具链基线

- 包管理:`pnpm`(Corepack 管理版本)
- 类型:TypeScript strict + `module/moduleResolution: NodeNext`
- 格式与 lint:`Biome`
- 测试:`Vitest`
- 配置统一在 `package.json` / `tsconfig.json` / `biome.json`,不散落到其他文档
- 单包工程暂不引入 workspace
- 未经用户允许,不引入 monorepo orchestration、复杂 bundler、过度脚手架

## 6. 真实 LLM API 验收

凡触碰 LLM 调用、Prompt、对话路由或在线入口装配的任务:

- 验收必须包含一次真实 OpenAI 兼容 API 调用,不能只靠 mock
- 默认本地网关:`base_url=http://127.0.0.1:8045/v1` / `api_key=sk-local-dev` / `model=bl-auto`(生产密钥不入仓)
- Coder 环境可达 → 跑真实调用,记录命令、输入摘要、关键输出与判断
- Coder 环境不可达 → 提供最短人工手测步骤;Reviewer 等用户回报后再决定通过或打回

## 7. 目录结构

```
ts-core/                     ← 主线
  agent.md                   ← Agent 入口
  Docs/
    01_ARCHITECTURE.md       ← 七层架构、五条约束
    02_RUNTIME_SPEC.md
    03_SANDBOX_SPEC.md
    04_CONVERSATION_SPEC.md
    05_DATA_SPEC.md
    WORKFLOW.md              ← 三角色协作 + Prompts
    ENGINEERING_PRINCIPLES.md← B 自检 + C 审查共同规范
    PROGRESS.md              ← C 通过后追加
    PROGRESS_LEGACY.md       ← 旧系统历史 (只读)
  scripts/                   ← pre_review.sh, probes/
  src/                       ← 源代码
    runtime/   skills/       observation/  world-model/
    diagnostics/ domain/     data/         conversation/
    workers/   sandbox/      interfaces/   app/
backend/                     ← 旧 Python 适配层 (维护对象)
plugin/                      ← Java Fabric mod
docs/                        ← legacy-*.md 迁移索引
```

## 8. 常用命令

### ts-core (主线)

```bash
./dev-infra.sh            # 根目录开发模式:只启动 PostgreSQL(数据库) + Redis(缓存),TS 本地跑
./dev-infra.sh run        # 根目录开发模式:前台运行本地 TS Core(TypeScript 核心)并输出日志
./start-ts-core.sh          # 根目录一键启动 app(应用) + PostgreSQL(数据库) + Redis(缓存)
./stop-ts-core.sh           # 根目录一键停止,默认保留数据卷
cd ts-core
pnpm install
pnpm typecheck     # 类型检查
pnpm lint          # Biome
pnpm test          # Vitest
pnpm dev / pnpm build / pnpm start
pnpm db:generate / pnpm db:migrate
bash scripts/pre_review.sh   # Coder B 自检
```

### plugin

```bash
cd plugin && ./mvnw clean package -DskipTests
```

### 旧 backend (仅维护)

```bash
cd backend && pip install -r requirements.txt && npm install
cd backend && pytest -q
```

旧 Python 启动入口已下线;不要再用 `backend/main.py` 或根目录 `start.bat` 启动服务。

## 9. 编码规范

### ts-core (主线)

- TypeScript strict;不写新的纯 JS 业务模块
- 类型 / 类 PascalCase,变量 / 函数 camelCase
- 模块职责单一,禁止 god file
- 能纯函数化的优先纯函数化(尤其 world-model / domain / summary-input)
- 导出符号、关键状态流转、协议转换、并发门控、异常分支需中文注释
- 详细工程规范见 `ts-core/Docs/ENGINEERING_PRINCIPLES.md`

### 旧 Python / Java (维护对象)

- Python:4 空格、type hint、snake_case / PascalCase、中文注释
- Java:4 空格、camelCase / PascalCase

## 10. TypeScript 配置

- `ts-core` 默认 `strict`
- Node 运行时项目:`module: "NodeNext"` + `moduleResolution: "NodeNext"`
- 未经用户确认,不切换 bundler-first 配置

## 11. 文档规则

- 设计文档 → `ts-core/Docs/01-05`,索引在 `ts-core/Docs/00_目录.md`
- 工作流 → `ts-core/Docs/WORKFLOW.md`
- 工程规范 → `ts-core/Docs/ENGINEERING_PRINCIPLES.md`
- 进度 → `ts-core/Docs/PROGRESS.md`
- 迁移索引 → `docs/legacy-*.md`
- `ts-core` 运行说明 → `ts-core/README.md`
- `AGENTS.md` 只保留约束、路由、范围线、禁止事项与文档索引;不堆阶段性细节
- 旧 `backend/Docs/` 与 `docs/architecture-*.md` 仅作历史参考

## 12. 安全

- 不提交真实密钥、token、数据库密码
- 配置走 `.env` 或本地配置文件,不硬写进代码或 prompt
