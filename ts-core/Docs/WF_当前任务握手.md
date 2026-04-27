# 当前任务握手区

【任务序号】: T-036
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） 边界内，把 T-033（任务三十三） 已建立的 memory（记忆）读取端口接入 chat（闲聊） / plan（规划） LLM（大语言模型）输入路径：当对话路由声明需要 memory search（记忆检索） 或进入 plan（规划） 路径时，ConversationWorker（对话工作线程） 通过可注入 provider（提供器）读取任务摘要上下文，并将稳定、限长的 `memory_context`（记忆上下文） 注入 `generateChatReply()`（生成闲聊回复） 与 `generateSkillPlan()`（生成技能规划）。本轮只做注入链路、降级策略和在线入口装配，不做数据库查询实现、不做向量检索算法、不引入新依赖。

**上下文说明**:
1. T-033（任务三十三） 已在 `data/contracts/task-history.ts`（任务历史契约） 中提供 `TaskMemorySearchResult`（任务记忆检索结果） 与 `createMemoryContextFromTaskSummaries()`（由任务摘要创建记忆上下文）。
2. 当前 LLM（大语言模型） 类型和消息构造已存在 `memory_context`（记忆上下文） 字段，但真实 ConversationWorker（对话工作线程） 与 online entrypoint（在线入口装配） 尚未把 memory（记忆）读取端口接进来。
3. T-031（任务三十一） 已把 `state_context`（状态上下文） 注入 chat（闲聊）路径；本轮需要让 memory（记忆） 与 state（状态） 并存，且 provider（提供器）失败时降级为无记忆调用。
4. T-032（任务三十二） 已让 route（路由） 暴露 `needs_memory_search`（需要记忆检索） 与 `requires_planning`（需要规划） 信号；本轮应复用这些信号，不重新定义意图分类。
5. 本轮会触碰 LLM（大语言模型） 输入消息与 online entrypoint（在线入口装配），必须按长期规则提供真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收结果。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 0.2 节《真实 LLM API 验收规则》；第 2 节《用户强约束》；第 5 节《ts-core 工具链与工程基线》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 对话路由、Prompt（提示词） 与 LLM（大语言模型） 输入相关小节
5. `ts-core/Docs/05_DATA_SPEC.md` — task_summaries（任务摘要） / BrainWorker（摘要工作线程） 数据写入与读取意图相关小节
6. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
7. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-24 — Triage 架构演进备案`、`2026-04-24 — Sandbox 上下文成本治理`、`2026-04-26 — 真实 LLM API 验收成为长期规则`
8. `ts-core/Docs/WF_开发进度记录.md` — `T-031`（任务三十一）、`T-032`（任务三十二）、`T-033`（任务三十三）、`T-035`（任务三十五）记录
9. `ts-core/scripts/pre_review.sh` — 全文件（只读）
10. `ts-core/package.json` — 全文件（只读；不得新增依赖）
11. `ts-core/tsconfig.json` — 全文件（只读）
12. `ts-core/src/data/contracts/task-history.ts` — 全文件（优先复用既有 memory（记忆）工厂；只允许最小类型补充）
13. `ts-core/src/data/index.ts`、`ts-core/src/data/contracts.ts`、`ts-core/src/data/contracts/index.ts` — 仅允许导出适配
14. `ts-core/src/conversation/contracts.ts` — 全文件
15. `ts-core/src/conversation/triage.ts` — 全文件（只读优先；仅允许因 route（路由） memory（记忆）信号缺口做最小修正）
16. `ts-core/src/conversation/chat.ts` — 全文件
17. `ts-core/src/conversation/planning.ts` — 全文件
18. `ts-core/src/conversation/llm/types.ts` — 全文件
19. `ts-core/src/conversation/llm/messages.ts` — 全文件
20. `ts-core/src/conversation/llm/client.ts` — 全文件
21. `ts-core/src/conversation/llm/prompts/chat.ts` — 全文件
22. `ts-core/src/conversation/llm/prompts/plan.ts` — 全文件
23. `ts-core/src/conversation/llm/index.ts`、`ts-core/src/conversation/llm.ts`、`ts-core/src/conversation/index.ts` — 仅允许导出适配
24. `ts-core/src/workers/conversation-worker/types.ts` — 全文件
25. `ts-core/src/workers/conversation-worker/runtime.ts` — 全文件
26. `ts-core/src/workers/conversation-worker/helpers.ts` — 全文件
27. `ts-core/src/workers/conversation-worker/handlers/chat-reply.ts` — 全文件
28. `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts` — 全文件
29. `ts-core/src/workers/conversation-worker/index.ts`、`ts-core/src/workers/conversation-worker.ts`、`ts-core/src/workers/index.ts` — 仅允许导出适配
30. `ts-core/src/app/entrypoint.ts` — 全文件（仅允许接线 memory（记忆） provider（提供器） 与真实 LLM（大语言模型）装配，不做大拆分）
31. `ts-core/src/app/bootstrap/types.ts`、`ts-core/src/app/bootstrap/services.ts`、`ts-core/src/app/index.ts` — 仅允许因 online entrypoint（在线入口装配） 类型需要做最小适配
32. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
33. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
34. `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts` — 全文件
35. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
37. `ts-core/src/__tests__/data-model.spec.ts` — 全文件（只读优先；仅允许 memory（记忆）上下文工厂测试补充）
38. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因公共类型、导出或编译失败导致的最小适配）

**核心逻辑要求**:

1. **memory provider（记忆提供器）边界**:
   - 新增或扩展的 provider（提供器）必须是可注入端口；ConversationWorker（对话工作线程） 不得直接访问 PostgreSQL（关系型数据库）、Redis（缓存）、JSONL（结构化日志）文件或向量库。
   - provider（提供器） 输入至少包含 `bot_id`（机器人标识）、`message_id`（消息标识）、`intent_epoch`（意图纪元）、原始消息文本、route kind（路由类型） 与查询原因；输出应为已限长的 `memory_context`（记忆上下文） 字符串或空值。
   - 复用 `createMemoryContextFromTaskSummaries()`（由任务摘要创建记忆上下文） 的排序、limit（数量上限） 与 char_budget（字符预算）语义；不要另写一套不一致的排序规则。

2. **chat（闲聊） / plan（规划） 注入规则**:
   - `chat_reply`（闲聊回复） 仅在 route（路由） 的 `needs_memory_search === true`（需要记忆检索） 时读取 memory（记忆）；无 provider（提供器）、provider（提供器）返回空、provider（提供器）失败时降级为当前无记忆闲聊，不影响回复。
   - `plan_exec`（规划执行） 与 `modify_interrupt_then_plan`（修改后规划） 必须尝试读取 memory（记忆），并把结果注入 `generateSkillPlan()`（生成技能规划）的 `memory_context`（记忆上下文）。
   - memory（记忆） 与 `state_context`（状态上下文） 必须能同时存在；chat（闲聊） Prompt（提示词） 中两者应保持区分，不合并成一段含混文本。
   - plan（规划） Prompt（提示词） 不得重新允许 `sandbox_code`（沙箱代码） 在线规划；仍只允许当前在线技能集合。

3. **降级与安全**:
   - provider（提供器）异常不得导致 chat（闲聊）路径失败；plan（规划）路径 provider（提供器）异常也应降级为无记忆规划，除非原 planner（规划器）自身失败。
   - memory_context（记忆上下文） 注入前必须非空检查，并受字符预算限制；不得把未限长的历史日志、原始 code（代码）、完整 Prompt（提示词） 或敏感配置塞进 LLM（大语言模型）输入。
   - 不新增依赖、不新增数据库迁移、不新增公开 HTTP（超文本传输协议） 路由，不新增 WebSocket（全双工网页通信协议） 或 Socket.io（实时通信库） 服务。

4. **在线入口接线**:
   - `startAppOnlineRuntime()`（启动真实在线运行时） 可接受外部注入的 memory provider（记忆提供器），并把它传给 ConversationWorker（对话工作线程）。
   - 没有 memory provider（记忆提供器） 时，在线入口行为必须与 T-035（任务三十五） 前保持一致。
   - 不借本轮重构 `entrypoint.ts`（入口文件） 大文件；代码债 D-1 已记账，后续独立治理。

**验收标准**:

1. 单元测试证明 chat（闲聊） 在 `needs_memory_search=true`（需要记忆检索） 时读取 memory（记忆）并注入 `memory_context`（记忆上下文），`needs_memory_search=false`（不需要记忆检索） 时不读取。
2. 单元测试证明 plan（规划） 路径读取 memory（记忆）并传给 `generateSkillPlan()`（生成技能规划），同时 planner（规划器）失败 / provider（提供器）失败的降级行为清晰。
3. LLM（大语言模型） message（消息）构造测试覆盖 memory（记忆） + state（状态） 并存、字符预算生效、Prompt（提示词） 未重新开放 sandbox_code（沙箱代码） 规划。
4. online entrypoint（在线入口装配） 测试覆盖 memory provider（记忆提供器） 注入和未注入两种路径；不破坏 replay（补拉） / task lifecycle（任务生命周期） / broadcast reply（广播回复） 既有行为。
5. 因本任务触碰 LLM（大语言模型） 输入链路和 online entrypoint（在线入口装配），反馈区必须包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用命令、输入摘要、关键输出和通过判断；若 Coder（编码代理）环境不可达，必须提供最短人工手测步骤。
6. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-036`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增依赖、未新增公开路由、未新增数据库迁移
- [ ] memory provider（记忆提供器） 为可注入端口，ConversationWorker（对话工作线程） 不直接访问数据库 / 缓存 / 文件 / 向量库
- [ ] chat（闲聊） 与 plan（规划） 路径均覆盖 memory_context（记忆上下文） 注入与 provider（提供器）失败降级测试
- [ ] LLM（大语言模型） Prompt（提示词） / message（消息）测试确认 memory（记忆） 与 state（状态） 并存，且 plan（规划） 未重新开放 sandbox_code（沙箱代码）
- [ ] online entrypoint（在线入口装配） 测试覆盖 memory provider（记忆提供器） 注入与缺省行为
- [ ] 真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收结果已回填；若不可达，已回填最短人工手测步骤
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-037**: 优先排入 `minecraft-data`（MC 事实包） 集成，补齐 MC（Minecraft，我的世界） 常识本地确定性查询，降低 LLM（大语言模型） 幻觉风险。
- **T-038**: BotActor（机器人执行代理） 脊髓反射动作硬编码，基于 observation（观测） 威胁等级进入 `REFLEXING`（反射中） 并执行最低风险避险动作。
- **T-039**: JAR（自定义服务端插件） 桥接通信落地；派发前必须先与用户确认 JAR（自定义服务端插件）端是否已具备发包能力。

