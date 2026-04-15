# 当前任务握手区

【任务序号】: T-021
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**: 在 `conversation`（对话） + `workers`（工作线程） + `interfaces`（接口边界） + `app`（应用装配） 这一组相邻模块内，打通最小真实消息链路：`POST /api/message`（消息提交接口） 将消息写入 BullMQ（任务队列） 的 `msg:{botId}` 队列，ConversationWorker（对话工作线程） 可消费该消息并按分诊结果产出模板回复、中断请求或执行任务入队动作。本任务不实现真实 LLM（大语言模型） 调用、Socket.io（实时推送） 广播、BotWorker（机器人工作线程） 执行或 sandbox（沙箱） 代码运行。

**上下文说明**:
1. `T-018`（任务十八） 已完成 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂；`T-019`（任务十九） 已完成 BullMQ（任务队列） / Fastify（接口网关） 真实启动骨架；`T-020`（任务二十） 已完成 Mineflayer（Minecraft 协议客户端） / observation（观测） / BotActor（机器人执行代理） 最小运行时核心。
2. 当前 `/api/message`（消息提交接口） 仍主要返回默认 accepted（已接受） 响应，还没有把消息真正写入 `msg:{botId}` 队列；这是本任务首先要补齐的入口侧链路。
3. `conversation`（对话） 模块已有分诊稳压、路由决策、回复尾缀、规划草案与 `ExecJob`（执行任务） 构造纯函数；`workers/contracts.ts`（工作线程契约） 已能把路由结果转换为广播回复、中断和执行入队动作。本任务应复用这些纯函数，不重造平行协议。
4. 本任务只做 ConversationWorker（对话工作线程） 的最小真实处理器与队列衔接。真实 LLM（大语言模型） 可通过依赖注入替代；默认实现必须安全、可测试，不得在没有注入时伪造复杂任务规划。
5. 输出到客户端的回复本轮只能形成可测试的 `broadcast_reply`（广播回复）动作或注入式 sink（输出端）；不能直接接入 Socket.io（实时推送） 真实广播，避免越过后续实时层任务。
6. 任务入队到 `bot:{botId}:exec` 后即止步；不得实现 BotWorker（机器人工作线程） 对 exec（执行） 队列的消费，也不得调用 BotActor（机器人执行代理） 执行动作。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 3 节《三队列模型》；第 4 节《消息流》；第 5 节《中断协议与反射优先级》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 3 节《中断决策》；第 9 节《事件日志与错误分级》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》；第 2 节《两阶段 LLM 调用模型》；第 3.4 节《Triage 容错》；第 4.3 节《回复输出处理》；第 5.1 节《skill_call 优先》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/package.json` — 全文件
7. `ts-core/pnpm-lock.yaml` — 全文件
8. `ts-core/README.md` — 全文件
9. `ts-core/src/domain/contracts.ts` — 全文件（只读参考）
10. `ts-core/src/runtime/contracts.ts` — 全文件（只读参考）
11. `ts-core/src/runtime/tasking.ts` — 全文件
12. `ts-core/src/runtime/events.ts` — 全文件
13. `ts-core/src/conversation/contracts.ts` — 全文件
14. `ts-core/src/conversation/triage.ts` — 全文件
15. `ts-core/src/conversation/chat.ts` — 全文件
16. `ts-core/src/conversation/planning.ts` — 全文件
17. `ts-core/src/conversation/index.ts` — 全文件
18. `ts-core/src/workers/queues.ts` — 全文件
19. `ts-core/src/workers/contracts.ts` — 全文件
20. `ts-core/src/workers/bullmq.ts` — 全文件
21. `ts-core/src/workers/conversation-worker.ts` — 全文件（可新建）
22. `ts-core/src/workers/index.ts` — 全文件
23. `ts-core/src/interfaces/contracts.ts` — 全文件
24. `ts-core/src/interfaces/api.ts` — 全文件
25. `ts-core/src/interfaces/realtime.ts` — 全文件（只读参考）
26. `ts-core/src/interfaces/server.ts` — 全文件
27. `ts-core/src/interfaces/index.ts` — 全文件
28. `ts-core/src/app/contracts.ts` — 全文件
29. `ts-core/src/app/bootstrap.ts` — 全文件
30. `ts-core/src/app/smoke.ts` — 全文件
31. `ts-core/src/app/index.ts` — 全文件
32. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
33. `ts-core/src/__tests__/workers-bullmq-model.spec.ts` — 全文件
34. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
35. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
37. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件（可新建）
38. `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须让 `POST /api/message`（消息提交接口） 在默认 `app`（应用装配） 服务组合中真正写入 BullMQ（任务队列） 的 conversation（对话） 队列；入队 payload（载荷） 必须是现有 `createConversationWorkerTask()`（创建对话工作线程任务） 产物或与其完全一致的强类型结构，不允许另造松散 JSON（结构化数据） 协议。
2. 必须新增 ConversationWorker（对话工作线程） 最小运行时处理器：接收 `ConversationWorkerTask`（对话工作线程任务），通过可注入 triage（分诊） / chat reply（闲聊回复） / planner（规划器） 依赖形成 `ConversationWorkerAction`（对话工作线程动作） 列表，并把动作落到注入式 sink（输出端）：`broadcast_reply`（广播回复）、`interrupt_runtime`（中断运行时）、`enqueue_exec`（执行入队）、`emit_task_lifecycle`（任务生命周期事件）。
3. `chat`（闲聊） 路径必须能无真实 LLM（大语言模型） 运行：可用注入式回复生成器或安全模板回复，且继续执行 `ensureReplyEndsWithMeow()`（喵后缀兜底）。`cancel`（取消） 路径必须直接生成中断动作和模板回复，不得走规划器。
4. `task`（任务） / `modify`（修改） 路径必须通过注入式 planner（规划器） 产出 `skill_call`（技能调用） 或 `sandbox_code`（沙箱代码） 草案，再复用 `createExecJobFromPlan()`（从规划创建执行任务） 与 `createConversationWorkerActions()`（创建对话工作线程动作） 入 `bot:{botId}:exec` 队列；没有注入 planner（规划器） 时不得伪造可执行任务。
5. 必须保留 `T-019`（任务十九） 的跨 Bot（跨机器人） 请求拒绝和空白输入 `400`（请求错误） 语义；HTTP（超文本传输协议） 层不能接受非当前单 Bot（单机器人） 的消息。
6. 本任务不允许：真实 LLM（大语言模型） API（接口） 调用、Socket.io（实时推送） 真实广播、BotWorker（机器人工作线程） 消费 exec（执行） 队列、sandbox（沙箱） 执行、Mineflayer（Minecraft 协议客户端） 写操作、EasyAuth（离线服认证模组） 数据库读写。

