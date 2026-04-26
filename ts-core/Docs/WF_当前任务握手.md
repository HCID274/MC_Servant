# 当前任务握手区

【任务序号】: T-031
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） + `runtime`（运行时） 的最小边界内，为 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 当前状态的只读投影，让女仆在执行任务或刚执行过动作时能回答“你在干嘛 / 现在状态怎样”这类问题。目标是补齐 `WF_需求变更索引.md`（需求变更索引） 中“阶段一：chat_reply 注入 actor 状态快照”的缺口，不改变 triage（分诊） 输出形态，不新增技能，不改 BotActor（机器人执行代理） 单写者语义。

**上下文说明**:
1. `T-021`（任务二十一） 到 `T-030`（任务三十） 已完成真实 MC（Minecraft，我的世界） 上线、OpenAI（开放人工智能） 兼容 LLM（大语言模型）、多技能、观测出口、sandbox_code（沙箱代码） 与架构治理收口；本轮不得回退这些路径。
2. 当前 `chat_reply`（闲聊回复） 路径的 `generateChatReply()`（生成闲聊回复） 只拿到用户消息，在线入口未向 `memory_context`（记忆上下文） 或独立状态字段注入 BotActor（机器人执行代理） 状态。因此用户问“你在干嘛”时，回复可能不知道正在执行或刚执行的任务。
3. 本轮只做 **只读状态投影**：ConversationWorker（对话工作线程） / LLM（大语言模型） 只能读取短摘要，不能持有或操作 Bot（机器人） 句柄，不能绕过 BotActor（机器人执行代理） 单写者入口。
4. `T-028`（任务二十八） 已建立 `core-ports`（核心端口层） 与无循环依赖守门；本轮不得让 `conversation`（对话） 直接 import（导入） `runtime/actor.ts`（运行时执行代理实现） 或 `app`（应用装配） 实现。
5. 状态摘要必须短、稳定、可降级：无投影 / 读取失败时继续无状态闲聊，不得阻断 chat（闲聊） 回复路径。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 9 节《编码规范》；第 11 节《文档规则》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《三队列模型》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》；第 2 节《状态机完整定义》；第 5 节《任务执行流》；第 9 节《诊断事件清单》
5. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 2 节《两阶段 LLM 调用模型》；第 4 节《Stage 2-Chat: 闲聊回复》；第 7 节《Context Assembly》；第 10 节《对话历史窗口》；第 14 节《人设一致性保障》；第 15 节《错误处理与降级》；第 16 节《LLM 客户端抽象》
6. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-24 — Triage（分诊） 架构演进备案：状态注入 + Composite Output（复合输出）` 中“演进阶段一”小节
7. `ts-core/Docs/WF_任务阶段压缩记录.md` — `批次 T-021 ~ T-030`
8. `ts-core/scripts/pre_review.sh` — 全文件（只读）
9. `ts-core/package.json` — 全文件（只读；原则上不修改依赖）
10. `ts-core/tsconfig.json` — 全文件（只读）
11. `ts-core/src/core-ports/runtime.ts` — 全文件（仅允许新增只读投影相关纯类型）
12. `ts-core/src/core-ports/tasking.ts` — 全文件（只读优先；仅允许投影类型需要的导出适配）
13. `ts-core/src/core-ports/events.ts` — 全文件（只读优先；仅允许投影类型需要的导出适配）
14. `ts-core/src/core-ports/index.ts` — 全文件（仅允许导出适配）
15. `ts-core/src/runtime/actor.ts` — 全文件
16. `ts-core/src/runtime/contracts.ts` — 全文件（仅允许导入路径或类型适配）
17. `ts-core/src/runtime/index.ts` — 全文件（仅允许导出适配）
18. `ts-core/src/conversation/llm.ts` — 全文件（仅允许导出适配）
19. `ts-core/src/conversation/llm/types.ts` — 全文件
20. `ts-core/src/conversation/llm/messages.ts` — 全文件
21. `ts-core/src/conversation/llm/prompts/chat.ts` — 全文件
22. `ts-core/src/conversation/llm/client.ts` — 全文件（仅允许类型适配，不改 `executeStage`（阶段执行模板） 语义）
23. `ts-core/src/conversation/index.ts` — 全文件（仅允许导出适配）
24. `ts-core/src/workers/conversation-worker.ts` — 全文件（仅允许导出适配）
25. `ts-core/src/workers/conversation-worker/types.ts` — 全文件
26. `ts-core/src/workers/conversation-worker/handlers/chat-reply.ts` — 全文件
27. `ts-core/src/workers/conversation-worker/runtime.ts` — 全文件
28. `ts-core/src/workers/conversation-worker/helpers.ts` — 全文件（仅允许投影上下文的最小辅助）
29. `ts-core/src/workers/index.ts` — 全文件（仅允许导出适配）
30. `ts-core/src/app/entrypoint.ts` — 全文件
31. `ts-core/src/app/bootstrap.ts` — 全文件（仅允许导出适配）
32. `ts-core/src/app/bootstrap/**` — 全部文件（仅允许类型导入适配，不改变启动顺序）
33. `ts-core/src/diagnostics/contracts.ts` — 全文件（仅允许投影事件摘要需要的类型适配）
34. `ts-core/src/diagnostics/logs.ts` — 全文件（只读）
35. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts` — 全文件
37. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
38. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 全文件
39. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因导入路径、公共导出或投影类型变化导致的最小适配）

**核心逻辑要求**:

1. **只读投影边界**:
   - 可以在 `core-ports`（核心端口层） 新增 `BotActorStateProjection`（机器人执行代理状态投影） 或同等纯类型，用于描述 `status`（状态）、当前 / 最近任务摘要、最近技能、最近沙箱终态、`world_ready`（世界交互就绪） 等短信息。
   - Projection（投影） 必须是只读快照或只读文本摘要；不得暴露 Mineflayer（Minecraft 协议客户端） Bot（机器人） 句柄、transport（传输） 实例、AbortController（中断控制器） 或任何写能力。
   - `conversation`（对话） 与 `workers`（工作线程） 只能依赖端口类型或注入函数，不得直接 import（导入） `runtime/actor.ts`（运行时执行代理实现）。

2. **状态摘要注入到 chat_reply（闲聊回复）**:
   - 在 ConversationWorker（对话工作线程） 的 chat（闲聊） 路径增加可选依赖，例如 `chatContextProvider`（闲聊上下文提供器） / `actorStateProjectionProvider`（执行代理状态投影提供器） / 同等命名。
   - 该依赖只在 `chat_reply`（闲聊回复） 分支调用，`cancel`（取消） 与 `plan_exec`（规划执行） 不应调用。
   - 默认无依赖时保持当前行为；依赖抛错或返回空摘要时，必须降级为无状态闲聊，不得导致消息处理失败。

3. **LLM（大语言模型） 输入表达清晰**:
   - `generateChatReply()`（生成闲聊回复） 的消息构造应能区分“记忆摘要”和“当前状态摘要”。可以新增内部字段（例如 `state_context`（状态上下文）），或在 chat prompt（闲聊提示词） 中明确标注“当前状态”；不要继续把运行时状态伪装成长期记忆。
   - 状态摘要应控制在短文本内，建议 50~100 token（令牌） 量级；不得把完整 `BotActorRuntimeSnapshot`（运行时快照） 直接塞进 Prompt（提示词）。
   - 若状态为 `executing`（执行中） 或最近有 `skill_executions`（技能执行记录） / `sandbox_executions`（沙箱执行记录），摘要应能让 LLM（大语言模型） 回答“我正在 / 刚刚在做什么”。

4. **在线入口装配**:
   - `startAppOnlineRuntime()`（真实在线启动入口） 应默认注入投影提供器，从 `createdRuntime.actor.getSnapshot()`（获取执行代理快照） 或更窄的只读 adapter（适配器） 生成摘要。
   - 装配顺序不得改变：PostgreSQL（关系型数据库） / Redis（缓存） → BullMQ（任务队列） / Fastify（接口网关） → Mineflayer（Minecraft 协议客户端） → BotActor（机器人执行代理） → workers（工作线程）。
   - 测试注入的 `conversationWorker`（对话工作线程） 依赖仍应能覆盖默认依赖，不能破坏现有手测路径。

5. **行为不回归**:
   - `triage`（分诊）、`plan`（规划）、`cancel`（取消）、`skill_call`（技能调用）、`sandbox_code`（沙箱代码）、`status`（状态接口） / `replay`（回放接口） 行为不变。
   - `chat_reply`（闲聊回复） 仍经 `broadcastReplySink`（广播回复汇点） 写回游戏，不得绕过 BotActor（机器人执行代理）。
   - 不新增第三方依赖，不修改 OpenAI（开放人工智能） 兼容请求 URL（统一资源定位符） / header（请求头） / model（模型） 字段。

6. **真实 LLM（大语言模型） API（应用程序接口） 验收闭环**:
   - 本任务触碰 `chat_reply`（闲聊回复） 的 LLM（大语言模型） 输入，因此不能只以 mock（模拟）测试作为最终验收。
   - 若 Coder（编码代理） 环境能访问本地 OpenAI（开放人工智能） 兼容网关，必须在反馈区记录一次真实调用的启动命令、触发消息、关键输出与结果判断。
   - 若 Coder（编码代理） 环境不能访问网关，必须在反馈区给出用户可执行的最短人工手测步骤，使用 `LLM_BASE_URL`（大语言模型基础地址）=`http://127.0.0.1:8045/v1`、`LLM_API_KEY`（大语言模型接口密钥）=`sk-local-dev`、`LLM_MODEL`（大语言模型模型名）=`bl-auto`。
   - Manager（管理代理） 审查代码后，需要把人工手测步骤转述给用户；用户回报真实调用结果前，不把涉及 LLM（大语言模型） 的验收视为最终闭环。

**验收标准**:

1. ConversationWorker（对话工作线程） 的 `chat_reply`（闲聊回复） 路径会读取可选只读状态投影，并把短状态摘要传入 replyGenerator（回复生成器） 或 LLM（大语言模型） chat input（闲聊输入）；默认无投影时保持原行为。
2. `createConversationChatMessages()`（创建对话闲聊消息） 或等价消息构造能在 system prompt（系统提示词） 中明确包含“当前状态摘要”，并与“记忆摘要”分开表达。
3. `startAppOnlineRuntime()`（真实在线启动入口） 默认从 BotActor（机器人执行代理） 快照生成只读状态摘要并注入在线 chat（闲聊） 回复生成；状态读取失败时降级，不影响回复写回。
4. 新增测试覆盖：执行中 / 有最近技能记录时的状态摘要注入、无投影降级、投影失败降级、`cancel`（取消） / `plan`（规划） 不触发状态注入，以及在线入口真实装配路径的 LLM（大语言模型） 请求包含状态摘要。
5. `bash ts-core/scripts/pre_review.sh` 全部通过；同时反馈区必须包含真实 OpenAI（开放人工智能） 兼容 LLM（大语言模型） API（应用程序接口） 调用结果，或在环境不可达时包含最短人工手测步骤与预期结果，供 Manager（管理代理） 等待用户回报后最终判定。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-031`
- [ ] 仅读取并修改白名单内文件
- [ ] 未让 `conversation`（对话） 或 `workers`（工作线程） 直接依赖 `runtime/actor.ts`（运行时执行代理实现）
- [ ] 状态投影为只读摘要，不暴露 Mineflayer（Minecraft 协议客户端） Bot（机器人） 句柄或写能力
- [ ] `chat_reply`（闲聊回复） 状态注入失败时能安全降级为无状态闲聊
- [ ] `cancel`（取消） / `plan`（规划） / `skill_call`（技能调用） / `sandbox_code`（沙箱代码） 既有行为未改变
- [ ] 新增或更新测试覆盖验收标准中的关键路径
- [ ] 反馈区包含真实 LLM（大语言模型） API（应用程序接口） 调用结果；若环境不可达，则包含用户可执行的最短人工手测步骤与预期结果
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 回填）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-032**: 在 `conversation`（对话） 内把 triage（分诊） 输出从单 intent（意图） 升级为 composite output（复合输出），支持 cancel（取消） + reply（回复） + action（动作） 的有序派发。
- **T-033**: 在 `data`（数据层） + `workers`（工作线程） 内恢复 BrainWorker（摘要工作线程） 任务摘要与可检索记忆沉淀，先落最小摘要写入与读取端口。
- **T-034**: 在 `interfaces`（接口层） + `realtime`（实时推送） + `app`（应用装配） 内推进网页轻面板的最小状态 / 消息 / 事件同步接口，为后续网站控制女仆做前置。