---

### Phase 1（第一阶段） 必做项遗漏补登（2026-04-26 由用户审计后追加，Manager（管理代理） 排期前必读，禁止再次误删）

下列三项是 `01_ARCHITECTURE.md`（架构文档） 第 18 节 Phase 1（第一阶段） 必做表与第 12 / 4.2 / 2 节明确承诺、但截至当前批次仍需排期的盲区。Manager（管理代理） 在排定 `T-037`（任务三十七） 及之后任务前，必须先把它们纳入候选，不得再被新增对话能力优先级覆盖；本节由用户审计追加，Manager（管理代理） 不得在轮换批次时静默删除，如需重排请保留本节并显式更新候选编号。

- **T-缺-A（候选 T-037）：`minecraft-data`（MC 事实包） 集成**
  - 缺口现状：`world-model/`（世界模型） 模块壳完整，但 `package.json`（依赖清单） 与 `src/` 全仓均未引入 `minecraft-data`（MC 事实 npm 包）。文档第 12.1 节承诺的“MC 常识 = 本地确定性 API（应用程序接口）查询”事实上未通路；目前所有 MC（Minecraft，我的世界）事实仍依赖 LLM（大语言模型）回忆，存在幻觉风险。
  - 排期建议：复杂度最低、阻塞面最广，建议优先。

