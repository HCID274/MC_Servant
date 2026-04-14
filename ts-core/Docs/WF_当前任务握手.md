# 当前任务握手区

【任务序号】: T-014
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 在 `app`（应用装配） / 项目打包入口这一组模块内，补齐 TS Core（TypeScript 单核心） 的最小本地启动与容器化骨架：建立专用可执行入口、把当前纯装配结果转成可读的启动摘要、补上 `Dockerfile`（容器镜像构建文件） / `.dockerignore`（容器忽略文件） / `package.json`（项目清单） 脚本与最小运行说明；本任务不接入真实 Redis（缓存） / PostgreSQL（关系型数据库） / Fastify（接口网关） / Socket.io（实时推送） / Mineflayer（Minecraft 协议客户端） 连接，只做单进程、可测试、可容器启动的骨架。

**上下文说明**:
1. `T-013` 已完成 `runtime`（运行时） / `data`（数据配置） / `db`（数据库元信息） / `app`（应用装配） 的外部认证纯契约与启动语义对齐，当前已经有稳定的 `createAppBootstrapContract()`（创建应用装配结果） 可作为本地启动骨架的纯输入。
2. `01_ARCHITECTURE.md`（系统架构） 第 3.4 节已明确：Phase 1（第一阶段） 是**单进程、单容器**模型，三种 Worker（工作线程） 跑在同一个 Node.js（运行时） 进程里，并由 Docker（容器） `restart policy`（重启策略） 守护；因此现在可以先把“如何启动这个单进程”固定下来。
3. `02_RUNTIME_SPEC.md`（运行时规格） 第 6.1 节已定义启动序列：加载配置 → 准备依赖 → 创建 BotActor（机器人执行代理） 进入 `INITIALIZING`（初始化） → 启动 Worker（工作线程） / 实时推送 / HTTP（接口） → 系统就绪。当前任务不实现真实依赖连接，但需要把这个顺序体现在可执行入口与启动摘要中。
4. `AGENTS.md`（仓库协作约束） 已确认当前默认部署拓扑是：本地 Windows / WSL 侧运行 `Paper + plugin + ts-core`（服务端核心 + 插件 + TS Core），云上只承载入口层、隧道服务端与 PostgreSQL（关系型数据库）；因此本任务的容器骨架应只覆盖 `ts-core`（TypeScript 单核心） 自身，不要把 MC（Minecraft） 服务端或外部认证源打进同一个镜像。
5. 用户已明确问过“什么时候上 `Dockerfile`（容器镜像构建文件）”，因此本任务需要把容器化骨架真正落地，而不是继续只留在设计文档里；但仍要维持最小闭环，不额外引入 `docker-compose.yml`（容器编排文件） 、真实隧道脚本或云部署脚本。
6. 本任务仍然坚持模块级集中交付：允许在 `app`（应用装配） / 可执行入口 / 项目根配置 / 运行说明内成组修改；不得顺手接入真实网络监听、真实数据库迁移执行、真实 BullMQ（队列） Worker 启动或 EasyAuth（离线服认证模组） 认证动作。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》中的部署拓扑条目、第 5 节《ts-core 工具链与工程基线》、第 8 节《常用命令》、第 12 节《安全与配置》
2. `ts-core/Docs/01_ARCHITECTURE.md` — 第 3.4 节《Phase 1 部署模型》
3. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 6.1 节《启动序列》、第 6.2 节《关闭序列》
4. `ts-core/Docs/05_DATA_SPEC.md` — 第 12 节《配置参数速查》
5. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
6. `ts-core/Docs/WF_需求变更索引.md` — 2026-04-14《MC 认证真理源确认（EasyAuth + SQLite）》条目
7. `ts-core/scripts/pre_review.sh` — 全文件
8. `ts-core/package.json` — 全文件
9. `ts-core/tsconfig.json` — 全文件
10. `ts-core/biome.json` — 全文件
11. `ts-core/README.md` — 全文件
12. `ts-core/src/index.ts` — 全文件
13. `ts-core/src/main.ts` — 全文件（可新建）
14. `ts-core/src/app/index.ts` — 全文件
15. `ts-core/src/app/bootstrap.ts` — 全文件
16. `ts-core/src/app/contracts.ts` — 全文件
17. `ts-core/src/app/smoke.ts` — 全文件
18. `ts-core/src/app/entrypoint.ts` — 全文件（可新建）
19. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
20. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
21. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件（可新建）
22. `ts-core/Dockerfile` — 全文件（可新建）
23. `ts-core/.dockerignore` — 全文件（可新建）
24. `ts-core/.env.example` — 全文件（可新建）

