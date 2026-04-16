# 当前任务握手区

【任务序号】: T-022
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**:
在 `workers`（工作线程） + `runtime`（运行时） + `skills`（技能） + `app`（应用装配） 这一组主干模块内，打通 **HTTP（超文本传输协议）消息 → ConversationWorker（对话工作线程）最小确定性规划 → BullMQ（任务队列）执行队列 → BotWorker（机器人工作线程） → BotActor（机器人执行代理）单写者技能入口 → Minecraft（我的世界）内可见 goTo（前往坐标）动作** 的最小真实执行链。

本任务不是纯契约任务。验收门槛是：在 T-021（任务二十一） 已完成女仆上线与聊天回复的基础上，操作者发送一条可解析的“去坐标”消息后，女仆在真实 MC（Minecraft，我的世界） 服务器中开始向指定的近距离可达坐标移动，或在无法到达时产出明确失败事件，不允许静默成功。

**上下文说明**:
1. `T-021`（任务二十一） 已完成真实在线聊天闭环：`POST /api/message`（消息提交接口） 可进入 `msg:{botId}` BullMQ（任务队列），ConversationWorker（对话工作线程） 可消费并通过 BotActor（机器人执行代理） 在 MC（Minecraft，我的世界） 聊天频道回复。
2. 当前 `task`（任务） / `modify`（修改） 路径仍因缺少 planner（规划器） 被丢弃；本任务只补一个**最小确定性 goTo（前往坐标）规划器**，不接入真实 LLM（大语言模型）。
3. 当前没有 BotWorker（机器人工作线程） 真实消费 `bot:{botId}:exec`（执行队列）；本任务必须补齐，并让它只通过 BotActor（机器人执行代理） 调用技能，不得绕过单写者。
4. 当前 `skills`（技能） 模块只有目录、参数校验与注册表；本任务只落地 `goTo`（前往坐标） 的最小真实执行适配，不实现 mine（挖掘） / cutTree（砍树） / collect（捡拾） / equip（装备）。
5. Minecraft（我的世界） 事实数据仍不得写死。`goTo`（前往坐标） 只使用调用方给出的坐标与 Mineflayer（Minecraft 协议客户端） / pathfinder（寻路器） 运行时能力，不引入配方、掉落、工具等级或方块事实表。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏约束》；第 3 节《三队列模型》；第 4 节《消息流》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2 节《BotActor 状态机》；第 5 节《单写者执行模型》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》；第 3 节《意图分类》；第 4 节《输出处理》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/package.json` — 全文件（如引入 `mineflayer-pathfinder`（Mineflayer 寻路插件） 依赖，必须同步更新）
7. `ts-core/pnpm-lock.yaml` — 全文件（仅依赖变更时允许更新）
8. `ts-core/.env.example` — 全文件（仅需补充 goTo（前往坐标） 手测说明变量时允许更新）
9. `ts-core/README.md` — 全文件（仅补充最小手测命令时允许更新）
10. `ts-core/src/domain/contracts.ts` — 全文件（只读参考）
11. `ts-core/src/domain/invariants.ts` — 全文件（只读参考）
12. `ts-core/src/runtime/contracts.ts` — 全文件
13. `ts-core/src/runtime/state-machine.ts` — 全文件
14. `ts-core/src/runtime/tasking.ts` — 全文件
15. `ts-core/src/runtime/events.ts` — 全文件
16. `ts-core/src/runtime/transport.ts` — 全文件
17. `ts-core/src/runtime/actor.ts` — 全文件
18. `ts-core/src/runtime/index.ts` — 全文件
19. `ts-core/src/skills/contracts.ts` — 全文件
20. `ts-core/src/skills/registry.ts` — 全文件
21. `ts-core/src/skills/index.ts` — 全文件
22. `ts-core/src/skills/execution.ts` — 全文件（可新建）
23. `ts-core/src/workers/queues.ts` — 全文件
24. `ts-core/src/workers/contracts.ts` — 全文件
25. `ts-core/src/workers/bullmq.ts` — 全文件
26. `ts-core/src/workers/conversation-worker.ts` — 全文件
27. `ts-core/src/workers/bot-worker.ts` — 全文件（可新建）
28. `ts-core/src/workers/index.ts` — 全文件
29. `ts-core/src/app/bootstrap.ts` — 全文件
30. `ts-core/src/app/entrypoint.ts` — 全文件
31. `ts-core/src/app/index.ts` — 全文件
32. `ts-core/src/__tests__/skills-model.spec.ts` — 全文件
33. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 全文件
34. `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts` — 全文件
35. `ts-core/src/__tests__/workers-bullmq-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
37. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
38. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件（可新建）
39. `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts` — 全文件（可新建）
40. `ts-core/src/__tests__/app-online-goto-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:

1. **BotActor（机器人执行代理）单写者技能入口**:
   - 新增 `executeSkill()` 或等价命名的异步入口，只接受 `SkillCallJob`（技能调用执行任务），本任务仅允许真实执行 `goTo`（前往坐标）。
   - 调用前必须满足 ready（就绪） 门控；未就绪时拒绝且不得触碰 Mineflayer（Minecraft 协议客户端）。
   - 执行期间状态必须从 `IDLE`（空闲） 转为 `EXECUTING`（执行中），完成 / 失败后回到 `IDLE`（空闲）；失败必须抛出或返回可观测失败结果，不能假成功。
   - 严守单写者：除 BotActor（机器人执行代理） 内部及其受控 transport（传输） / skills executor（技能执行器） 外，其他模块不得直接调用 Mineflayer（Minecraft 协议客户端） 移动、pathfinder（寻路器） 或原始 Bot（机器人） 句柄。

2. **goTo（前往坐标）真实执行适配**:
   - 在 `skills`（技能） 模块补齐 `goTo`（前往坐标） 的最小 executor（执行器） 边界；真实路径应基于 Mineflayer（Minecraft 协议客户端） 运行时能力与 pathfinder（寻路器） 或等价注入适配器执行。
   - 测试必须能通过注入 fake（假） movement adapter（移动适配器） 验证坐标、调用顺序、失败传播。
   - 不允许实现或伪实现 mine（挖掘） / cutTree（砍树） / collect（捡拾） / equip（装备）；这些技能仍只能停留在参数契约和注册表层面。

3. **BotWorker（机器人工作线程）真实消费执行队列**:
   - 新建 `createBotWorkerRuntime()`，基于 BullMQ Worker（任务队列工作器） 消费 `bot:{botId}:exec`（执行队列）。
   - Job payload（任务载荷） 必须是 `createBotWorkerTask()`（创建机器人工作线程任务） 或等价强类型产物，不允许松散 JSON（对象文本） 直接执行。
   - BotWorker（机器人工作线程） 必须发出 started（已开始） / completed（已完成） / failed（已失败） 或 discarded（已丢弃） 的可测试事件记录；失败原因需要可诊断。
   - 关闭顺序必须接入 `startAppOnlineRuntime()`（真实在线启动入口），保证 BotWorker（机器人工作线程） 在 HTTP（超文本传输协议） / BullMQ（任务队列） 之前被安全关闭。

4. **ConversationWorker（对话工作线程）最小确定性 goTo（前往坐标）规划**:
   - 在不接入真实 LLM（大语言模型） 的前提下，支持一个窄格式命令，例如 `去 10 64 -5` 或 `去 (10,64,-5)`，解析为 `SkillCallJob`（技能调用执行任务） 中的 `goTo`（前往坐标）。
   - 只有成功解析该窄格式时才入 `bot:{botId}:exec`（执行队列）；其他 task（任务） / modify（修改） 仍按 T-021（任务二十一） 的 `planner_unavailable`（规划器不可用） 丢弃逻辑处理。
   - 入执行队列时必须保留原始 `message_id`（消息标识）、`intent_epoch`（意图纪元）、`snapshot_ts`（快照时间戳） 与 priority（优先级）。

5. **应用装配与真实 MC（Minecraft，我的世界）手测链路**:
   - `startAppOnlineRuntime()`（真实在线启动入口） 必须同时启动 ConversationWorker（对话工作线程） 与 BotWorker（机器人工作线程），并共享同一 Redis（缓存） / BullMQ（任务队列） 连接。
   - 手测命令应沿用现有 `POST /api/message`（消息提交接口），不新增临时调试 HTTP（超文本传输协议） 路由。
   - 真实 MC（Minecraft，我的世界） 手测目标坐标必须由操作者选择为近距离、可达、安全位置；代码中不得写死服务器坐标。

**验收标准**:

1. **真实 MC（Minecraft，我的世界）动作验收**:
   - 在本地真实服务器中启动 `pnpm start`（启动命令），女仆账号在线且已完成 EasyAuth（离线服认证模组） 登录。
   - 操作者发送 `POST /api/message`（消息提交接口），内容为约定的“去坐标”窄格式命令。
   - HTTP（超文本传输协议） 返回 `202`（已接受），`msg:{botId}`（消息队列） 与 `bot:{botId}:exec`（执行队列） 均可观测到对应任务。
   - 女仆在 MC（Minecraft，我的世界） 中向目标近距离坐标移动；若 pathfinder（寻路器） 判定失败，必须有明确 failed（已失败） 事件与错误摘要。

2. **单写者与队列链路验收**:
   - ConversationWorker（对话工作线程） 只负责解析和入执行队列，不直接调用 Mineflayer（Minecraft 协议客户端） 移动能力。
   - BotWorker（机器人工作线程） 只通过 BotActor（机器人执行代理） 执行 `goTo`（前往坐标），不直接持有原始 Bot（机器人） 句柄。
   - BotActor（机器人执行代理） 在 not-ready（未就绪） / busy（忙碌） / movement failure（移动失败） 场景下行为可测试且不假成功。

3. **自动化测试覆盖**:
   - 覆盖窄格式“去坐标”消息解析、成功入 `bot:{botId}:exec`（执行队列）、不可解析 task（任务） 继续 discarded（已丢弃）。
   - 覆盖 BotWorker（机器人工作线程） started（已开始） / completed（已完成） / failed（已失败） 事件。
   - 覆盖 BotActor（机器人执行代理） `goTo`（前往坐标） ready（就绪） 成功、not-ready（未就绪） 拒绝、执行中并发拒绝或排队策略。
   - 覆盖 app（应用装配） 启动 / 关闭顺序包含 BotWorker（机器人工作线程）。

4. **范围边界验收**:
   - 不引入真实 LLM（大语言模型）、sandbox（沙箱） 执行、Socket.io（实时推送） 广播、mine（挖掘） / cutTree（砍树） / collect（捡拾） / equip（装备） 真实执行。
   - 不读写 EasyAuth（离线服认证模组） SQLite（嵌入式数据库），不迁移认证数据到 PostgreSQL（关系型数据库）。
   - 不写死 Minecraft（我的世界） 领域事实数据或服务器坐标。

5. **预检通过**:
   - `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-022`
- [ ] 仅读取并修改白名单内文件
- [ ] BotActor（机器人执行代理） 已新增单写者 `goTo`（前往坐标） 技能执行入口，且 ready（就绪） 门控正确
- [ ] BotWorker（机器人工作线程） 已真实消费 `bot:{botId}:exec`（执行队列） 并只通过 BotActor（机器人执行代理） 执行
- [ ] ConversationWorker（对话工作线程） 仅对窄格式“去坐标”命令入执行队列，其他 task（任务） 仍按无 planner（规划器） 丢弃
- [ ] 真实 MC（Minecraft，我的世界） 手测能看到女仆移动，或在不可达时产生明确 failed（已失败） 事件
- [ ] 未实现 mine（挖掘） / cutTree（砍树） / collect（捡拾） / equip（装备） 真实执行，未引入 LLM（大语言模型） / sandbox（沙箱） / Socket.io（实时推送）
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-023**: 在 `interfaces`（接口层） + `realtime`（实时推送） + `diagnostics`（诊断） 内补齐 Socket.io（实时推送） 真实广播 + replay（补拉） 真实事件出口；验收门槛：网页或测试客户端能实时订阅 task lifecycle（任务生命周期） 事件并看到 goTo（前往坐标） 进度。
- **T-024**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 isolated-vm（隔离虚拟机） 真实沙箱与 Facade API（门面接口） 桥接；验收门槛：HTTP（超文本传输协议） 提交一段受限沙箱代码后，女仆按代码顺序执行多个已允许动作。
- **T-025**: 在 `conversation`（对话） + `workers`（工作线程） 内接入真实 LLM（大语言模型） 两阶段 triage（分诊） / planner（规划器）；验收门槛：自然语言“去我前面两格”等任务可规划为 `goTo`（前往坐标） 并执行。