**验收标准**:
1. `POST /api/message`（消息提交接口） 在应用装配默认路径下会向 `msg:{botId}` BullMQ（任务队列） 写入一条 ConversationWorker（对话工作线程） 任务，响应仍为 `202`（已接受） 且 `job_id`（任务标识） 与消息可追踪。
2. ConversationWorker（对话工作线程） 最小处理器可在无真实 Redis（缓存） / 无真实 LLM（大语言模型） 的测试中处理 `chat`（闲聊）、`cancel`（取消）、`task`（任务） 至少三类路径，并产出正确动作。
3. `task`（任务） 路径会把注入 planner（规划器） 的规划草案转换成 `ExecJob`（执行任务） 并入 `bot:{botId}:exec` 队列，同时发出 accepted（已接受） 生命周期动作；`cancel`（取消） 路径只中断和回复，不入 exec（执行） 队列。
4. 既有跨 Bot（跨机器人） 请求拒绝、空白输入 `400`（请求错误）、服务关闭顺序与资源失败清理测试仍保持有效。
5. 执行 `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-021`
- [ ] 仅读取并修改白名单内文件
- [ ] `POST /api/message`（消息提交接口） 已真实写入 conversation（对话） 队列，且未破坏 `T-019`（任务十九） 输入校验
- [ ] ConversationWorker（对话工作线程） 最小运行时处理器已通过依赖注入覆盖 triage（分诊） / reply（回复） / planner（规划器） / sink（输出端）
- [ ] `chat`（闲聊）、`cancel`（取消）、`task`（任务） 三类路径均有无外部服务测试覆盖
- [ ] 未实现真实 LLM（大语言模型） 调用、Socket.io（实时推送） 广播、BotWorker（机器人工作线程） 消费、sandbox（沙箱） 执行或 Mineflayer（Minecraft 协议客户端） 写操作
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-022: 在 `sandbox`（沙箱） + `skills`（技能） + `runtime`（运行时） 内接入 BotWorker（机器人工作线程） 最小真实执行链：`exec`（执行） 队列消费、技能快路径、沙箱调用 BotActor（机器人执行代理）。
- T-023: 端到端联调与最小 demo（演示） — 从网页消息入口到 BullMQ（任务队列） 到 BotActor（机器人执行代理） 到游戏内动作 / 回执动作的可观测闭环。
- T-024: 在 `interfaces`（接口层） + `realtime`（实时推送） + `diagnostics`（诊断） 内补齐 Socket.io（实时推送） 广播与 replay（补拉） 真实事件出口。
