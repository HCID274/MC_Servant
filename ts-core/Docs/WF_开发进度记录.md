# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-021` ~ `T-030`
- 当前已完成任务：`T-021`、`T-022`、`T-023`、`T-024`
- 当前批次摘要：从 `T-021`（任务二十一） 起按"纵向上线切片"重排，把原 T-021（消息入队 + ConversationWorker stub） / 原 T-022（BotWorker 最小执行） / 原 T-023（真实连服 + EasyAuth + 端到端） 三任务合并为新的 `T-021`（最窄端到端 demo），把 MC（Minecraft，我的世界） 上线硬门槛前移到本批次第一个任务。后续任务沿 BotWorker → 实时层 → sandbox → 真实 LLM → BrainWorker → 部署文档 的顺序逐步加深。
- 当前批次硬约束：`T-021`（任务二十一） 验收必须包含真实 MC 服务器手测（聊天截图 + 启动日志），不再做纯契约或纯占位任务。每个后续任务都必须给出可在 MC 中亲眼验证的新行为门槛。

---

## 详细记录

### T-021 — 最窄 MC 在线聊天闭环

- 审查状态：通过。
- 核心文件：
  - `ts-core/src/runtime/actor.ts`
  - `ts-core/src/runtime/transport.ts`
  - `ts-core/src/workers/conversation-worker.ts`
  - `ts-core/src/workers/bullmq.ts`
  - `ts-core/src/app/bootstrap.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/main.ts`
  - `ts-core/src/__tests__/runtime-actor-model.spec.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- 变更快照：
  - BotActor（机器人执行代理） 增加 `broadcastReply()` 单写者聊天入口，ready（就绪） 门控未通过时拒绝写入，并发聊天写入直接拒绝。
  - Mineflayer（Minecraft 协议客户端） transport（传输） 增加最小 `chat(text)` 适配器，仍不向外暴露原始 Bot（机器人） 句柄。
  - ConversationWorker（对话工作线程） 已真实消费 `msg:{botId}` BullMQ（任务队列），chat（闲聊） 路径生成带“喵”的模板回复并经 BotActor（机器人执行代理） 写入游戏聊天；cancel（取消） 只记录；task（任务） / modify（修改） 在无 planner（规划器） 时丢弃。
  - `POST /api/message`（消息提交接口） 默认 handler（处理器） 已真实写入 BullMQ（任务队列） 并返回真实 `job.id`；打回修复后每条消息独立生成 `queued_at`（入队时间） 与 `snapshot_ts`（快照时间戳），不再复用启动时间。
  - `pnpm start` 进入真实在线启动路径：PostgreSQL（关系型数据库） / Redis（缓存） → BullMQ（任务队列） / Fastify（接口网关） → Mineflayer（Minecraft 协议客户端） → EasyAuth（离线服认证模组） 登录命令 → ConversationWorker（对话工作线程）。
  - Coder（编码代理） 反馈已完成真实 MC（Minecraft，我的世界） 服务器 CLI（命令行） 链路验证：连服、EasyAuth（离线服认证模组） 注册 / 登录、HTTP（超文本传输协议） 202 响应、BullMQ（任务队列） completed（完成） 状态；图形客户端截图仍需操作者侧留存。
- 验收备注：
  - `bash ts-core/scripts/pre_review.sh` 由 Coder（编码代理） 回填为全部通过，摘要为 24 个测试文件、114 条测试通过。
  - 本次审查未重复机械预检。

### T-022 — goTo 最小真实执行链

- 审查状态：通过。
- 核心文件：
  - `ts-core/src/runtime/actor.ts`
  - `ts-core/src/runtime/transport.ts`
  - `ts-core/src/skills/execution.ts`
  - `ts-core/src/skills/index.ts`
  - `ts-core/src/workers/conversation-worker.ts`
  - `ts-core/src/workers/bot-worker.ts`
  - `ts-core/src/workers/index.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/__tests__/runtime-actor-model.spec.ts`
  - `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
  - `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- 变更快照：
  - `skills`（技能） 模块新增 `execution.ts`（执行器），当前只允许 `goTo`（前往坐标） 进入真实执行边界；失败由 movement adapter（移动适配器） 直接透传，不做静默成功。
  - `MineflayerRuntimeTransport`（Mineflayer 运行时传输） 新增受控 `goTo()`（前往坐标） 能力，并接入 `mineflayer-pathfinder`（Mineflayer 寻路插件）；同时把“聊天可写”和“世界交互可执行”拆成两层语义，新增 `world_ready`（世界交互就绪） 快照字段。
  - `BotActor`（机器人执行代理） 新增 `executeSkill()`（执行技能） 单写者入口，执行前要求通用 ready gate（就绪门控） 与 `transport.world_ready`（传输世界交互就绪） 同时满足；打回修复后，`spawn`（生成） 前的 `goTo`（前往坐标） 会在入口直接拒绝，不再深入到传输层后才失败。
  - `ConversationWorker`（对话工作线程） 增加窄格式 `去 10 64 -5` / `去 (10,64,-5)` 的确定性规划，成功解析后构造 `SkillCallJob`（技能调用执行任务） 与 `BotWorkerTask`（机器人工作线程任务） 推入 `bot:{botId}:exec`（执行队列）。
  - `BotWorker`（机器人工作线程） 正式串行消费执行队列，只通过 `BotActor.executeSkill()`（机器人执行代理执行技能） 调用动作，并产出 started（已开始）/ completed（已完成）/ failed（已失败）/ discarded（已丢弃） 生命周期事件。
  - `startAppOnlineRuntime()`（真实在线启动入口） 同时拉起 `BotWorker`（机器人工作线程） 与 `ConversationWorker`（对话工作线程），关闭顺序保持先 worker（工作线程） 后运行时 / HTTP（超文本传输协议） / BullMQ（任务队列）。
- 验收备注：
  - 打回点已修复：`world_ready`（世界交互就绪） 门控已前移到 `BotActor.executeSkill()`（机器人执行代理执行技能） 入口，`runtime-mineflayer-model` 与 `runtime-actor-model` 已覆盖 `spawn`（生成） 前拒绝、`spawn` 后放行。
  - `bash ts-core/scripts/pre_review.sh` 由 Coder（编码代理） 回填为全部通过，摘要为 26 个测试文件、123 条测试通过。
  - 本次审查未重复机械预检。

### T-023 — OpenAI 兼容闲聊最短闭环

- 审查状态：通过。
- 核心文件：
  - `ts-core/src/conversation/llm.ts`
  - `ts-core/src/conversation/index.ts`
  - `ts-core/src/workers/conversation-worker.ts`
  - `ts-core/src/diagnostics/contracts.ts`
  - `ts-core/src/diagnostics/logs.ts`
  - `ts-core/src/app/bootstrap.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/main.ts`
  - `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  - `ts-core/README.md`
  - `ts-core/.env.example`
