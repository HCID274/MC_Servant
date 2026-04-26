# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-031` ~ `T-040`
- 当前已完成任务：`T-031`、`T-032`、`T-033`
- 当前活跃任务：`T-034`（任务三十四） 网页轻面板状态 / 消息 / 事件同步接口。
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
