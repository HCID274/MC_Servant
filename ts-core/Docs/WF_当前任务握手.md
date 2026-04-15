# 当前任务握手区

【任务序号】: T-020
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**: 在 `runtime`（运行时） + `observation`（观测） + `app`（应用装配） 这一组紧邻模块内，接入真实 Mineflayer（Minecraft 协议客户端） 连接工厂、事件驱动的 observation（观测） 缓存，以及 `INITIALIZING → IDLE`（初始化到空闲） 的最小 BotActor（机器人执行代理） 生命周期闭环；本任务不实现任务执行、不会接入 `sandbox`（沙箱） 或 ConversationWorker（对话工作线程） 真实链路。

**上下文说明**:
1. `T-018`（任务十八） 已完成 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂；`T-019`（任务十九） 已完成 BullMQ（任务队列） / Fastify（接口网关） 真实启动骨架。现在主干缺的是真实 Minecraft（游戏） 侧运行时传输。
2. `runtime/contracts.ts`（运行时契约） 与 `runtime/state-machine.ts`（运行时状态机） 已经锁定 Bot 状态从 `INITIALIZING`（初始化） 到 `IDLE`（空闲） 的语义，以及外部认证 `ready_gate`（就绪门控） 规则；本任务不能绕过这些既有约束伪造 `bot.ready`（机器人就绪）。
3. `observation/snapshot.ts`（观测快照） 已经具备纯函数 `createEnvironmentSnapshot()`（环境快照构造） / `createObservationReadBoundary()`（只读观测边界） / `assessThreat()`（威胁评估） 能力，但还没有真实的事件驱动缓存容器把 Mineflayer（Minecraft 协议客户端） 事件收口成“当前快照”。
4. `app/contracts.ts`（应用生命周期契约） 已预留 `disconnect_runtime_transport`（断开运行时传输） 关闭步骤，`app/bootstrap.ts`（应用装配） 也已经形成基础设施层 + 服务层的组合运行时；本任务需要把 Mineflayer（Minecraft 协议客户端） / observation（观测） 运行时句柄接入这条生命周期，而不是旁路独立存在。
5. 当前默认外部认证真理源是 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库），TS Core（TypeScript 单核心） 不接管认证库。因而本任务只允许“连接成功但认证未完成时保持 `INITIALIZING`（初始化）”或“认证已满足后进入 `IDLE`（空闲）”，不允许偷改为自动视作已登录。
6. `README.md`（项目说明） 已明确当前入口不会自动连接真实 Mineflayer（Minecraft 协议客户端）；本任务仍保持这一原则。真实连接只能通过 `app`（应用装配） 层组合工厂显式创建，且必须支持依赖注入，保证测试不依赖真实 MC（Minecraft） 服务器。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节《七层技术架构》（执行核心 / observation 段）；第 5 节《中断协议与反射优先级》；第 6 节《执行核心：BotActor 状态机》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》；第 2 节《状态机完整定义》；第 6 节《启动与关闭流程》；第 8 节《observation 与 BotActor 的交互契约》；第 9 节《事件日志与错误分级》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/package.json` — 全文件
6. `ts-core/pnpm-lock.yaml` — 全文件
7. `ts-core/README.md` — 全文件
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/runtime/state-machine.ts` — 全文件
10. `ts-core/src/runtime/events.ts` — 全文件
11. `ts-core/src/runtime/index.ts` — 全文件
12. `ts-core/src/runtime/transport.ts` — 全文件（可新建）
13. `ts-core/src/runtime/actor.ts` — 全文件（可新建）
14. `ts-core/src/observation/contracts.ts` — 全文件
15. `ts-core/src/observation/snapshot.ts` — 全文件
16. `ts-core/src/observation/index.ts` — 全文件
17. `ts-core/src/observation/runtime.ts` — 全文件（可新建）
18. `ts-core/src/app/contracts.ts` — 全文件
19. `ts-core/src/app/bootstrap.ts` — 全文件
20. `ts-core/src/app/smoke.ts` — 全文件
21. `ts-core/src/app/index.ts` — 全文件
22. `ts-core/src/app/entrypoint.ts` — 全文件
23. `ts-core/src/interfaces/contracts.ts` — 全文件（只读参考，获取对外状态快照结构）
24. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件
25. `ts-core/src/__tests__/observation-world-model.spec.ts` — 全文件
26. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
27. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
28. `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts` — 全文件（可新建）
29. `ts-core/src/__tests__/observation-runtime-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须新增**真实 Mineflayer（Minecraft 协议客户端） 运行时传输工厂**，通过依赖注入支持替换 `createBot()`（创建客户端实例） 与事件源；产物至少暴露 `connect()`（连接）、`disconnect()`（断开）、连接描述快照和当前连接状态。测试必须能在无真实 MC（Minecraft） 服务器下通过假 bot（机器人实例） / 假事件发射器完成。
2. 必须新增**事件驱动的 observation（观测） 运行时缓存**：可接收 Mineflayer（Minecraft 协议客户端） 一侧的最新只读输入，基于现有 `createEnvironmentSnapshot()`（环境快照构造） 构建和替换当前快照，并对外暴露 `getSnapshot()`（获取快照副本） / `readBoundary`（只读边界） / `assessThreat()`（威胁评估） 的统一入口。该缓存只能读 Mineflayer（Minecraft 协议客户端） 事件和写内部快照，**不得**直接调用任何 Bot 写方法。
3. 必须把 BotActor（机器人执行代理） 的最小运行时闭环收口为可测试边界：启动时状态固定为 `INITIALIZING`（初始化）；只有当 Mineflayer（Minecraft 协议客户端） 已连接且外部认证 `ready_gate`（就绪门控） 允许时，才可转入 `IDLE`（空闲） 并产出 `bot.ready`（机器人就绪） 语义。若外部认证仍是 `pending`（待执行），即使 Mineflayer 已连接，也必须停留在 `INITIALIZING`（初始化），只暴露待执行登录计划，不得伪造 `IDLE`（空闲）。
4. 必须把 Mineflayer（Minecraft 协议客户端） / observation（观测） 运行时句柄纳入 `app/bootstrap.ts`（应用装配） 的真实运行时资源体系，明确创建顺序、关闭顺序和失败回滚策略；关闭时必须先断开 HTTP（超文本传输协议） / workers（工作线程） 等上层入口，再断开运行时传输，最后才释放 Redis（缓存） / PostgreSQL（关系型数据库）。
5. 本任务**不允许**：实现 BullMQ Worker（任务队列消费者） 真消费、实现技能执行 / 沙箱执行、实现 Socket.io（实时推送） 真实广播、实现 EasyAuth（离线服认证模组） 数据库读写同步、实现网页消息到 Bot（机器人） 执行的完整链路。

**验收标准**:
1. 已存在可注入依赖的 Mineflayer（Minecraft 协议客户端） 运行时传输工厂，具备 `connect()`（连接） / `disconnect()`（断开） 生命周期边界，且测试不依赖真实 MC（Minecraft） 服务器。
2. 已存在 observation（观测） 运行时缓存，可基于 Mineflayer（Minecraft 协议客户端） 输入刷新当前快照，并继续满足只读副本、实时 `owner.position`（主人位置） 与威胁评估边界。
3. 已存在 `INITIALIZING → IDLE`（初始化到空闲） 的最小 BotActor（机器人执行代理） 生命周期闭环；外部认证未就绪时不会错误进入 `IDLE`（空闲）。
4. Mineflayer（Minecraft 协议客户端） / observation（观测） 运行时句柄已纳入 `app`（应用装配） 层组合资源，启动 / 关闭顺序与失败清理策略有测试覆盖。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-020`
- [ ] 仅读取并修改白名单内文件
- [ ] Mineflayer（Minecraft 协议客户端） 运行时传输已具备 `connect()` / `disconnect()` 与依赖注入
- [ ] observation（观测） 运行时缓存已基于现有快照纯函数收口，且保持只读边界
- [ ] `INITIALIZING`（初始化） 到 `IDLE`（空闲） 的就绪门控未绕过外部认证语义
- [ ] 已把 Mineflayer（Minecraft 协议客户端） / observation（观测） 运行时接入应用装配生命周期
- [ ] 未实现 Worker（工作线程） 真消费、未接入 Socket.io（实时推送） 真广播、未实现技能 / 沙箱执行
- [ ] 已新增测试覆盖连接 / 断开、快照刷新、就绪门控与失败清理，且不依赖真实 MC（Minecraft） 服务器
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

- 回填任务序号：`T-020`
- 修改文件：
- 执行摘要：
- 预检输出摘要：
- 遗留疑问：

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-021: 在 `conversation`（对话） + `workers`（工作线程） + `interfaces`（接口边界） 内打通最小真实消息链路：HTTP（超文本传输协议） 入队、分诊、模板回复或执行任务分流。
- T-022: 在 `sandbox`（沙箱） + `skills`（技能） + `runtime`（运行时） 内接入 BotWorker（机器人工作线程） 最小真实执行链：`exec`（执行） 队列消费、技能快路径、沙箱调用 BotActor（机器人执行代理）。
- T-023: 端到端联调与最小 demo（演示） — 从网页消息入口到 BullMQ（任务队列） 到 BotActor（机器人执行代理） 到游戏内动作 / 回执广播的可观测闭环。
