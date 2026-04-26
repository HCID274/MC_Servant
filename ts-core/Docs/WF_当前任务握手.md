# 当前任务握手区

【任务序号】: T-033
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `data`（数据层） + `workers`（工作线程） 边界内补齐 BrainWorker（摘要工作线程） 的最小可运行摘要链路：BotWorker（机器人工作线程） 终态后进入 `brain`（摘要队列） 的任务，BrainWorker（摘要工作线程） 能通过注入式 source（来源） 读取任务历史 / JSONL（结构化日志） 摘要输入，生成并持久化 `task_summaries`（任务摘要） 记录；同时沉淀最小可检索 memory（记忆） 读取端口和上下文拼接工厂。目标是恢复 `05_DATA_SPEC.md`（数据规格） 第 7 节定义的 BrainWorker（摘要工作线程） Level 1（一级） 摘要能力，但本轮不接真实 embedding（向量嵌入） 服务、不改 ConversationWorker（对话工作线程） 的 LLM（大语言模型） Prompt（提示词）链路。

**上下文说明**:
1. `T-031`（任务三十一） 已完成 chat_reply（闲聊回复） 注入 BotActor（机器人执行代理） 状态投影；`T-032`（任务三十二） 已完成 composite triage（复合分诊） 与 `cancel → reply → action`（取消 → 回复 → 动作） 有序派发。
2. 目前 BotWorker（机器人工作线程） 的终态动作已能生成 `enqueue_brain`（入摘要队列） 动作，但 BrainWorker（摘要工作线程） 仍只有纯动作契约，没有真实消费运行时、摘要源读取端口、摘要持久化端口和 memory（记忆） 检索端口。
3. 本轮只做 Level 1（一级） 任务摘要与最小 memory（记忆） 读取端口，不做 Level 2（二级） 会话聚合，不做 pgvector（PostgreSQL 向量扩展）真实查询，不做 embedding（向量嵌入） API（应用程序接口）真实调用。
4. 本轮默认不触碰 LLM（大语言模型） 调用链路和 Prompt（提示词）。如 Coder（编码代理） 自行新增真实 LLM（大语言模型）摘要调用，则必须额外回填真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收结果；否则本任务不要求真实 LLM（大语言模型）验收。
5. 设计必须保持单写者约束：BrainWorker（摘要工作线程） 只读历史、读日志、写摘要，不得接触 Mineflayer（Minecraft 协议客户端） Bot（机器人）句柄、BotActor（机器人执行代理）写入口或 runtime（运行时）中断能力。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 3 节《Minecraft 事实来源约束》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3.1 节《队列划分》；第 3.2 节《全链路数据流》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2.3 节《转换规则详表》中终态与 brain（摘要队列）副作用；第 5 节《BotWorker 执行循环》；第 10 节《错误分类》
5. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 8 节《任务历史索引系统》；第 9 节《记忆检索集成》
6. `ts-core/Docs/05_DATA_SPEC.md` — 第 2.3 节《task_history / task_summaries / session_summaries》；第 3 节《记忆检索查询》；第 4 节《JSONL 日志规格》；第 7 节《BrainWorker 数据写入流》；第 8 节《Redis 数据约定》
7. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
8. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-26 — 真实 LLM API 验收成为长期规则`；`2026-04-24 — Sandbox 上下文成本治理` 中“经验蒸馏”小节
9. `ts-core/Docs/WF_开发进度记录.md` — `T-031`（任务三十一） 与 `T-032`（任务三十二） 记录
10. `ts-core/Docs/WF_任务阶段压缩记录.md` — `批次 T-021 ~ T-030`
11. `ts-core/scripts/pre_review.sh` — 全文件（只读）
12. `ts-core/package.json` — 全文件（只读；原则上不修改依赖）
13. `ts-core/tsconfig.json` — 全文件（只读）
14. `ts-core/src/core-ports/foundation.ts` — 全文件（只读优先；仅允许摘要 / memory（记忆） 共享基础类型确有必要时适配）
15. `ts-core/src/core-ports/tasking.ts` — 全文件
16. `ts-core/src/core-ports/events.ts` — 全文件（只读优先；仅允许 BrainWorker（摘要工作线程） 事件类型确有必要时适配）
17. `ts-core/src/core-ports/index.ts` — 全文件（仅允许导出适配）
18. `ts-core/src/data/contracts/tables.ts` — 全文件
19. `ts-core/src/data/contracts/task-history.ts` — 全文件
20. `ts-core/src/data/contracts/persistence.ts` — 全文件
21. `ts-core/src/data/contracts/utils.ts` — 全文件（只读优先；仅允许复用校验工具导出适配）
22. `ts-core/src/data/contracts/index.ts` — 全文件
23. `ts-core/src/data/contracts.ts` — 全文件（仅允许 barrel（聚合导出）适配）
24. `ts-core/src/data/schema.ts` — 全文件（只读优先；仅允许与 task_summaries（任务摘要表） 契约对齐的类型适配，不做 migration（迁移） 重写）
25. `ts-core/src/data/logs.ts` — 全文件
26. `ts-core/src/data/index.ts` — 全文件（仅允许导出适配）
27. `ts-core/src/diagnostics/contracts.ts` — 全文件（只读优先；仅允许读取 / 复用 tasks JSONL（任务结构化日志） 行类型）
28. `ts-core/src/diagnostics/logs.ts` — 全文件（只读优先；仅允许复用生命周期摘要行工厂）
29. `ts-core/src/db/index.ts` — 全文件（只读优先；仅允许类型导入需要）
30. `ts-core/src/db/connection.ts` — 全文件（只读优先；不新增真实 SQL（结构化查询语言） 适配）
31. `ts-core/src/workers/contracts.ts` — 全文件
32. `ts-core/src/workers/queues.ts` — 全文件
33. `ts-core/src/workers/bullmq.ts` — 全文件（只读优先；仅允许 BrainWorker（摘要工作线程） runtime（运行时） 复用物理队列名）
34. `ts-core/src/workers/bot-worker.ts` — 全文件（只读优先；仅允许因 BrainWorker（摘要工作线程） action sink（动作汇点） 类型适配的最小修改）
35. `ts-core/src/workers/brain-worker.ts` — 新增文件，允许实现 BrainWorker（摘要工作线程） 真实运行时
36. `ts-core/src/workers/index.ts` — 全文件（仅允许导出适配）
37. `ts-core/src/__tests__/data-model.spec.ts` — 全文件
38. `ts-core/src/__tests__/persistence-replay-model.spec.ts` — 全文件
39. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
40. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件
41. `ts-core/src/__tests__/workers-bullmq-model.spec.ts` — 全文件
42. `ts-core/src/__tests__/brain-worker-runtime-model.spec.ts` — 新增文件，允许覆盖 BrainWorker（摘要工作线程） 运行时
43. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因公共类型、导出或编译失败导致的最小适配）

**核心逻辑要求**:

1. **摘要数据契约与可检索 memory（记忆）端口**:
   - 在 data（数据层） 沉淀 `TaskSummary`（任务摘要） / `TaskSummaryDraft`（任务摘要草案） / `TaskMemorySearchResult`（任务记忆检索结果） 或同等强类型结构，字段至少覆盖 `id`（摘要标识）、`task_id`（任务标识）、`bot_id`（机器人标识）、`intent`（意图摘要）、`status`（终态）、`summary`（摘要正文）、`log_ref`（日志引用）、`created_at`（创建时间），embedding（向量嵌入） 可选。
   - summary（摘要） 必须来自任务历史、终态事件或 JSONL（结构化日志） 输入；不得在代码里写死 Minecraft（我的世界） 事实、配方、掉落、工具等级或世界规则。
   - 增加最小 `createMemoryContextFromTaskSummaries()`（由任务摘要生成记忆上下文） 或同等工厂，按 `created_at`（创建时间） / score（分数） 稳定排序，支持 limit（数量上限） 与字符预算截断，输出可注入 Prompt（提示词） 的短文本。
   - memory（记忆）读取端口只定义接口 / 纯工厂；本轮不实现真实 pgvector（PostgreSQL 向量扩展） 查询。

2. **BrainWorker（摘要工作线程）真实运行时**:
   - 新增 `createBrainWorkerRuntime()`（创建摘要工作线程运行时） 或同等入口，消费 `brain`（摘要队列） 队列，默认使用 BullMQ Worker（任务队列工作线程），测试可注入 worker factory（工作线程工厂）。
   - 运行时依赖必须通过 DI（依赖注入） 提供：`loadTaskSummarySource`（读取任务摘要来源）、`generateTaskSummary`（生成任务摘要）、可选 `generateEmbedding`（生成向量嵌入）、`persistTaskSummary`（持久化任务摘要）、可选 `actionSink`（动作汇点） / `now`（时钟）。
   - 如果未提供 embedding（向量嵌入）生成器，仍必须能写入无 embedding（向量嵌入）的 `task_summaries`（任务摘要） 草案；不得因此阻断摘要链路。
   - 只允许 `completed`（已完成） / `failed`（已失败） / `interrupted`（已中断） 三类真实终态进入 BrainWorker（摘要工作线程）；`discarded`（已丢弃） 不得进入摘要持久化。

3. **入队与幂等边界**:
   - 保持现有 BotWorker（机器人工作线程） 终态后 `enqueue_brain`（入摘要队列） 行为不回退，并继续保证 discarded（已丢弃） 不入 BrainWorker（摘要工作线程）。
   - BrainWorker（摘要工作线程） 持久化记录的 `id`（标识） 或去重键必须稳定可推导，至少能避免同一 `bot_id + message_id`（机器人标识 + 消息标识） 在重试时生成不可控的多条不同逻辑摘要。
   - 运行时失败必须记录 `brain.summary.failed`（摘要失败） 或同等内部事件，不得吞错伪装成功；但不得递归把失败再次推入 `brain`（摘要队列） 造成死循环。

4. **架构边界**:
   - BrainWorker（摘要工作线程） 不得 import（导入） runtime transport（运行时传输）、Mineflayer（Minecraft 协议客户端） adapter（适配器）、BotActor（机器人执行代理）实现或 conversation LLM（对话大语言模型）客户端。
   - 本轮不修改 OpenAI（开放人工智能）兼容配置，不新增依赖，不修改 BullMQ（任务队列）三队列命名。
   - 若需要 summary（摘要）生成的默认实现，只能做基于输入的确定性 fallback（兜底）摘要；不得伪造“LLM 已总结”。

5. **测试覆盖要求**:
   - 覆盖 data（数据层）摘要工厂：冻结语义、终态校验、空摘要拒绝、memory（记忆）上下文 limit（数量上限） / 字符预算截断。
   - 覆盖 BrainWorker（摘要工作线程） runtime（运行时）：消费一条 brain（摘要队列）任务、读取 source（来源）、生成摘要、可选 embedding（向量嵌入）、持久化、事件记录。
   - 覆盖失败路径：source（来源）读取失败或 summary（摘要）生成失败时记录失败事件且不调用 persist（持久化）。
   - 覆盖现有 BotWorker（机器人工作线程） 终态入 BrainWorker（摘要工作线程） 与 discarded（已丢弃） 不入 BrainWorker（摘要工作线程） 的回归。

**验收标准**:

1. data（数据层） 新增 / 扩展的 `task_summaries`（任务摘要） 与 memory（记忆）读取契约强类型、不可变、字段与 `05_DATA_SPEC.md`（数据规格） 对齐，并禁止 discarded（已丢弃） 摘要。
2. `createBrainWorkerRuntime()`（创建摘要工作线程运行时） 能通过注入式队列 worker（工作线程）处理一条真实 `BrainWorkerTask`（摘要工作线程任务），依序读取 source（来源）、生成 summary（摘要）、可选生成 embedding（向量嵌入）、调用 persist（持久化）。
3. BrainWorker（摘要工作线程） 失败路径不会伪装成功，不会递归入队；成功 / 失败事件可由测试读取。
4. BotWorker（机器人工作线程） 已有终态 `enqueue_brain`（入摘要队列） 行为不回退，discarded（已丢弃） 仍不入 brain（摘要队列）。
5. 新增 / 更新测试覆盖上述成功、失败、memory（记忆）上下文和回归点；`bash ts-core/scripts/pre_review.sh` 全部通过。若本轮实际新增任何 LLM（大语言模型） API（应用程序接口）调用，则反馈区还必须包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-033`
- [ ] 仅读取并修改白名单内文件
- [ ] BrainWorker（摘要工作线程） 只读历史 / 日志并写摘要，不触碰 BotActor（机器人执行代理） 写入口或 Mineflayer（Minecraft 协议客户端） 句柄
- [ ] `completed`（已完成） / `failed`（已失败） / `interrupted`（已中断） 可生成摘要，`discarded`（已丢弃） 不会生成摘要
- [ ] memory（记忆）上下文工厂支持排序、limit（数量上限） 与字符预算截断
- [ ] BotWorker（机器人工作线程） 终态入 brain（摘要队列） 的既有行为不回退
- [ ] 未新增第三方依赖，未修改 OpenAI（开放人工智能）兼容配置和队列命名
- [ ] 若新增真实 LLM（大语言模型） 调用，反馈区包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口） 调用结果；若未新增，反馈区明确说明本轮未触碰 LLM（大语言模型） 调用链路
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 回填）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-034**: 在 `interfaces`（接口层） + `realtime`（实时推送） + `app`（应用装配） 内推进网页轻面板的最小状态 / 消息 / 事件同步接口，为后续网站控制女仆做前置。
- **T-035**: 在 `conversation`（对话） + `sandbox`（沙箱） + `diagnostics`（诊断） 内补最小经验沉淀钩子，只记录 sandbox_code（沙箱代码） 成败轨迹，不做向量检索闭环。
- **T-036**: 在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） 内把 T-033（任务三十三） 的 memory（记忆）读取端口注入 chat（闲聊） / plan（规划） LLM（大语言模型）路径，并按真实 LLM（大语言模型）规则验收。