**核心逻辑要求**:
1. 必须保持 `ts-core/src/index.ts`（根导出入口） 继续承担库导出职责，不得把可执行副作用直接塞回根导出入口；可执行启动逻辑必须放到专用入口（如 `src/main.ts`、`src/app/entrypoint.ts`） 中。
2. 可执行入口必须只消费纯装配结果，生成可读的启动摘要 / 启动计划，并明确表达当前阶段“已完成配置装配、尚未接真实 IO（输入输出） 连接”的边界；不得偷偷连接 Redis（缓存） / PostgreSQL（关系型数据库） / Fastify（接口网关） / Socket.io（实时推送） / Mineflayer（Minecraft 协议客户端）。
3. `package.json`（项目清单） 脚本必须与新入口对齐，至少保证开发态、构建产物运行态与预检流程之间不再互相矛盾；若引入新入口文件，`Dockerfile`（容器镜像构建文件） 的最终启动命令必须与之保持一致。
4. `Dockerfile`（容器镜像构建文件） / `.dockerignore`（容器忽略文件） 必须体现单进程、单容器的最小 TS Core（TypeScript 单核心） 镜像边界：镜像内只包含构建 TS Core 所需内容，不打包真实数据库、Redis（缓存）、MC（Minecraft） 服务端或外部认证库文件，不把任何真实密钥写入镜像层。
5. `README.md`（运行说明） 与 `.env.example`（环境变量样例） 必须记录最小本地启动方式，以及当前 `T-013` 已引入的外部认证相关环境变量入口；但只能写样例键名与说明，不能写真实密码、真实地址或用户本机私有路径。
6. 若为测试性可执行入口新增纯函数摘要构造器或启动计划构造器，必须把可测试逻辑与真正的 `console`（控制台） / `process`（进程） 副作用分离，确保 Vitest（测试） 可直接覆盖核心逻辑而不依赖真实进程启动。

**验收标准**:
1. `ts-core`（TypeScript 单核心） 已存在独立的可执行启动入口，且 `src/index.ts`（根导出入口） 仍保持纯导出角色，没有混入启动副作用。
2. `package.json`（项目清单） 的 `dev`（开发） / 运行脚本 与 `Dockerfile`（容器镜像构建文件） 的启动命令已对齐到同一个入口，能够表达单进程 TS Core（TypeScript 单核心） 的最小启动骨架。
3. 可执行入口或其依赖的纯函数已能输出可测试的启动摘要，至少覆盖：初始状态为 `INITIALIZING`（初始化）、外部认证装配结果、计划中的启动阶段顺序，以及当前阶段未接真实依赖的说明。
4. `README.md`（运行说明） / `.env.example`（环境变量样例） / `Dockerfile`（容器镜像构建文件） / `.dockerignore`（容器忽略文件） 已形成一致的最小本地运行说明，且未把真实密钥、真实私有路径或外部认证库文件写死进去。
5. 新增或更新测试已覆盖：启动摘要构造、根导出入口无副作用假设、脚本 / 入口对齐的关键断言，以及 `T-013` 外部认证装配结果在启动入口中的可见性。
6. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-014`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] `src/index.ts`（根导出入口） 仍为纯导出入口，未混入进程启动副作用
- [ ] 可执行入口仅消费纯装配结果，未接入真实 Redis（缓存） / PostgreSQL（关系型数据库） / Fastify（接口网关） / Socket.io（实时推送） / Mineflayer（Minecraft 协议客户端） 连接
- [ ] `Dockerfile`（容器镜像构建文件） / `.dockerignore`（容器忽略文件） 未包含真实密钥、真实私有路径、外部认证库文件或额外服务
- [ ] `README.md`（运行说明） 与 `.env.example`（环境变量样例） 已同步更新，且只包含样例键名与说明
- [ ] 新增或更新测试覆盖启动摘要 / 入口对齐 / 外部认证装配可见性
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）
- 回填序号：
- 修改文件：
- 执行摘要：
- 预检输出摘要：
- 遗留疑问：

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-015: 收口 `event_log`（事件日志） / replay（补拉） / diagnostics（诊断） 的持久化对齐边界，为真实写入层预留稳定契约。
- T-016: 在部署骨架稳定后，规划受控登录入口执行骨架，把外部认证纯契约接到实际运行时动作，但仍保持外部认证源只读。
- T-017: 处理低优先级横切项：基础 `invariants`（不变量） / `guards`（守卫） 工具沉淀与架构文档中的 `domain`（领域） 横切层补记。