- 变更快照：
  - 新增 `conversation/llm.ts`（对话大语言模型适配），使用原生 `fetch`（网络请求） 接入 OpenAI（开放人工智能） 兼容 `POST /chat/completions`（对话补全接口），并支持 `LLM_BASE_URL`（大语言模型基础地址） / `LLM_API_KEY`（接口密钥） / `LLM_MODEL`（模型名） 注入。
  - `ConversationWorker`（对话工作线程） 的普通 `chat`（闲聊） 路径现在可走真实 LLM（大语言模型） 回复，并留下最小 `llm`（大语言模型） JSONL（结构化日志） 诊断摘要；失败时显式抛出并保留失败摘要，不伪装成成功回复。
  - 确定性 `goTo`（前往坐标） 快路径保持不变；显式 `cancel`（取消） 经过两轮打回修复后，在线真实路径现已恢复为“最小分诊 → 运行时中断 → 模板回执”，不再误走 LLM（大语言模型） 闲聊，也不再只记 `cancel.logged`（取消已记录） 事件。
  - `startAppOnlineRuntime()`（真实在线启动入口） 已把 LLM（大语言模型） 配置、默认 `triage`（分诊） 与 `interruptRuntimeSink`（运行时中断汇点） 接入真实在线路径；`main.ts`（程序入口） 会从环境变量读取 `LLM_API_KEY`（接口密钥） 并注入在线入口。
  - `README.md`（说明文档） 与 `.env.example`（环境变量样例） 已补齐本地 OpenAI（开放人工智能） 兼容网关的最小手测步骤。
- 验收备注：
  - 两个打回点均已修复：先补上在线默认 `cancel`（取消） 分诊，再补齐 `cancel`（取消） 的真实中断与模板回执。
  - `bash ts-core/scripts/pre_review.sh` 由 Coder（编码代理） 回填为全部通过，摘要为 27 个测试文件、128 条测试通过。
  - 本次审查未重复机械预检。

### T-024 — 真实 LLM 最小分诊与 goTo 规划

- 审查状态：通过。
- 核心文件：
  - `ts-core/src/conversation/llm.ts`
  - `ts-core/src/workers/conversation-worker.ts`
  - `ts-core/src/app/entrypoint.ts`
  - `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
  - `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- 变更快照：
  - OpenAI（开放人工智能） 兼容客户端已从“只会闲聊”扩到最小 `triage`（分诊） + `goTo`（前往坐标） `plan`（规划）：新增 `generateTriage()`（生成分诊） 与 `generateGoToPlan()`（生成前往坐标规划），统一复用同一套 `chat.completions`（对话补全） 调用与 JSON（结构化文本） 强校验边界。
  - `ConversationWorker`（对话工作线程） 已移除旧的正则 `goTo`（前往坐标） 快路径；`task`（任务） 现在统一走 `planner`（规划器） → `createExecJobFromPlan()`（由规划产物创建执行任务） → `bot:{botId}:exec`（执行队列） → `BotWorker`（机器人工作线程） / `BotActor.executeSkill()`（机器人执行代理执行技能） 真实执行链。规划失败时只回模板失败回执，不伪装成闲聊成功。
  - 真实在线入口 `startAppOnlineRuntime()`（在线启动入口） 已把 `triage`（分诊） / `chat`（闲聊） / `plan`（规划） 三条路径接到共享 LLM（大语言模型） 客户端；`cancel`（取消） 仍优先保留规则命中 + 中断 + 模板回执，不触发闲聊回复。
  - 打回修复采用方案 A：在线 `triage`（分诊） prompt 已收窄到只允许 `chat`（闲聊） / `task`（任务） / `cancel`（取消） 三类；若上游仍意外返回 `modify`（修改当前任务），在线入口会直接降级为 `chat/normal`（闲聊 / 普通），阻断“缺 `interrupted_task`（被中断任务摘要） 仍继续规划”的半通路。
- 验收备注：
  - 新增测试已锁住两类关键回归：`triage`（分诊） prompt 不再暴露 `modify`（修改当前任务），以及在线入口即使收到 `modify`（修改当前任务） 结果也不会触发 `planner`（规划器） / 执行入队。
  - `bash ts-core/scripts/pre_review.sh` 由 Coder（编码代理） 回填为全部通过，摘要为 28 个测试文件、136 条测试通过。
  - 本次审查未重复机械预检。
