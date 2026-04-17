# 当前任务握手区

【任务序号】: T-023
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**:
在 `interfaces`（接口边界） + `diagnostics`（诊断） + `app`（应用装配） + `workers`（工作线程） + `runtime`（运行时） + `observation`（观测） 这一组主干模块内，补齐 **真实 MC（Minecraft，我的世界） 上线测试所需的可观测入口**：启动 `pnpm start`（启动命令） 后，操作者不仅能让女仆进服、登录并执行 `goTo`（前往坐标），还必须能通过受控接口拿到 `bot.ready`（机器人就绪）、`task.accepted`（任务已接受）、`task.started`（任务已开始）、`task.completed` / `task.failed`（任务已完成 / 已失败） 等可回放、可核对的状态与事件回执。

本任务的验收口径不是“又加一层纯契约”，而是**把 T-021（任务二十一） 的在线聊天闭环与 T-022（任务二十二） 的真实 `goTo`（前往坐标） 执行链，组装成可实际操作、可实际观察、可实际复核的 MC（Minecraft，我的世界） 女仆上线测试入口**。

**上下文说明**:
1. `T-021`（任务二十一） 已完成真实在线聊天闭环，`POST /api/message`（消息提交接口） 能进入 `msg:{botId}`（消息队列） 并由 ConversationWorker（对话工作线程） 产出聊天回复。
2. `T-022`（任务二十二） 已完成 `goTo`（前往坐标） 的最小真实执行链，ConversationWorker（对话工作线程） 可对窄格式坐标命令入 `bot:{botId}:exec`（执行队列），BotWorker（机器人工作线程） 可经 BotActor（机器人执行代理） 单写者真实执行移动。
3. 当前仍缺一个**操作者侧可见**的验收出口：仅靠控制台日志和测试断言，不足以支撑本批次“真实 MC（Minecraft，我的世界） 上线女仆测试”的复核要求。
4. 本任务优先补齐**状态 / 事件观测与回放**，让操作者能在不读内部日志文件的前提下确认：机器人是否已 ready（就绪）、`world_ready`（世界交互就绪） 是否已打开、任务是否被接受 / 开始 / 完成 / 失败，以及失败摘要是什么。
5. EasyAuth（离线服认证模组） 仍是外部认证真理源；本任务不接管认证库、不迁移 SQLite（嵌入式数据库） 数据、不新增双写。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《消息流》；第 8 节《事件协议》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2 节《状态机完整定义》；第 5 节《Worker 生命周期与事件》
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》；与 `event_log`（事件日志）/ `task_history`（任务历史）/ JSONL（结构化日志） 相关章节
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/README.md` — 全文件（仅在需要补真实上线测试命令时允许更新）
7. `ts-core/.env.example` — 全文件（仅在需要补真实上线测试所需环境变量说明时允许更新）
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/runtime/events.ts` — 全文件
10. `ts-core/src/runtime/actor.ts` — 全文件
11. `ts-core/src/runtime/transport.ts` — 全文件
12. `ts-core/src/runtime/index.ts` — 全文件
13. `ts-core/src/observation/contracts.ts` — 全文件
14. `ts-core/src/observation/runtime.ts` — 全文件
15. `ts-core/src/observation/snapshot.ts` — 全文件
16. `ts-core/src/observation/index.ts` — 全文件
17. `ts-core/src/workers/contracts.ts` — 全文件
18. `ts-core/src/workers/conversation-worker.ts` — 全文件
19. `ts-core/src/workers/bot-worker.ts` — 全文件
20. `ts-core/src/workers/index.ts` — 全文件
21. `ts-core/src/diagnostics/contracts.ts` — 全文件
22. `ts-core/src/diagnostics/logs.ts` — 全文件
23. `ts-core/src/diagnostics/index.ts` — 全文件
24. `ts-core/src/interfaces/contracts.ts` — 全文件
25. `ts-core/src/interfaces/api.ts` — 全文件
26. `ts-core/src/interfaces/realtime.ts` — 全文件
27. `ts-core/src/interfaces/server.ts` — 全文件
28. `ts-core/src/interfaces/index.ts` — 全文件
29. `ts-core/src/app/bootstrap.ts` — 全文件
30. `ts-core/src/app/entrypoint.ts` — 全文件
31. `ts-core/src/app/index.ts` — 全文件
32. `ts-core/src/main.ts` — 全文件
33. `ts-core/src/__tests__/runtime-worker-event-model.spec.ts` — 全文件
34. `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts` — 全文件
35. `ts-core/src/__tests__/observation-runtime-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
37. `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts` — 全文件
38. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
39. `ts-core/src/__tests__/persistence-replay-model.spec.ts` — 全文件
40. `ts-core/src/__tests__/app-online-runtime-observability-model.spec.ts` — 全文件（可新建）
41. `ts-core/src/__tests__/interfaces-realtime-replay-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:

1. **真实上线测试的状态与事件出口**:
   - 必须为操作者提供至少一条**受控**的状态读取路径和一条事件读取路径，用于真实 MC（Minecraft，我的世界） 上线测试时核对运行态。
   - 状态输出至少包含：`bot_id`（机器人标识）、`status`（运行时状态）、`external_auth`（外部认证状态）、`transport.connected`（传输已连接）、`transport.world_ready`（传输世界交互就绪）。
   - 事件输出至少覆盖：`bot.ready`（机器人就绪）、`task.accepted`（任务已接受）、`task.started`（任务已开始）、`task.completed` / `task.failed` / `task.discarded`（任务已完成 / 已失败 / 已丢弃）。
   - 事件输出必须可 replay（补拉 / 回放） 或等价按序读取，不允许只能靠进程控制台瞬时打印观察。

