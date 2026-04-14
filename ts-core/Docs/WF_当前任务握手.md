# 当前任务握手区

【任务序号】: T-013
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立外部认证源适配的最小运行时契约，把“是否需要认证、认证进行中、已认证、认证失败”与“明文登录密钥只允许通过部署注入”收口为同一套纯类型 / 纯函数边界，并移除现有代码里把外部认证误建模为 PostgreSQL（关系型数据库） `authme schema`（认证模式） 的过时耦合；本任务不读取 EasyAuth（离线服认证模组） SQLite（嵌入式数据库）、不接入真实 Mineflayer（Minecraft 协议客户端） 登录、不发送真实聊天登录命令。

**上下文说明**:
1. `T-012` 已完成 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 的任务生命周期闭环，当前主线缺口转为“BotActor（机器人执行代理） 在 `INITIALIZING`（初始化） 阶段如何表达外部认证流程边界”。
2. `02_RUNTIME_SPEC.md`（运行时规格） 已明确 `INITIALIZING`（初始化） 包含“Mineflayer 连接中、外部认证流程处理中”，且只有“连接成功 + 外部认证完成”才能进入 `IDLE`（空闲）；因此外部认证不能继续只是注释语义，必须在运行时契约层有可测试表达。
3. `05_DATA_SPEC.md`（数据规格） 与需求变更索引已确认：MC（Minecraft） 登录认证当前真实部署为 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库），它是**外部认证源**，不是 TS Core（TypeScript 单核心） PostgreSQL（关系型数据库） 主业务库的一部分；TS Core 不接管、不迁移、不双写它的数据，机器人登录明文密码只能由部署注入。
4. 仓内当前仍有旧假设残留：`ts-core/src/db/contracts.ts` 还把只读依赖 schema（模式） 写成 `authme`，这会把后续实现继续拖回“外部认证在 PG（关系型数据库） 内”的错误路径；本任务要把该耦合清掉，并建立可扩展但不写死 EasyAuth（离线服认证模组） 表结构的最小契约。
5. 本任务仍然是模块级契约收口：允许在 `runtime`（运行时） / `data`（数据配置） / `db`（数据库元信息） / `app`（应用装配） 内补齐边界与导出，但不得接入真实数据库查询、真实聊天命令发送、真实 JAR Bridge（服务端桥接） 登录流程或 Docker（容器） 启动脚本。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节《系统总体结构》中的双视角输入段落、第 3.1 节《队列划分》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2.1 节《状态枚举》、第 2.2 节《状态转换图》、第 2.3 节《转换规则详表》、第 6.1 节《启动序列》
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《总览》中的外部认证源段落、第 2.1 节《Schema 隔离》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/Docs/WF_需求变更索引.md` — 2026-04-14《MC 认证真理源确认（EasyAuth + SQLite）》条目
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/src/index.ts` — 全文件
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/runtime/state-machine.ts` — 全文件
10. `ts-core/src/runtime/index.ts` — 全文件
11. `ts-core/src/data/contracts.ts` — 全文件
12. `ts-core/src/data/index.ts` — 全文件
13. `ts-core/src/db/contracts.ts` — 全文件
14. `ts-core/src/db/index.ts` — 全文件
15. `ts-core/src/app/contracts.ts` — 全文件
16. `ts-core/src/app/bootstrap.ts` — 全文件
17. `ts-core/src/app/index.ts` — 全文件
18. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件
19. `ts-core/src/__tests__/db-config-model.spec.ts` — 全文件
20. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件

**核心逻辑要求**:
1. 必须在 `runtime`（运行时） 内建立统一的外部认证状态 / 配置契约，至少能无歧义表达：`not_required`（无需认证） / `pending`（认证进行中） / `authenticated`（已认证） / `failed`（认证失败）；不得再把外部认证停留在注释层或散落成多套布尔字段。
2. 必须显式表达“明文登录密钥由部署注入”的边界：允许通过 `env`（环境变量） / `botConfig`（机器人配置） 等纯配置输入声明登录密钥来源，但不得把外部认证密码哈希、SQLite（嵌入式数据库） 路径、EasyAuth（离线服认证模组） 表结构或查询逻辑写进运行时契约。
3. `db`（数据库元信息） / `data`（数据配置） / `app`（应用装配） 侧必须清除把外部认证误建模为 PostgreSQL（关系型数据库） `authme schema`（认证模式） 的过时耦合；TS Core（TypeScript 单核心） 的 PostgreSQL（关系型数据库） 仍只描述业务真理源，不承担外部认证源只读 schema（模式） 假设。
4. `app/bootstrap`（应用装配） 必须能纯函数暴露当前 Bot（机器人） 的外部认证装配结果，使后续启动流程可以在不接真实 IO（输入输出） 的前提下判断“是否需要认证、认证应使用哪类受控入口、密钥是否已注入”；但本任务不得真正执行登录命令。
5. 不得引入真实 EasyAuth（离线服认证模组） 读取、不得新增 PostgreSQL（关系型数据库） 同步表、不得把外部认证状态写入 `event_log`（事件日志） / `task_history`（任务历史） 持久化层、不得接入 Dockerfile（容器镜像构建文件） 或部署脚本。

**验收标准**:
1. `runtime`（运行时） 已存在统一的外部认证状态与配置契约，且与 `INITIALIZING`（初始化） → `IDLE`（空闲） 的状态机语义一致。
2. `data`（数据配置） / `app`（应用装配） 已能纯函数表达“认证是否启用、入口方式、密钥注入来源 / 缺失”的最小装配结果。
3. `db/contracts.ts`（数据库契约） 中不再把外部认证错误表述为 PostgreSQL（关系型数据库） `authme schema`（认证模式） 或其他写死的 PG（关系型数据库） 只读 schema（模式）。
4. 新增或更新测试已覆盖：无需认证路径、需要认证但缺少注入密钥的失败路径、装配层可见性，以及清除旧 `authme`（旧认证模式） 假设后的导出一致性。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-013`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 外部认证仅建模为运行时 / 装配层纯契约，未接入 EasyAuth（离线服认证模组） SQLite（嵌入式数据库） 读取、真实聊天命令或真实服务端桥接登录逻辑
- [ ] PostgreSQL（关系型数据库） 契约中已移除 `authme`（旧认证模式） 只读 schema（模式） 假设
- [ ] 明文登录密钥边界仅来自部署注入，未把哈希反推、库表路径或查询逻辑混入配置 / 运行时模型
- [ ] 新增或更新测试覆盖“无需认证 / 需要认证 / 缺少密钥失败”与应用装配可见性
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
- T-014: 在外部认证契约稳定后补本地装配 / 启动入口 / `Dockerfile`（容器镜像构建文件） 的最小部署骨架。
- T-015: 收口 `event_log`（事件日志） / replay（补拉） / diagnostics（诊断） 的持久化对齐边界，为真实写入层预留稳定契约。
- T-016: 在部署骨架与持久化边界稳定后，规划受控登录入口执行骨架，把认证契约接到实际运行时动作，但仍保持外部认证源只读。
