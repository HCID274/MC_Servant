# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-031` ~ `T-040`
- 当前已完成任务：`T-031`、`T-032`、`T-033`、`T-034`、`T-035`、`T-036`、`T-037`
- 当前活跃任务：`T-038`（任务三十八） BotActor（机器人执行代理） 脊髓反射动作硬编码。
- 当前批次摘要：上一批次 `T-021`（任务二十一） 到 `T-030`（任务三十） 已完成 MC（Minecraft，我的世界） 上线闭环、真实 LLM（大语言模型） 接入、多技能、观测出口、sandbox_code（沙箱代码） 与架构治理。新批次默认继续沿可运行主干推进对话智能增强。
- 当前批次硬约束：不得回退 `T-021` 到 `T-030` 已形成的真实在线路径、单写者路径、无循环依赖图、OpenAI（开放人工智能） 兼容配置边界与 sandbox_code（沙箱代码） 执行安全边界。

---

## 详细记录

### T-031（已完成）

- **任务主题**: `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 当前状态只读投影。
- **审查时间**: 2026-04-26T21:17:43+09:00
- **核心文件**:
  - `src/core-ports/runtime.ts`
  - `src/runtime/actor.ts`
  - `src/conversation/llm/types.ts`
  - `src/conversation/llm/messages.ts`
  - `src/conversation/llm/prompts/chat.ts`
  - `src/workers/conversation-worker/types.ts`
  - `src/workers/conversation-worker/helpers.ts`
  - `src/workers/conversation-worker/handlers/chat-reply.ts`
  - `src/app/entrypoint.ts`
  - `src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `src/__tests__/conversation-llm-runtime-model.spec.ts`
  - `src/__tests__/app-entrypoint-model.spec.ts`
  - `src/__tests__/runtime-actor-model.spec.ts`
- **变更快照**:
  - 新增 `BotActorStateProjection`（机器人执行代理状态投影） 与短摘要工厂，投影只暴露状态、ready（就绪）、world_ready（世界交互就绪）、当前任务、最近技能与最近 sandbox（沙箱） 终态摘要，不暴露 Mineflayer（Minecraft 协议客户端） Bot（机器人） 句柄、transport（传输） 或中断控制器。
  - `ConversationWorker`（对话工作线程） 的 `chat_reply`（闲聊回复） 分支新增可选 `actorStateProjectionProvider`（执行代理状态投影提供器），只在闲聊路径读取；无投影、空摘要或读取失败均降级为无状态闲聊。
  - `generateChatReply()`（生成闲聊回复） 输入新增 `state_context`（状态上下文），chat prompt（闲聊提示词） 将“记忆摘要”和“当前状态摘要”分开表达。
  - `startAppOnlineRuntime()`（真实在线启动入口） 默认从 BotActor（机器人执行代理） 快照生成只读状态投影并注入在线闲聊回复生成，不改变基础设施、runtime（运行时） 与 worker（工作线程） 启动顺序。
  - 打回修复后，`broadcastReply()`（广播回复） 使用聊天专用准入：允许 `IDLE`（空闲） 与 `EXECUTING`（执行中） 且外部认证满足时通过 BotActor（机器人执行代理） 单写者入口写回游戏；动作任务执行门控未放宽。
  - 打回修复后，最近 sandbox_code（沙箱代码） 投影保留 `completed`（完成） / `failed`（失败） / `interrupted`（已中断） 真实终态，不再把 `interrupted`（已中断） 压成 `failed`（失败）。
- **审查结论**:
  - 通过。T-031（任务三十一） 已闭合“执行中问状态但回复写不回游戏”的主路径问题，并保留 sandbox（沙箱） 中断语义。
  - Coder（编码代理） 已回填真实 OpenAI（开放人工智能） 兼容 LLM（大语言模型） API（应用程序接口） 调用结果：本地网关返回 `200`，`generateChatReply()`（生成闲聊回复） 能读取 `state_context`（状态上下文） 并按正在执行 `mine`（挖掘） 回答。
- **验证记录**:
  - Manager（管理代理） 复跑 `cd ts-core && pnpm vitest run src/__tests__/runtime-actor-model.spec.ts src/__tests__/app-entrypoint-model.spec.ts`：2 个测试文件、24 条测试通过。
  - Manager（管理代理） 复跑 `cd ts-core && pnpm exec tsc --noEmit`：通过。
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 28 个测试文件、165 条测试全部通过。

### T-032（已完成）