2. **事件链路必须从真实执行路径产出**:
   - ConversationWorker（对话工作线程） 在 `goTo`（前往坐标） 成功入 `bot:{botId}:exec`（执行队列） 时，必须留下 `accepted`（已接受） 语义的可观测记录。
   - BotWorker（机器人工作线程） 在真实消费执行队列时，必须把 `started`（已开始） / `completed`（已完成） / `failed`（已失败） / `discarded`（已丢弃） 通过统一事件 / 诊断出口向外暴露。
   - 不允许新建一个只给测试看的“假事件流”；必须复用真实运行时 / worker（工作线程） 生命周期数据。

3. **接口边界与回放边界**:
   - 优先复用现有 `interfaces`（接口边界） 模块，不新增绕过架构的临时脚本入口。
   - 若需要 replay（补拉 / 回放） 能力，应基于现有 `interfaces/realtime.ts`（实时事件模型） 与 `diagnostics`（诊断）/ `runtime/events.ts`（运行时事件） 契约落地，输出顺序、事件类型和载荷要强类型可测试。
   - 本任务可以新增最小必要的 HTTP（超文本传输协议） 只读接口，但不得新增会改变主消息入口语义的调试写接口；消息仍只从 `POST /api/message`（消息提交接口） 进入。

4. **真实 MC（Minecraft，我的世界） 手测装配**:
   - `startAppOnlineRuntime()`（真实在线启动入口） / `main.ts`（程序入口） 必须把状态与事件出口在在线运行路径中真正接起来，而不是只在测试注入里存在。
   - 真实手测时，操作者应能完成这条链路：启动进程 → 看到 ready（就绪） / world_ready（世界交互就绪） → 发送 `去 10 64 -5`（前往坐标命令示例） → 看到 accepted / started / completed 或 failed（已接受 / 已开始 / 已完成 或 已失败） → 在 MC（Minecraft，我的世界） 内观察女仆动作或失败回执。

5. **范围边界**:
   - 本任务不接入真实 LLM（大语言模型） 规划，不接入 isolated-vm（隔离虚拟机） 沙箱执行，不实现 BrainWorker（摘要工作线程） 摘要管线，不改 EasyAuth（离线服认证模组） 数据源。
   - 不写死服务器地址、测试坐标、登录密码等部署事实；真实手测值只能来自本地环境变量或本地配置。

**验收标准**:

1. `pnpm start`（启动命令） 在线运行后，操作者可通过受控接口确认 `transport.connected=true`（传输已连接） 与 `transport.world_ready=true`（传输世界交互就绪） 的时机，不再只能靠内部日志猜测。
2. 对 `POST /api/message`（消息提交接口） 提交一条窄格式 `goTo`（前往坐标） 消息后，操作者可通过受控事件出口依次看到 `task.accepted`（任务已接受） 与 `task.started`（任务已开始），并最终看到 `task.completed` 或 `task.failed`（任务已完成或已失败）。
3. 自动化测试覆盖状态读取、事件回放 / 顺序读取、以及在线装配时真实接线，不允许只有纯数据工厂测试。
4. 真实 MC（Minecraft，我的世界） 手测文档或运行说明足够让操作者完成一次“女仆上线 + 登录 + 发送坐标命令 + 观察动作与事件回执”的闭环验证。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-023`
- [ ] 仅读取并修改白名单内文件
- [ ] 在线运行路径已暴露可读状态出口，且包含 `transport.world_ready`（传输世界交互就绪）
- [ ] `task.accepted`（任务已接受） / `task.started`（任务已开始） / `task.completed` / `task.failed`（任务已完成 / 已失败） 已能从真实路径被读取或回放
- [ ] 未新增绕过 `POST /api/message`（消息提交接口） 的调试写入口
- [ ] 未引入真实 LLM（大语言模型） / sandbox（沙箱） / BrainWorker（摘要工作线程） / EasyAuth（离线服认证模组） 数据迁移
- [ ] 真实 MC（Minecraft，我的世界） 手测说明已补齐到必要位置
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

**回填序号**: `T-023`

**修改文件**:
- （待填写）

**执行摘要**:
- （待填写）

**预检输出摘要**:
- （待填写）

**遗留疑问**:
- （待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-024**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 isolated-vm（隔离虚拟机） 真实执行与 Facade API（门面接口） 桥接；验收门槛：单条任务可顺序执行多个受控动作，不再只限单个 `goTo`（前往坐标）。
- **T-025**: 在 `conversation`（对话） + `workers`（工作线程） 内接入真实 LLM（大语言模型） triage（分诊） / planner（规划器），让自然语言任务可规划为 `skill_call`（技能调用） 或 `sandbox_code`（沙箱代码）。
- **T-026**: 在 `data`（数据） + `diagnostics`（诊断） + `workers`（工作线程） 内补齐 BrainWorker（摘要工作线程） 摘要与部署文档收口，把当前实时运行链沉淀为可长期运维的持久化闭环。
