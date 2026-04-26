# 当前任务握手区

【任务序号】: T-035
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `sandbox`（沙箱） + `diagnostics`（诊断） + `workers`（工作线程） 边界内补齐 sandbox_code（沙箱代码） 成败经验沉淀的最小钩子：当 BotWorker（机器人工作线程） 执行 sandbox_code（沙箱代码） 任务进入 completed（已完成） / failed（已失败） / interrupted（已中断） 终态时，产出一个可持久化、可测试、已脱敏的 sandbox experience（沙箱经验）动作或记录草案，供后续 T-036/T-037 之后再接入记忆检索或数据库。本轮只做确定性契约、纯转换和 worker（工作线程）动作出口，不做向量检索闭环，不改 LLM（大语言模型） Prompt（提示词），不新增数据库迁移。

**上下文说明**:
1. T-033（任务三十三） 已补齐 BrainWorker（摘要工作线程） 的任务摘要写入运行时和 memory（记忆）读取端口，但该摘要是通用任务级摘要，不专门保留 sandbox_code（沙箱代码） 的代码轨迹与失败形态。
2. T-034（任务三十四） 已让网页轻面板通过 replay（补拉）看到 accepted（已接受）、chat.reply（聊天回复） 与 task.*（任务生命周期）事件。
3. 当前 sandbox（沙箱） 与 diagnostics（诊断） 已有执行结果、phase_logs（阶段日志）、log_ref（日志引用）、code_ref（代码引用）等契约；BotWorker（机器人工作线程） 已能区分 skill_call（技能调用） 与 sandbox_code（沙箱代码） 执行结果。
4. 本轮不是重启 sandbox_code（沙箱代码） LLM（大语言模型） 规划，不改 plan prompt（规划提示词） 的“不要输出 sandbox_code”约束；只是为未来经验蒸馏预留最小、低耦合、可测试的采集出口。
5. 若 Coder（编码代理） 意外触碰 LLM（大语言模型） 调用链路、Prompt（提示词）、解析器、对话路由或 online entrypoint（在线入口装配），反馈区必须按长期规则回填真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 3 节《Minecraft 事实来源约束》；第 5 节《ts-core 工具链与工程基线》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 6 节《沙箱隔离边界》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 1 节《沙箱的核心定位》；第 3 节《代码转译流程》；第 4 节《Facade API 完整类型定义》；错误处理与日志相关小节
5. `ts-core/Docs/05_DATA_SPEC.md` — 第 4 节《JSONL 日志规格》；第 4.3 节《沙箱执行日志格式》；第 7 节《BrainWorker 数据写入流》（只读理解）
6. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
7. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-24 — Sandbox 上下文成本治理` 与 `2026-04-26 — 真实 LLM API 验收成为长期规则`
8. `ts-core/Docs/WF_开发进度记录.md` — `T-033`（任务三十三） 与 `T-034`（任务三十四）记录
9. `ts-core/scripts/pre_review.sh` — 全文件（只读）
10. `ts-core/package.json` — 全文件（只读；不得新增依赖）
11. `ts-core/tsconfig.json` — 全文件（只读）
12. `ts-core/src/core-ports/foundation.ts` — 全文件（只读）
13. `ts-core/src/core-ports/tasking.ts` — 全文件（只读优先；仅允许 sandbox_code（沙箱代码） 经验字段确需对齐时最小适配）
14. `ts-core/src/core-ports/events.ts` — 全文件（只读）
15. `ts-core/src/domain/invariants.ts` — 全文件（只读优先；优先复用既有断言 / 克隆工具）
16. `ts-core/src/sandbox/contracts.ts` — 全文件
17. `ts-core/src/sandbox/execution.ts` — 全文件（只读优先；仅允许为经验摘要补只读 helper（辅助函数））
18. `ts-core/src/sandbox/facade.ts` — 全文件（只读）
19. `ts-core/src/sandbox/index.ts` — 全文件（仅允许导出适配）
20. `ts-core/src/diagnostics/contracts.ts` — 全文件
21. `ts-core/src/diagnostics/logs.ts` — 全文件
22. `ts-core/src/diagnostics/index.ts` — 全文件（仅允许导出适配）
23. `ts-core/src/workers/contracts.ts` — 全文件
24. `ts-core/src/workers/bot-worker.ts` — 全文件
25. `ts-core/src/workers/index.ts` — 全文件（仅允许导出适配）
26. `ts-core/src/data/contracts/task-history.ts` — 全文件（只读优先；仅允许复用 / 对齐 T-033（任务三十三） 摘要契约时最小适配）
27. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件
28. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件
29. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件（只读优先；仅允许因 worker（工作线程）动作联合变化导致的最小适配）
30. `ts-core/src/__tests__/data-model.spec.ts` — 全文件（只读优先）
31. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因公共类型、导出或编译失败导致的最小适配）

**核心逻辑要求**:

1. **经验契约边界**:
   - 新增的 sandbox experience（沙箱经验）必须是纯契约 / 纯工厂 / 可注入动作，不得直接写 PostgreSQL（关系型数据库）、Redis（缓存）、JSONL（结构化日志）文件或向量库。
   - 经验记录至少包含 `bot_id`（机器人标识）、`message_id`（消息标识）、`intent_epoch`（意图纪元）、sandbox_code（沙箱代码） 执行终态、步骤数、耗时、`log_ref`（日志引用） / `code_ref`（代码引用） 中可用字段、错误分类摘要和可检索的短摘要。
   - 原始 code（代码） 不得无界透出；如需要保留，必须使用有上限的 `code_preview`（代码预览） 或 `code_hash`（代码哈希） / `code_ref`（代码引用） 组合，避免未来 replay（补拉） 或日志接口泄露大段代码。

2. **BotWorker（机器人工作线程） 钩子**:
   - 只有 `exec_job.type === "sandbox_code"`（执行任务类型为沙箱代码） 时产出 sandbox experience（沙箱经验）动作；skill_call（技能调用） 不能误产出经验。
   - completed（已完成）、failed（已失败）、interrupted（已中断） 都必须覆盖；discarded（已丢弃） 与 started（已开始） 不写经验。
   - 保留现有 `emit_task_lifecycle`（发射任务生命周期） 与 `enqueue_brain`（入摘要队列） 动作语义，不得删除或改名；若新增动作类型，应保持向后兼容并更新必要测试。

3. **脱敏与不可变**:
   - 经验记录、动作载荷和测试可见输出必须深克隆 / 冻结，调用方不能修改内部缓存或复用对象。
   - 错误摘要不得包含 API key（接口密钥）、密码、连接串、完整 Prompt（提示词） 或宿主机敏感路径；如复用 diagnostics（诊断） 的脱敏工具，应补覆盖密钥样例。
   - 经验短摘要应稳定、确定性，便于后续检索测试；不得依赖当前时间以外的随机值。

4. **架构边界**:
   - sandbox（沙箱） / diagnostics（诊断） 可以定义经验契约与摘要转换；workers（工作线程） 只负责在已有 actionSink（动作汇点） 上发出动作，不直接依赖数据库实现。
   - 不改 conversation（对话） LLM（大语言模型） prompt（提示词） 和 parser（解析器），不重新打开 sandbox_code（沙箱代码） 在线规划入口。
   - 不新增依赖，不新增公开 HTTP（超文本传输协议） 路由，不新增 WebSocket（全双工网页通信协议） 或 Socket.io（实时通信库） 服务。

**验收标准**:

1. sandbox_code（沙箱代码） 成功、失败、中断三类终态都能生成稳定 sandbox experience（沙箱经验）动作 / 草案；skill_call（技能调用） 不生成。
2. BotWorker（机器人工作线程） 测试能证明生命周期动作、BrainWorker（摘要工作线程） 入队动作与 sandbox experience（沙箱经验）动作可以共存，且顺序明确、类型兼容。
3. 经验载荷经过脱敏、长度限制与不可变处理；测试覆盖密钥 / 密码样例不会泄露。
4. 不触碰 LLM（大语言模型） Prompt（提示词） / 解析 / 配置 / online entrypoint（在线入口装配）；若实际触碰，反馈区必须包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-035`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增依赖、未新增公开路由、未新增数据库迁移
- [ ] sandbox_code（沙箱代码） completed（已完成） / failed（已失败） / interrupted（已中断） 经验动作均有测试
- [ ] skill_call（技能调用） 与 discarded（已丢弃） / started（已开始） 不误写经验
- [ ] 经验载荷脱敏、长度限制、深冻结 / 不可变输出均有测试
- [ ] 未触碰 LLM（大语言模型） Prompt（提示词） / 解析 / 配置 / online entrypoint（在线入口装配）；若触碰，反馈区包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-036**: 在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） 内把 T-033（任务三十三） 的 memory（记忆）读取端口注入 chat（闲聊） / plan（规划） LLM（大语言模型）路径，并按真实 LLM（大语言模型）规则验收。
- **T-037**: 优先排入 `minecraft-data`（MC 事实包） 集成，补齐 MC（Minecraft，我的世界） 常识本地确定性查询，降低 LLM（大语言模型） 幻觉风险。
- **T-038 / T-039 候选**: BotActor（机器人执行代理） 脊髓反射动作硬编码；JAR（自定义服务端插件） 桥接通信落地。T-039（任务三十九） 派发前必须先与用户确认 JAR（自定义服务端插件）端发包能力。

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