- **T-缺-B（候选 T-038）：脊髓反射动作硬编码到 BotActor（机器人执行代理）**
  - 缺口现状：`observation/`（观测） 已能产出 `threat_level`（威胁等级） 并向 BotActor（机器人执行代理） 发中断信号，`runtime/state-machine.ts`（状态机） 已有 `REFLEXING`（反射中） 状态，但文档承诺的反射动作仍未在 BotActor（机器人执行代理） 内硬编码执行。
  - 排期提示：需要真实或半真实链路证据，MC（Minecraft，我的世界）上线手测需要预约用户配合。

- **T-缺-C（候选 T-039）：JAR（自定义服务端插件） 桥接通信落地**
  - 缺口现状：`interfaces/server-bridge/`（服务端桥接接口） 目前只有 `contracts.ts`（契约） + `index.ts`（导出），无 WebSocket（全双工通信协议） / TCP（传输控制协议） 真实通信、无 JAR（自定义服务端插件）端最小协议握手。
  - 排期前置依赖：Manager（管理代理） 必须在派发前与用户确认 JAR（自定义服务端插件）端是否已具备发包能力；若尚未实现，需先决定是“TS Core（TypeScript 单核心）端先做通信骨架 + mock（模拟）JAR（自定义服务端插件）端测试”还是“等 JAR（自定义服务端插件）端就绪再排”。