- **任务主题**: composite triage（复合分诊） 与 `cancel`（取消） / `reply`（回复） / `action`（动作） 有序派发。
- **审查时间**: 2026-04-26T21:43:50+09:00
- **核心文件**:
  - `src/conversation/contracts.ts`
  - `src/conversation/triage.ts`
  - `src/conversation/llm/types.ts`
  - `src/conversation/llm/client.ts`
  - `src/conversation/llm/parsers.ts`
  - `src/conversation/llm/prompts/triage.ts`
  - `src/workers/conversation-worker/types.ts`
  - `src/workers/conversation-worker/runtime.ts`
  - `src/workers/conversation-worker/handlers/plan-exec.ts`
  - `src/app/entrypoint.ts`
  - `src/__tests__/conversation-workers-model.spec.ts`
  - `src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `src/__tests__/conversation-llm-planning-model.spec.ts`
  - `src/__tests__/app-entrypoint-model.spec.ts`
- **变更快照**:
  - 新增 `ConversationCompositeTriage`（对话复合分诊） 强类型契约，支持 `cancel`（取消） / `reply`（回复） / `action`（动作） 任意组合，同时保留旧 `MessageTriage`（消息分诊） 与 `{intent, priority, reason}`（旧结构） 兼容适配。
  - `triage prompt`（分诊提示词） 改为 composite JSON（复合结构化数据），解析器兼容旧单意图输出，并把 `modify`（修改） 或未知 action（动作） 安全降级到 reply（回复） 路径，不重新打开在线 modify（修改） 半通路。
  - `ConversationWorker`（对话工作线程） 对复合结果固定按 `cancel → reply → action`（取消 → 回复 → 动作） 派发；存在显式 reply（回复） 时抑制 `plan.reply`（规划器回复） 二次广播。
  - `startAppOnlineRuntime()`（真实在线启动入口） 默认接入 `generateCompositeTriage()`（生成复合分诊），OpenAI（开放人工智能） 兼容配置字段、BullMQ（任务队列） 队列名、BotActor（机器人执行代理） 单写者边界未改变。
- **审查结论**:
  - 通过。T-032（任务三十二） 已闭合“同一句话同时包含取消、回复、新动作”时语义丢失的问题，旧 chat（闲聊） / cancel（取消） / task（任务） 路径保持兼容。
  - Coder（编码代理） 已回填真实 OpenAI（开放人工智能） 兼容 LLM（大语言模型） API（应用程序接口） 调用结果：本地网关返回的结构包含 `cancel.reason`、`reply.content` 与 `action.intent=task`。
- **验证记录**:
  - Manager（管理代理） 复跑 `cd ts-core && pnpm vitest run src/__tests__/conversation-workers-model.spec.ts src/__tests__/conversation-worker-runtime-model.spec.ts src/__tests__/conversation-llm-planning-model.spec.ts src/__tests__/app-entrypoint-model.spec.ts`：4 个测试文件、42 条测试通过。
  - Manager（管理代理） 复跑 `cd ts-core && pnpm exec tsc --noEmit`：通过。
  - Manager（管理代理） 复核本地真实 OpenAI（开放人工智能） 兼容网关：`POST /v1/chat/completions` 对测试消息返回 `cancel`（取消） / `reply`（回复） / `action`（动作） 三类语义。
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 28 个测试文件、170 条测试全部通过。

### T-033（已完成）

- **任务主题**: BrainWorker（摘要工作线程） 最小摘要写入链路与可检索 memory（记忆）端口。
- **审查时间**: 2026-04-26T22:01:02+09:00
- **核心文件**:
  - `src/data/contracts/task-history.ts`
  - `src/workers/brain-worker.ts`
  - `src/workers/index.ts`
  - `src/__tests__/data-model.spec.ts`
  - `src/__tests__/brain-worker-runtime-model.spec.ts`
- **变更快照**:
  - data（数据层）新增 `TaskSummarySource`（任务摘要来源） / `TaskSummaryDraft`（任务摘要草案） / `TaskSummary`（任务摘要） / `TaskMemorySearchResult`（任务记忆检索结果）契约，稳定摘要标识采用 `task-summary:{bot_id}:{message_id}`（任务摘要：机器人标识：消息标识）。
  - 新增 `createDeterministicTaskSummaryText()`（创建确定性任务摘要文本） 与 `createTaskSummaryDraft()`（创建任务摘要草案），只允许 `completed`（已完成） / `failed`（已失败） / `interrupted`（已中断） 写入摘要，拒绝 `discarded`（已丢弃） 与空摘要。
  - 新增 `createMemoryContextFromTaskSummaries()`（由任务摘要生成记忆上下文），按 score（分数） / `created_at`（创建时间） / `id`（标识） 稳定排序，并支持 limit（数量上限） 与字符预算截断。
  - 新增 `createBrainWorkerRuntime()`（创建摘要工作线程运行时），通过 DI（依赖注入）消费 `brain`（摘要队列）任务，依序读取 source（来源）、生成 summary（摘要）、可选生成 embedding（向量嵌入）、持久化 task_summaries（任务摘要），并记录成功 / 失败事件。
  - BrainWorker（摘要工作线程）保持只读历史 / 日志、只写摘要的边界，不导入 runtime transport（运行时传输）、BotActor（机器人执行代理）实现或 Mineflayer（Minecraft 协议客户端）适配器。
- **审查结论**:
  - 通过。T-033（任务三十三） 已补齐 Level 1（一级） 任务摘要链路和 memory（记忆）读取端口，本轮未触碰 LLM（大语言模型） 调用链路或 Prompt（提示词），因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- **验证记录**:
  - Manager（管理代理）复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 29 个测试文件、177 条测试全部通过。

### T-034（已完成）

- **任务主题**: 网页轻面板状态 / 消息 / 事件同步接口。
- **审查时间**: 2026-04-26T22:15:40+09:00
- **核心文件**:
  - `src/app/entrypoint.ts`
  - `src/__tests__/app-entrypoint-model.spec.ts`
- **变更快照**:
  - `startAppOnlineRuntime()`（启动真实在线运行时） 新增统一 `appendOnlineRealtimeEvent`（在线实时事件追加器），将进程内 replay store（补拉事件存储） 与用户注入的 `appendRealtimeEvent`（追加实时事件汇点） 组合调用，避免覆盖外部注入逻辑。
  - `ConversationWorker`（对话工作线程） 的广播回复在调用用户自定义 `broadcastReplySink`（广播回复汇点） 和 BotActor（机器人执行代理） 聊天广播后，追加 `chat.reply`（聊天回复） 到 replay（补拉）事件流。
  - `BotWorker`（机器人工作线程） 的 `emit_task_lifecycle`（发射任务生命周期） 动作转换为 `task.started`（任务已开始） / `task.discarded`（任务已丢弃） / `task.completed`（任务已完成） / `task.failed`（任务已失败） / `task.interrupted`（任务已中断） 事件；`enqueue_brain`（入摘要队列） 明确不伪装成 runtime（运行时） 事件。
  - 在线入口组合调用用户注入的 `actionSink`（动作汇点） 与 `broadcastReplySink`（广播回复汇点），并让 `/api/status`（状态接口） 的 `last_event_seq`（最后事件序号） 随 replay store（补拉事件存储） 更新。
  - 测试覆盖 worker（工作线程）动作转换、回复事件不可变载荷、自定义汇点组合、状态事件序号更新、`/api/replay`（补拉接口）读取 accepted（已接受） / reply（回复） / task（任务）事件。
- **审查结论**:
  - 通过。T-034（任务三十四） 已补齐网页轻面板后端最小同步闭环，未新增公开路由、依赖、WebSocket（全双工网页通信协议） 或 Socket.io（实时通信库） 物理服务。
  - 因本轮触碰 online entrypoint（在线入口装配），Manager（管理代理） 按长期规则补跑真实 OpenAI（开放人工智能） 兼容 API（应用程序接口） 最小验收；本地网关返回 `200`，输出包含 `OK`。
- **验证记录**:
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 29 个测试文件、179 条测试全部通过。
  - Manager（管理代理） 真实 API（应用程序接口） 验收命令摘要：`POST http://127.0.0.1:8045/v1/chat/completions`，`model`（模型）=`bl-auto`，输入为 T-034 online entrypoint smoke（在线入口冒烟） 消息；结果 `status=200`，`duration_ms=1815`，关键输出包含 `OK`。

