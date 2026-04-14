# 当前任务握手区

【任务序号】: T-016
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 在 `runtime`（运行时） / `app`（应用装配） / `interfaces`（接口边界） 这一组紧邻模块内，补齐“外部认证待执行 → 受控登录命令计划 → 认证完成 / 失败门控”的最小执行骨架；要求把外部认证从现有静态状态描述推进到可测试的纯动作模型与就绪门控模型，为后续真实连服与 EasyAuth（离线服认证模组） 登录动作接线预留稳定边界；本任务不接入真实 Mineflayer（Minecraft 协议客户端） 聊天发送、不读取 EasyAuth SQLite（嵌入式数据库）、不实现网页登录后端。

**上下文说明**:
1. `T-013` 已收口 `ExternalAuthState`（外部认证状态） 与 `INITIALIZING`（初始化） 起始语义，但目前还只有“状态存在”，没有“要执行什么动作、何时允许 ready（就绪）”的纯执行骨架。
2. `T-014` 已建立最小本地启动 / 容器骨架；`app/contracts.ts`（应用装配契约） 已声明“运行时完成连接与外部认证、进入 `IDLE`（空闲） 后才允许开放实时推送并 `emit_bot_ready`（发出就绪事件）”，当前需要把这条说明落成可测试模型。
3. `T-015` 已完成 `event_log`（事件日志） / `task_history`（任务历史） / `replay`（补拉） 边界收口；本任务不得把明文密钥或认证内部细节泄露到接口层状态快照、补拉载荷或持久化模型。
4. 已确认现实部署中 MC（Minecraft） 认证真理源是 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库），而不是 TS Core（TypeScript 单核心） 自己的 PostgreSQL（关系型数据库） 业务库；当前目标是“机器人稳定进服”，不是“统一账号平台”。
5. 仍按模块级集中交付：允许在 `runtime`（运行时） / `app`（应用装配） / `interfaces`（接口边界） 及相关测试内成组修改；不得顺手实现真实 EasyAuth（离线服认证模组） 读库适配、真实 Mineflayer（Minecraft 协议客户端） 登录器、真实会话仓储或网页控制器。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 17 节《身份与交互模型》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节状态枚举 / 状态图；第 3 节中断与状态门控；第 6 节启动流程；第 9 节诊断事件清单
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《外部认证源》说明；`owners` / `owner_bots` / `sessions` 三张表定义
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/Docs/WF_需求变更索引.md` — 2026-04-14《MC 认证真理源确认（EasyAuth + SQLite）》条目
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/src/runtime/contracts.ts` — 全文件
8. `ts-core/src/runtime/state-machine.ts` — 全文件
9. `ts-core/src/runtime/events.ts` — 全文件
10. `ts-core/src/runtime/index.ts` — 全文件
11. `ts-core/src/app/contracts.ts` — 全文件
12. `ts-core/src/app/bootstrap.ts` — 全文件
13. `ts-core/src/app/entrypoint.ts` — 全文件
14. `ts-core/src/app/index.ts` — 全文件
15. `ts-core/src/interfaces/contracts.ts` — 全文件
16. `ts-core/src/interfaces/index.ts` — 全文件
17. `ts-core/src/interfaces/game-chat/contracts.ts` — 全文件
18. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件
19. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
20. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
21. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
22. `ts-core/src/__tests__/interfaces-model.spec.ts` — 全文件
23. `ts-core/src/__tests__/external-auth-execution-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须把 `ExternalAuthState.pending`（外部认证待执行） 显式收口为可测试的纯动作模型：至少能表达 `game_chat_command`（游戏聊天命令） 入口下的登录命令计划、执行目标、是否允许重试，以及给外层展示的脱敏摘要；不得继续只停留在“有状态、无动作”的占位描述。
2. 必须补齐“ready（就绪） 门控”纯模型：需要外部认证时，运行时在认证完成前必须保持 `INITIALIZING`（初始化） 语义，`bot.ready`（机器人就绪） / 实时推送开放 / 启动摘要中的 ready 判定都不得假装已经通过；认证失败时必须可测试地阻断 ready，而不是继续沿 happy path（成功路径） 走下去。
3. 明文密码边界必须严格受控：明文只允许存在于最小执行动作载荷中；任何对 `app/entrypoint`（应用启动摘要）、`interfaces`（接口边界） 或可观测状态的输出都必须是脱敏视图，且经过深只读切边，不能把 `secret`（明文密钥） 直接暴露出去。
4. 必须继续坚持“外部认证源只读”原则：不得引入 EasyAuth（离线服认证模组） SQLite（嵌入式数据库） schema（表结构） 假设、不得把认证数据搬进 PostgreSQL（关系型数据库）、不得建双写 / 同步管线、不得出现“从哈希反推密码”之类的错误建模。
5. 本任务只允许建立纯契约、纯构造器、纯门控器与纯摘要器；不得顺手接入真实 Mineflayer（Minecraft 协议客户端） 聊天发送、真实登录命令执行器、真实 HTTP（超文本传输协议） 路由或真实 EasyAuth（离线服认证模组） 只读适配器。

**验收标准**:
1. `pending`（待执行） 外部认证状态下能够构造出唯一、可测试的登录动作计划；`not_required`（无需认证） 不产生命令；`failed`（失败） 产出阻断就绪的结构化结果。
2. `bot.ready`（机器人就绪） 与启动摘要的 ready 判定已和外部认证结果对齐：需要认证时，只有 `authenticated`（已认证） 才能视为通过；`failed`（失败） 不得伪装成可服务状态。
3. 所有对外摘要 / 状态对象都不会泄露明文密钥，且相关脱敏对象为深只读。
4. 已新增或更新测试，至少覆盖：登录命令计划生成、脱敏摘要、ready 门控、失败阻断、`not_required`（无需认证） 快路径。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-016`
- [ ] 仅读取并修改白名单内文件
- [ ] 未引入 EasyAuth（离线服认证模组） SQLite（嵌入式数据库） 读写、PostgreSQL（关系型数据库） 同步或双写逻辑
- [ ] 外部认证执行模型已显式表达登录命令计划、脱敏摘要与 ready（就绪） 门控
- [ ] 所有对外暴露的认证状态 / 摘要对象均未泄露明文密钥，且经过深只读切边
- [ ] 未接入真实 Mineflayer（Minecraft 协议客户端） / HTTP（超文本传输协议） / Socket.io（实时推送） IO（输入输出）
- [ ] 新增或更新测试覆盖登录命令计划、失败阻断与 `not_required`（无需认证） 快路径
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-017: 处理低优先级横切项：基础 `invariants`（不变量） / `guards`（守卫） 工具沉淀与架构文档中的 `domain`（领域） 横切层补记。
- T-018: 在 `conversation`（对话） / `brain`（摘要） 相关模块内收口摘要输入与检索契约，为后续 pgvector（向量检索） 接入做纯模型准备。
- T-019: 在部署文档与运行说明里补记本地 Fabric（服务端核心） + EasyAuth（离线服认证模组） 运维约束与连服前置条件，但仍不把外部认证接管进 TS Core（TypeScript 单核心）。
