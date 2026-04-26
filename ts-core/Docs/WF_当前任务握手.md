# 当前任务握手区

【任务序号】: T-032
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `conversation`（对话） + `workers/conversation-worker`（对话工作线程） + `app`（应用装配） 的边界内，把当前互斥单 intent（意图） triage（分诊） 升级为 composite output（复合输出） 的最小可运行模型，支持同一句消息同时表达 `cancel`（取消） + `reply`（回复） + `action`（动作） 并按固定顺序派发。目标是补齐 `WF_需求变更索引.md`（需求变更索引） 中“演进阶段二：triage 输出从单 intent 升级为 composite”的缺口，同时保持旧单 intent（意图） 路径向后兼容，不新增技能，不改变 BotActor（机器人执行代理） 单写者语义。

**上下文说明**:
1. `T-031`（任务三十一） 已完成 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，解决“执行中被问状态但回复不知道自己在干嘛”的缺口。
2. 当前 `MessageTriage`（消息分诊） 是互斥单选：`chat`（闲聊） / `task`（任务） / `cancel`（取消） / `modify`（修改）。这会让“停下，回我一句知道了，然后去坐标 1 64 -3”这类复合消息被迫二选一。
3. 本轮只升级 conversation（对话） 路由与 LLM（大语言模型） 分诊表达，不改 BotWorker（机器人工作线程） 的执行语义，不改 BotActor（机器人执行代理） 的状态机，不新增 Mineflayer（Minecraft 协议客户端） 动作能力。
4. `cancel`（取消）、`reply`（回复）、`action`（动作） 的派发顺序必须固定为：先中断当前动作，再广播回复，再入队动作。不得出现“先入队动作再取消”的逆序。
5. 本任务触碰 LLM（大语言模型） Prompt（提示词）、解析与在线入口装配，验收必须包含真实 OpenAI（开放人工智能） 兼容 API（应用程序接口）调用结果或人工手测步骤。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 3 节《Minecraft 事实来源约束》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《三队列异步架构》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》；第 2 节《状态机完整定义》；第 3 节《中断协议详细规格》
5. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 2 节《两阶段 LLM 调用模型》；第 3 节《Stage 1: Triage Prompt 设计》；第 4 节《Stage 2-Chat: 闲聊回复》；第 5 节《Stage 2-Plan: 任务规划》；第 11 节《回复广播与事件发射》；第 15 节《错误处理与降级》；第 16 节《LLM 客户端抽象》
6. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-24 — Triage（分诊） 架构演进备案：状态注入 + Composite Output（复合输出）` 中“演进阶段二”小节；`2026-04-26 — 真实 LLM API 验收成为长期规则`
7. `ts-core/Docs/WF_开发进度记录.md` — `T-031`（任务三十一） 记录
8. `ts-core/Docs/WF_任务阶段压缩记录.md` — `批次 T-021 ~ T-030`
9. `ts-core/scripts/pre_review.sh` — 全文件（只读）
10. `ts-core/package.json` — 全文件（只读；原则上不修改依赖）
11. `ts-core/tsconfig.json` — 全文件（只读）
12. `ts-core/src/core-ports/foundation.ts` — 全文件（仅允许新增 composite（复合） 分诊所需纯类型或兼容导出）
13. `ts-core/src/core-ports/tasking.ts` — 全文件（只读优先；仅允许优先级映射需要的类型适配）
14. `ts-core/src/core-ports/index.ts` — 全文件（仅允许导出适配）
15. `ts-core/src/conversation/contracts.ts` — 全文件
16. `ts-core/src/conversation/triage.ts` — 全文件
17. `ts-core/src/conversation/chat.ts` — 全文件（仅允许回复后处理或复合 reply（回复） 适配）
18. `ts-core/src/conversation/planning.ts` — 全文件（只读优先；仅允许复合 action（动作） 入队适配）
19. `ts-core/src/conversation/index.ts` — 全文件（仅允许导出适配）
20. `ts-core/src/conversation/llm.ts` — 全文件（仅允许导出适配）
21. `ts-core/src/conversation/llm/types.ts` — 全文件
22. `ts-core/src/conversation/llm/client.ts` — 全文件
23. `ts-core/src/conversation/llm/messages.ts` — 全文件
24. `ts-core/src/conversation/llm/parsers.ts` — 全文件
25. `ts-core/src/conversation/llm/prompts/triage.ts` — 全文件
26. `ts-core/src/conversation/llm/prompts/index.ts` — 全文件（仅允许导出适配）
27. `ts-core/src/conversation/llm/diagnostics.ts` — 全文件（只读优先；仅允许诊断阶段字段兼容）
28. `ts-core/src/conversation/llm/stage.ts` — 全文件（只读，不改 `executeStage`（阶段执行模板） 语义）
29. `ts-core/src/workers/contracts.ts` — 全文件（只读优先；仅允许 worker action（工作线程动作） 契约适配）
30. `ts-core/src/workers/conversation-worker/types.ts` — 全文件
31. `ts-core/src/workers/conversation-worker/runtime.ts` — 全文件
32. `ts-core/src/workers/conversation-worker/helpers.ts` — 全文件
33. `ts-core/src/workers/conversation-worker/events.ts` — 全文件（仅允许复合派发事件需要的类型适配）
34. `ts-core/src/workers/conversation-worker/handlers/cancel-interrupt.ts` — 全文件
35. `ts-core/src/workers/conversation-worker/handlers/chat-reply.ts` — 全文件
36. `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts` — 全文件
37. `ts-core/src/workers/conversation-worker/index.ts` — 全文件（仅允许导出适配）
38. `ts-core/src/workers/conversation-worker.ts` — 全文件（仅允许导出适配）
39. `ts-core/src/app/entrypoint.ts` — 全文件
40. `ts-core/src/app/index.ts` — 全文件（仅允许导出适配）
41. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
42. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
43. `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts` — 全文件
44. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件
45. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
46. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因公共类型、导出或编译失败导致的最小适配）

**核心逻辑要求**:

1. **复合分诊契约**:
   - 新增 `ConversationCompositeTriage`（对话复合分诊） 或同等强类型结构，至少能表达：
     - `cancel`（取消）：可选，包含 `reason`（原因） 与优先级 / 中断语义；
     - `reply`（回复）：可选，包含要广播给用户的短文本；
     - `action`（动作）：可选，表示需要进入现有 planner（规划器） 的任务意图，不直接携带 Mineflayer（Minecraft 协议客户端） 写能力。
   - 保留旧 `MessageTriage`（消息分诊） 与 `createMessageTriage()`（创建消息分诊） 兼容路径；旧单 intent（意图） 输入必须可适配为 composite（复合） 结构。
   - 不允许重新引入在线 `modify`（修改） 半通路；若 LLM（大语言模型） 返回 `modify`（修改） 或未知字段，应降级到安全的 chat/reply（闲聊 / 回复） 或 legacy（旧） 回退，不得误进 planner（规划器）。

2. **固定派发顺序**:
   - ConversationWorker（对话工作线程） 必须按 `cancel → reply → action` 顺序派发复合结果。
   - 若同时存在 `cancel`（取消） 和 `action`（动作），必须先调用 `interruptRuntimeSink`（运行时中断汇点），再广播回复，再调用 planner（规划器） 并入 `bot:{botId}:exec`（执行队列）。
   - 若存在显式 `reply`（回复） 和 `action`（动作），不得再重复广播 planner（规划器） 返回的 `plan.reply`（规划开场回复）；没有显式 `reply`（回复） 时，仍保留现有 `plan.reply`（规划开场回复） 行为。
   - `chat_reply`（闲聊回复） 的状态投影逻辑必须保留；复合结果只有纯 `reply`（回复） 且无 `action`（动作） 时，仍应能复用 T-031（任务三十一） 的状态上下文。

3. **LLM（大语言模型） 分诊升级**:
   - triage prompt（分诊提示词） 应改为要求输出 composite JSON（复合结构化数据），而不是互斥 `intent`（意图） 单字段；但解析器必须兼容旧 `{intent, priority, reason}`（旧分诊结构） 响应。
   - 新结构不得要求 LLM（大语言模型） 直接生成技能参数；`action`（动作） 只表示“需要规划”，具体 `skill_call`（技能调用） 仍由现有 planner（规划器） 生成。
   - `generateTriage()`（生成分诊） 若保留旧返回类型，必须新增清晰命名的 composite（复合） 能力或适配层，避免类型名与实际语义不一致。

4. **在线入口装配**:
   - `startAppOnlineRuntime()`（真实在线启动入口） 默认使用真实 LLM（大语言模型） composite triage（复合分诊） 路径；显式测试注入依赖仍可覆盖默认分诊。
   - 不修改 OpenAI（开放人工智能） 兼容请求的 `base_url`（基础地址） / `api_key`（接口密钥） / `model`（模型） 配置语义。
   - 不新增第三方依赖，不改 BullMQ（任务队列） 队列命名，不改 BotWorker（机器人工作线程） 消费模型。

5. **行为不回归**:
   - 旧单 intent（意图） 场景仍保持：纯 chat（闲聊） 会回复，纯 cancel（取消） 会中断 + 回执，纯 task（任务） 会规划 + 入队。
   - T-031（任务三十一） 的“执行中闲聊回复可写回游戏”能力不得回退。
   - `sandbox_code`（沙箱代码） 执行链路不得被本任务改坏；本轮不扩展沙箱 API（应用程序接口） 或渐进披露机制。

6. **真实 LLM（大语言模型） API（应用程序接口） 验收闭环**:
   - 本任务触碰 LLM（大语言模型） Prompt（提示词）、解析与在线入口装配，不能只以 mock（模拟）测试作为最终验收。
   - 若 Coder（编码代理） 环境能访问本地 OpenAI（开放人工智能） 兼容网关，必须记录一次真实 composite triage（复合分诊） 调用，推荐触发消息：`停下当前任务，回我一句知道了，然后去坐标 1 64 -3`。
   - 若环境不可达，必须回填用户可执行的最短人工手测步骤，使用 `LLM_BASE_URL`（大语言模型基础地址）=`http://127.0.0.1:8045/v1`、`LLM_API_KEY`（大语言模型接口密钥）=`sk-local-dev`、`LLM_MODEL`（大语言模型模型名）=`bl-auto`。
   - 真实调用的通过标准：模型输出或系统解析后的结果能同时包含 cancel（取消） / reply（回复） / action（动作） 语义，并按固定顺序派发或可被测试证明确认。