### T-035（已完成）

- **任务主题**: sandbox_code（沙箱代码） 经验沉淀钩子与诊断摘要。
- **审查时间**: 2026-04-26T22:46:48+09:00
- **核心文件**:
  - `src/diagnostics/contracts.ts`
  - `src/diagnostics/logs.ts`
  - `src/workers/contracts.ts`
  - `src/workers/bot-worker.ts`
  - `src/__tests__/sandbox-diagnostics-model.spec.ts`
  - `src/__tests__/bot-worker-runtime-model.spec.ts`
  - `src/__tests__/runtime-worker-event-model.spec.ts`
- **变更快照**:
  - diagnostics（诊断）新增 `SandboxExperienceDraft`（沙箱经验草案） 与 `createSandboxExperienceDraft()`（创建沙箱经验草案），记录 `bot_id`（机器人标识）、`message_id`（消息标识）、`intent_epoch`（意图纪元）、终态、步骤数、耗时、`log_ref`（日志引用） / `code_ref`（代码引用）、`code_hash`（代码哈希） / 限长 `code_preview`（代码预览）、错误摘要与稳定短摘要。
  - `createSandboxExperienceDraft()`（创建沙箱经验草案） 只做纯转换，不写 PostgreSQL（关系型数据库）、Redis（缓存）、JSONL（结构化日志） 或向量库；输出通过深克隆 / 深冻结保持不可变。
  - diagnostics（诊断）脱敏逻辑覆盖 `sk-*` API key（接口密钥）、命名密码、连接串密码、注入敏感值，以及 `/home/...`、`/Users/...`、`C:\Users\...` 等宿主机敏感路径。
  - `BotWorkerAction`（机器人工作线程动作） 新增向后兼容的 `persist_sandbox_experience`（持久化沙箱经验）动作；仅 `sandbox_code`（沙箱代码） 的 `completed`（已完成） / `failed`（已失败） / `interrupted`（已中断） 终态追加，`skill_call`（技能调用）、`started`（已开始） 与 `discarded`（已丢弃） 不生成。
  - `BotWorker`（机器人工作线程） 在保留 `emit_task_lifecycle`（发射任务生命周期） 与 `enqueue_brain`（入摘要队列） 语义和顺序的基础上追加经验动作，供后续持久化层或检索层接入。