---

### Phase 1（第一阶段） 必做项遗漏补登（2026-04-26 由用户审计后追加，Manager（管理代理） 排期前必读，禁止再次误删）

下列三项是 `01_ARCHITECTURE.md`（架构文档） 第 18 节 Phase 1（第一阶段） 必做表与第 12 / 4.2 / 2 节明确承诺、但截至当前批次（`T-033` ~ `T-036`） 仍未在队列预览中出现的盲区。Manager（管理代理） 在排定 `T-037`（任务三十七） 及之后任务前，必须先把它们纳入候选，不得再被新增对话能力优先级覆盖；本节由用户审计追加，Manager（管理代理） 不得在轮换批次时静默删除，如需重排请保留本节并显式更新候选编号。

- **T-缺-A（候选 T-037）：`minecraft-data`（MC 事实包） 集成**
  - 缺口现状：`world-model/`（世界模型） 模块壳完整，但 `package.json`（依赖清单） 与 `src/` 全仓均未引入 `minecraft-data`（MC 事实 npm 包）。文档第 12.1 节承诺的“MC 常识 = 本地确定性 API 查询”事实上未通路；目前所有 MC 事实仍依赖 LLM（大语言模型） 回忆，存在幻觉风险。
  - 触碰范围（候选）：`world-model`（世界模型） + `data`（数据层） + 必要时 `skills`（技能） 校验侧。
  - 不做范围：不接向量检索；不替换现有 `goTo`（前往坐标） / `mine`（挖掘） / `cutTree`（砍树） / `collect`（捡拾） / `equip`（装备） 参数模型语义；不引入 LLM（大语言模型） 调用。
  - 验收提示：必须给出至少一次“按物品名称 / 方块名称查询配方或属性”的真实查询样例，且查询路径不依赖 LLM（大语言模型）。