**验收标准**:

1. `conversation`（对话） 层有强类型 composite triage（复合分诊） 契约和工厂 / 解析逻辑，兼容旧 `{intent, priority, reason}`（旧分诊结构），非法或未知输出会安全降级。
2. ConversationWorker（对话工作线程） 对 `cancel + reply + action`（取消 + 回复 + 动作） 的派发顺序固定为中断、回复、规划入队；有显式 reply（回复） 时不会重复广播 `plan.reply`（规划开场回复）。
3. 纯 chat（闲聊）、纯 cancel（取消）、纯 task（任务） 的既有行为不回归；T-031（任务三十一） 的状态上下文注入仍在纯回复路径生效。
4. 在线入口默认接入真实 LLM（大语言模型） composite triage（复合分诊），测试注入仍能覆盖；OpenAI（开放人工智能） 兼容配置字段不变。
5. 新增 / 更新测试覆盖 composite 解析、旧结构兼容、非法输出降级、三段有序派发、显式 reply（回复） 抑制重复 planner reply（规划器回复）、在线入口请求与派发；`bash ts-core/scripts/pre_review.sh` 全部通过，并在反馈区包含真实 LLM（大语言模型） API（应用程序接口）调用结果或人工手测步骤。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-032`
- [ ] 仅读取并修改白名单内文件
- [ ] composite triage（复合分诊） 为强类型结构，旧 `MessageTriage`（消息分诊） 路径向后兼容
- [ ] 派发顺序固定为 `cancel → reply → action`，且测试能证明顺序
- [ ] 有显式 reply（回复） + action（动作） 时不会重复广播 `plan.reply`（规划开场回复）
- [ ] `chat_reply`（闲聊回复） 状态投影、cancel（取消）、plan（规划）、skill_call（技能调用）、sandbox_code（沙箱代码） 既有行为未回退
- [ ] 未新增第三方依赖，未修改 OpenAI（开放人工智能） 兼容配置语义
- [ ] 反馈区包含真实 LLM（大语言模型） API（应用程序接口） 调用结果；若环境不可达，则包含用户可执行的最短人工手测步骤与预期结果
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-033**: 在 `data`（数据层） + `workers`（工作线程） 内恢复 BrainWorker（摘要工作线程） 任务摘要与可检索记忆沉淀，先落最小摘要写入与读取端口。
- **T-034**: 在 `interfaces`（接口层） + `realtime`（实时推送） + `app`（应用装配） 内推进网页轻面板的最小状态 / 消息 / 事件同步接口，为后续网站控制女仆做前置。
- **T-035**: 在 `conversation`（对话） + `sandbox`（沙箱） + `diagnostics`（诊断） 内补最小经验沉淀钩子，只记录 sandbox_code（沙箱代码） 成败轨迹，不做向量检索闭环。