- **审查结论**:
  - 通过。T-035（任务三十五） 已补齐 sandbox_code（沙箱代码） 终态经验采集出口，未引入数据库写入、公开路由、新依赖或 LLM（大语言模型） Prompt（提示词） 变化。
  - 首轮打回项“宿主机敏感路径未脱敏”已修复；用户确认 `01_ARCHITECTURE.md`（架构文档） 为用户自行改动，作为本轮审查豁免，不纳入 T-035（任务三十五） 代码结论。
- **验证记录**:
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 29 个测试文件、181 条测试全部通过。
  - Manager（管理代理） 复跑 `git diff --check -- ':!ts-core/Docs/01_ARCHITECTURE.md'`：通过；排除项为用户豁免文档改动。
  - 本轮未触碰 LLM（大语言模型） Prompt（提示词） / parser（解析器） / 配置 / online entrypoint（在线入口装配），不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。

### T-036（已完成）

- **任务主题**: memory（记忆）上下文注入 chat（闲聊） / plan（规划） LLM（大语言模型）路径。
- **审查时间**: 2026-04-27T10:36:30+09:00
- **核心文件**:
  - `src/workers/conversation-worker/types.ts`
  - `src/workers/conversation-worker/helpers.ts`
  - `src/workers/conversation-worker/handlers/chat-reply.ts`
  - `src/workers/conversation-worker/handlers/plan-exec.ts`
  - `src/app/entrypoint.ts`
  - `src/__tests__/conversation-worker-runtime-model.spec.ts`
  - `src/__tests__/conversation-llm-planning-model.spec.ts`
  - `src/__tests__/app-entrypoint-model.spec.ts`
- **变更快照**:
  - `ConversationWorker`（对话工作线程） 新增 `ConversationMemoryContextProvider`（对话记忆上下文提供器） 可注入端口，输入包含 `bot_id`（机器人标识）、`message_id`（消息标识）、`intent_epoch`（意图纪元）、原始消息、route kind（路由类型）、查询原因、limit（数量上限） 与 char_budget（字符预算）。
  - `chat_reply`（闲聊回复） 仅在 `needs_memory_search=true`（需要记忆检索） 时读取 memory（记忆）；无 provider（提供器）、空返回或异常均降级为无记忆闲聊，并保持 `state_context`（状态上下文） 与 `memory_context`（记忆上下文） 分离注入。
  - `plan_exec`（规划执行） 与 `modify_interrupt_then_plan`（修改后规划） 在 planner（规划器） 前尝试读取 memory（记忆），provider（提供器）失败降级为无记忆规划，planner（规划器）自身失败语义不变。
  - 新增 `createConversationWorkerMemoryContext()`（创建对话工作线程记忆上下文） 与 `normalizeMemoryContext()`（归一化记忆上下文），复用 T-033（任务三十三） `createMemoryContextFromTaskSummaries()`（由任务摘要创建记忆上下文） 的排序、limit（数量上限） 和 char_budget（字符预算）语义，并对 provider（提供器）输出做非空与限长兜底。
  - `startAppOnlineRuntime()`（启动真实在线运行时） 继续通过 `conversationWorker`（对话工作线程） 依赖注入面接收 memory provider（记忆提供器），并把 `memory_context`（记忆上下文） 传入在线 `generateChatReply()`（生成闲聊回复） 与 `generateSkillPlan()`（生成技能规划）。