- **T-缺-B（候选 T-038）：脊髓反射动作硬编码到 BotActor（机器人执行代理）**
  - 缺口现状：`observation/`（观测） 已能产出 `threat_level`（威胁等级） 并向 BotActor（机器人执行代理） 发中断信号，`runtime/state-machine.ts`（状态机） 已有 `REFLEXING`（反射中） 状态，但 `01_ARCHITECTURE.md`（架构文档） 第 4.2 节列出的 6 条反射动作（≥4 敌冲刺逃跑 / 1-3 敌持武器面向攻击 / 1-3 敌无武器逃跑 / 着火寻水 / 低血脱战进食 / 坠落不操作）仍未在 BotActor（机器人执行代理） 内硬编码执行。当前反射只是“会切状态、不会动作”。
  - 触碰范围（候选）：`runtime`（运行时） + `observation`（观测） + 必要时 `skills`（技能） 内的最小反射用动作适配。
  - 不做范围：不引入 LLM（大语言模型） 决策；不扩反射规则之外的新触发条件；不打破单写者，反射动作仍须从 BotActor（机器人执行代理） 出口走，observation（观测） 不得直接驱动 Mineflayer（Minecraft 协议客户端）。
  - 验收提示：必须有“敌对生物近距离 → BotActor（机器人执行代理） 执行可观测的反射动作 → 回到 IDLE（空闲）”的真实或半真实链路证据，不能只验状态切换；MC（Minecraft，我的世界） 上线手测需要预约用户配合。