---

### 潜在代码债备忘（2026-04-26 由用户审计追加，未排期但已记账，禁止误删）

下列条目不构成 Phase 1（第一阶段） 必做项缺口，也不影响当前批次推进；仅作为"代码已经在不优雅的状态，未来某次架构治理批次应集中处理"的提示。Manager（管理代理） 不需要立即排期，但在下一次架构治理批次（参考历史 T-028 ~ T-030）启动时，应把本节作为候选清单读入。

- **代码债 D-1：`src/app/entrypoint.ts` 已达 804 行，需要按职责拆分**
  - 现状：T-029（任务二十九） 已完成 `app/bootstrap/` 子目录拆分（11 文件），但 `entrypoint.ts` 本体仍以 804 行单文件承载在线运行时装配、启停顺序、健康检查投影、状态投影注入等多个职责，是当前 `src/` 中最大的单文件之一。
  - 建议拆分方向（仅为参考，最终由治理批次的 Manager（管理代理） 决定）：`online-runtime-assemble.ts`（在线运行时装配） / `online-runtime-lifecycle.ts`（在线运行时启停） / `health-snapshot.ts`（健康投影） / `state-projection-wiring.ts`（状态投影接线）。
  - 触发条件：当 `entrypoint.ts` 再次因为新增能力而显著膨胀（例如 T-034（任务三十四） 实时推送装配 / T-036（任务三十六） memory（记忆） 注入装配 / T-037（任务三十七） `minecraft-data`（MC 事实包） 装配陆续接入），优先级即应升至下一次架构治理批次的候选首位。
  - 不做范围：不在此条记账下做任何"顺手拆一下"的零散修改；拆分必须作为独立任务由 Manager（管理代理） 派发，避免与功能任务混在同一 commit。

- **架构文档 v0.3 同步范围说明（与本备忘联动）**
  - 已同步：`01_ARCHITECTURE.md`（架构文档） 第 2 节七层架构图、第 15 节模块表、第 16 节目录结构 已按当前实际代码追认 `app/`（应用装配） 与 `core-ports/`（核心端口） 两层，并升级为反映子目录拆分的两层视图。
  - 未同步（语义级，留待整批次收口后再做）：BotActor（机器人执行代理） 状态机 6 态图（含 `INITIALIZING` / `DEAD` / `SHUTDOWN`）、`createRuntimeReadyGate`（运行时就绪门控） 显式建模、`broadcastReply`（广播回复） 收口于单写者、`ConversationCompositeTriage`（对话复合分诊） 升级 Triage Prompt（分诊提示词） 设计、`BotActorStateProjection`（机器人执行代理状态投影） 注入闲聊回复 等共 5 处差异。这些属于"代码语义级演进"，建议等 T-033 ~ T-040 批次收口后由 Manager（管理代理） 统一推进 v0.4 文档跃迁，不要在功能任务中夹带文档语义改动。