- **审查结论**:
  - 通过。T-036（任务三十六） 已闭合 memory（记忆）读取端口到 chat（闲聊） / plan（规划） LLM（大语言模型）输入链路，未新增数据库查询、向量检索算法、公开路由或额外服务。
  - Coder（编码代理） 已回填真实 OpenAI（开放人工智能） 兼容 API（应用程序接口） 验收；Manager（管理代理） 复跑真实调用，chat（闲聊） 与 plan（规划） 均可达且携带 `memory_context`（记忆上下文）。
- **验证记录**:
  - Manager（管理代理） 复跑 `cd ts-core && pnpm vitest run src/__tests__/conversation-worker-runtime-model.spec.ts src/__tests__/conversation-llm-planning-model.spec.ts src/__tests__/app-entrypoint-model.spec.ts`：3 个测试文件、35 条测试通过。
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 29 个测试文件、183 条测试全部通过。
  - Manager（管理代理） 真实 API（应用程序接口） 验收命令摘要：通过项目 `createConversationLlmClient()`（创建对话大语言模型客户端） 请求 `http://127.0.0.1:8045/v1`，`model`（模型）=`bl-auto`。chat（闲聊） 输出 `ok=true`，关键回复包含“当然记得”；plan（规划） 输出 `type=skill_call`、`skill=goTo`、`params={x:395,y:207,z:180}`。

### T-037（已完成）

- **任务主题**: `minecraft-data`（MC 事实包） 集成。
- **审查时间**: 2026-04-27T11:03:30+09:00
- **核心文件**:
  - `package.json`
  - `pnpm-lock.yaml`
  - `src/world-model/contracts.ts`
  - `src/world-model/minecraft-data.ts`
  - `src/world-model/index.ts`
  - `src/__tests__/observation-world-model.spec.ts`
  - `src/__tests__/scaffold.spec.ts`
- **变更快照**:
  - 新增运行时依赖 `minecraft-data`（MC 事实包），未新增其他依赖或服务。
  - `world-model/`（世界模型） 新增 `createMinecraftDataFactsPort()`（创建 MC 事实查询端口），通过显式 Minecraft（我的世界）版本加载版本化 registry（注册表），无效版本抛出清晰错误。
  - 新增 `MinecraftBlockFact`（MC 方块事实）、`MinecraftItemFact`（MC 物品事实）、`MinecraftRecipeFact`（MC 配方事实） 与 `MinecraftFactsQueryPort`（MC 事实查询端口）契约，支持 block（方块） / item（物品） 按 name（名称） 与 id（标识） 查询，以及 recipe（配方） 按 result item name（产出物品名称） 查询。
  - 查询未命中时 block（方块） / item（物品） 返回 `null`，recipe（配方） 返回空数组；非法输入和非法版本才抛错。
  - 查询输出通过克隆与冻结返回只读快照，不暴露 `minecraft-data`（MC 事实包） 原始可变对象引用。
  - `worldModelModuleBoundary`（世界模型模块边界） 与根入口导出已补齐；未接入 planner（规划器）、Prompt（提示词）、对话路由、数据库或网络服务。
- **审查结论**:
  - 通过。T-037（任务三十七） 已闭合“MC 常识 = 本地确定性 API（应用程序接口）查询”的最小通路，事实来源来自 `minecraft-data`（MC 事实包） registry（注册表）。
  - 本轮未触碰 LLM（大语言模型） 调用链路、Prompt（提示词）、parser（解析器） 或 online entrypoint（在线入口装配）的 T-037（任务三十七）新增差异，因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- **验证记录**:
  - Manager（管理代理） 复跑 `cd ts-core && pnpm vitest run src/__tests__/observation-world-model.spec.ts src/__tests__/scaffold.spec.ts`：2 个测试文件、16 条测试通过。
  - Manager（管理代理） 复跑 `bash ts-core/scripts/pre_review.sh`：madge（依赖图工具） 无循环依赖，TypeScript（类型检查） 通过，Biome（代码检查） 通过，Vitest（测试） 29 个测试文件、185 条测试全部通过。
  - Manager（管理代理） 复跑 `git diff --check` 与 `git diff --cached --check`：通过。
  - Manager（管理代理） 复核 `pnpm list minecraft-data --depth 0`：生产依赖仅新增 `minecraft-data@3.109.1`（MC 事实包）。