- **T-缺-C（候选 T-039）：JAR（自定义服务端插件） 桥接通信落地**
  - 缺口现状：`interfaces/server-bridge/`（服务端桥接接口） 目前只有 `contracts.ts`（契约） + `index.ts`（导出），无 WebSocket（全双工通信协议） / TCP（传输控制协议） 真实通信、无 JAR（自定义服务端插件） 端最小协议握手。文档第 2 节承诺的“双通道信息架构”实际只跑通了 Mineflayer（Minecraft 协议客户端） 单通道，服务端视角数据（全图实体、超视距方块、服务端事件钩子） 完全缺位。
  - 触碰范围（候选）：`interfaces/server-bridge`（服务端桥接） + `app`（应用装配） 启停顺序 + 必要时 `observation`（观测） 融合通道。
  - 不做范围：Phase 1（第一阶段） 不要求做完整事件钩子矩阵；只要求一条最小可观测的“JAR（自定义服务端插件） → TS Core（TypeScript 单核心） → observation 缓存”通路；必须保留 observation（观测） 纯读边界。
  - 排期前置依赖：Manager（管理代理） 必须在派发前与用户确认 JAR（自定义服务端插件） 端是否已具备发包能力；若 JAR（自定义服务端插件） 端尚未实现，需先决定是“TS Core（TypeScript 单核心） 端先做通信骨架 + mock（模拟） JAR（自定义服务端插件） 端测试”还是“等 JAR（自定义服务端插件） 端就绪再排”。

排期建议（仅供 Manager（管理代理） 参考，最终顺序由 Manager（管理代理） 决定）：
- T-缺-A（`minecraft-data` 集成）复杂度最低、阻塞面最广（后续 BrainWorker（摘要工作线程） 摘要、技能参数智能化、planner（规划器） 校验都可能依赖 MC 事实查询），建议优先。
- T-缺-B（反射动作硬编码）依赖现有反射状态机基础，中等复杂度；但 MC（Minecraft，我的世界） 上线手测成本较高，需要预约用户配合。
- T-缺-C（JAR（自定义服务端插件） 桥接）排期前置依赖最重，建议在与用户确认 JAR（自定义服务端插件） 端实现状态之后再排。
