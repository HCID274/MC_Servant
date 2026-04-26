# 当前任务握手区

【任务序号】: T-034
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `interfaces`（接口层） + `realtime`（实时事件模型） + `app`（应用装配） 边界内补齐网页轻面板所需的最小状态 / 消息 / 事件同步闭环：复用现有 `/api/status`（状态接口）、`/api/message`（消息接口）、`/api/replay`（补拉接口） 和 `RealtimeEventEnvelope`（实时事件信封），让网页端能提交一条消息、看到 accepted（已接受）回执、通过 replay（补拉）读取后续 chat.reply（聊天回复）与 task.*（任务生命周期）事件，并从 status（状态）读取当前 Bot（机器人） / worker（工作线程） / LLM（大语言模型）摘要。本轮只做后端接口与可测试同步模型，不做前端页面，不新增 WebSocket（全双工网页通信协议）或 Socket.io（实时通信库）物理服务。

**上下文说明**:
1. T-031（任务三十一） 已让 chat_reply（闲聊回复） 读取 BotActor（机器人执行代理） 只读状态投影。
2. T-032（任务三十二） 已让 composite triage（复合分诊） 支持 `cancel → reply → action`（取消 → 回复 → 动作）有序派发。
3. T-033（任务三十三） 已补齐 BrainWorker（摘要工作线程）最小摘要运行时和 memory（记忆）读取端口，但尚未要求把 BrainWorker（摘要工作线程）接入在线 app（应用）启动链。
4. 当前 `interfaces`（接口层） 已有四条 HTTP（超文本传输协议）路由和 `RealtimeEventEnvelope`（实时事件信封）；`startAppOnlineRuntime()`（启动真实在线运行时） 只有 message accepted（消息已接受）事件会进入进程内 replay store（补拉事件存储），conversation（对话）广播回复和 BotWorker（机器人工作线程）生命周期还没有稳定进入 replay（补拉）视图。
5. 本轮不触碰 LLM（大语言模型） Prompt（提示词）、解析器、模型配置或 OpenAI（开放人工智能）兼容客户端；若 Coder（编码代理）意外修改这些链路，则必须回填真实 LLM（大语言模型） API（应用程序接口）验收。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 5 节《ts-core 工具链与工程基线》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3.1 节《队列划分》；第 3.2 节《全链路数据流》；第 15 节《模块划分》；第 16.1 节《命名约定》
4. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 5 节《BotWorker 执行循环》；第 10 节《错误分类》
5. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 2 节《消息入口》；第 8 节《任务历史索引系统》（只读理解）
6. `ts-core/Docs/05_DATA_SPEC.md` — 第 4 节《JSONL 日志规格》；第 7 节《BrainWorker 数据写入流》（只读理解，不改数据层）
7. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
8. `ts-core/Docs/WF_需求变更索引.md` — `2026-04-26 — 真实 LLM API 验收成为长期规则`
9. `ts-core/Docs/WF_开发进度记录.md` — `T-031`（任务三十一） 到 `T-033`（任务三十三）记录
10. `ts-core/Docs/WF_任务阶段压缩记录.md` — `批次 T-021 ~ T-030`
11. `ts-core/scripts/pre_review.sh` — 全文件（只读）
12. `ts-core/package.json` — 全文件（只读；不得新增依赖）
13. `ts-core/tsconfig.json` — 全文件（只读）
14. `ts-core/src/core-ports/events.ts` — 全文件（只读优先；仅允许事件载荷类型确有必要时适配）
15. `ts-core/src/core-ports/foundation.ts` — 全文件（只读）
16. `ts-core/src/core-ports/tasking.ts` — 全文件（只读）
17. `ts-core/src/interfaces/contracts.ts` — 全文件
18. `ts-core/src/interfaces/api.ts` — 全文件
19. `ts-core/src/interfaces/realtime.ts` — 全文件
20. `ts-core/src/interfaces/server.ts` — 全文件
21. `ts-core/src/interfaces/errors.ts` — 全文件（只读优先）
22. `ts-core/src/interfaces/index.ts` — 全文件（仅允许导出适配）
23. `ts-core/src/app/bootstrap/types.ts` — 全文件
24. `ts-core/src/app/bootstrap/directories.ts` — 全文件
25. `ts-core/src/app/bootstrap/services.ts` — 全文件
26. `ts-core/src/app/bootstrap/index.ts` — 全文件（仅允许导出适配）
27. `ts-core/src/app/entrypoint.ts` — 全文件
28. `ts-core/src/app/index.ts` — 全文件（仅允许导出适配）
29. `ts-core/src/workers/contracts.ts` — 全文件（只读优先；仅允许 action（动作）类型适配）
30. `ts-core/src/workers/conversation-worker/types.ts` — 全文件（只读）
31. `ts-core/src/workers/bot-worker.ts` — 全文件（只读）
32. `ts-core/src/workers/brain-worker.ts` — 全文件（只读）
33. `ts-core/src/workers/index.ts` — 全文件（只读优先）
34. `ts-core/src/runtime/events.ts` — 全文件（只读优先；优先复用已有生命周期事件工厂）
35. `ts-core/src/__tests__/interfaces-model.spec.ts` — 全文件
36. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
37. `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts` — 全文件
38. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
39. `ts-core/src/__tests__/app-smoke-model.spec.ts` — 全文件
40. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件（只读优先；仅允许回归断言适配）
41. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因公共类型、导出或编译失败导致的最小适配）

**核心逻辑要求**:

1. **接口协议边界**:
   - 复用现有 `/api/status`（状态接口）、`/api/message`（消息接口）、`/api/replay`（补拉接口），不得新增公开路由、不得更名、不得改变现有成功状态码语义。
   - 不新增 Socket.io（实时通信库）、WebSocket（全双工网页通信协议） 或前端依赖；本轮的实时同步以 replay（补拉） + `RealtimeEventEnvelope`（实时事件信封）为准。
   - `API_ROUTE_DEFINITIONS`（接口路由定义）与 Fastify（接口网关）注册结果必须保持一致。

2. **轻面板状态模型**:
   - `/api/status`（状态接口）必须稳定返回 Bot（机器人）状态、`intent_epoch`（意图纪元）、`last_event_seq`（最后事件序号）、Mineflayer（Minecraft 协议客户端）只读连接摘要、worker（工作线程）装配摘要和最近一次 LLM（大语言模型）诊断摘要。
   - 状态投影只能读取已有只读快照或注入式 provider（提供器），不得暴露 Mineflayer（Minecraft 协议客户端） Bot（机器人）句柄、Redis（缓存）连接、PostgreSQL（关系型数据库）连接或密钥。
   - 若需要扩展 worker（工作线程）摘要字段，应保持向后兼容，现有 `conversation`（对话工作线程） / `bot`（机器人工作线程）字段不能改名。

3. **消息与事件同步闭环**:
   - `/api/message`（消息接口）提交成功后继续返回 `202`（已接受） 与 `MessageAcceptedResponse`（消息已接受响应），并把 accepted（已接受）事件写入 replay store（补拉事件存储）。
   - `ConversationWorker`（对话工作线程）广播回复时，在线入口必须把可脱敏的 `chat.reply`（聊天回复）事件追加到 replay store（补拉事件存储），网页端通过 `/api/replay`（补拉接口）可看到回复内容或回复摘要。
   - `BotWorker`（机器人工作线程）发出的 started（已开始） / discarded（已丢弃） / completed（已完成） / failed（已失败） / interrupted（已中断）生命周期动作必须能转换为 replay（补拉）事件；不得把 `enqueue_brain`（入摘要队列）伪装成 runtime（运行时）事件。
   - 如果用户注入了自定义 actionSink（动作汇点） 或 broadcastReplySink（广播回复汇点），在线入口必须组合调用，不能静默覆盖用户注入逻辑。

4. **事件顺序与隔离**:
   - replay store（补拉事件存储） 继续保持单进程 append-only（只追加）模型，事件 `seq`（序号）单调递增，`/api/replay`（补拉接口）按 `after_seq`（起始序号）与 `limit`（数量上限）稳定返回。
   - 返回给接口层的事件必须深克隆 / 冻结，防止测试或调用方修改内部事件缓存。
   - 事件载荷不得包含 API key（接口密钥）、密码、连接串、完整 LLM（大语言模型） Prompt（提示词）或 Mineflayer（Minecraft 协议客户端）可写对象。

5. **架构边界**:
   - `interfaces`（接口层）只能处理协议对象、状态投影和事件信封；不得直接 import（导入） BotActor（机器人执行代理）实现、Mineflayer（Minecraft 协议客户端）适配器或数据库实现。
   - `app`（应用装配）可以组合现有 worker（工作线程）汇点和 replay store（补拉事件存储），但不得改变资源启动顺序和关闭顺序。
   - 本轮不接真实持久化 event_log（事件日志） repository（存储适配），不接 BrainWorker（摘要工作线程）真实在线启动，不改 LLM（大语言模型） Prompt（提示词）。

**验收标准**:

1. `GET /api/status`（状态接口）、`POST /api/message`（消息接口）、`GET /api/replay`（补拉接口）在 Fastify（接口网关）测试中形成“提交消息 → accepted（已接受）事件 → reply（回复）事件 / task（任务）事件补拉 → 状态 last_event_seq（最后事件序号）更新”的最小闭环。
2. 在线入口的 conversation（对话）广播回复与 BotWorker（机器人工作线程）生命周期动作会写入 replay store（补拉事件存储），且不会覆盖用户注入的汇点。
3. replay（补拉）事件按 `seq`（序号）递增、按 `bot_id`（机器人标识）隔离、按 `limit`（数量上限）截断，并保持不可变输出。
4. 不新增依赖，不新增公开路由，不触碰 LLM（大语言模型） Prompt（提示词） / 解析 / 配置；若实际触碰，反馈区必须包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果。
5. 新增 / 更新测试覆盖状态接口、消息接口、补拉接口、在线入口汇点组合、事件脱敏 / 不可变和回归点；`bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-034`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增公开路由、未新增依赖、未新增 WebSocket（全双工网页通信协议） / Socket.io（实时通信库） 物理服务
- [ ] `/api/status`（状态接口） / `/api/message`（消息接口） / `/api/replay`（补拉接口） 语义保持兼容
- [ ] conversation（对话）广播回复与 BotWorker（机器人工作线程）生命周期动作均能进入 replay（补拉）事件流
- [ ] 自定义 actionSink（动作汇点） / broadcastReplySink（广播回复汇点） 未被静默覆盖
- [ ] replay（补拉）事件按 `bot_id`（机器人标识）隔离、按 `seq`（序号）排序、输出不可变
- [ ] 未触碰 LLM（大语言模型） Prompt（提示词） / 解析 / 配置；若触碰，反馈区包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-035**: 在 `conversation`（对话） + `sandbox`（沙箱） + `diagnostics`（诊断） 内补最小经验沉淀钩子，只记录 sandbox_code（沙箱代码） 成败轨迹，不做向量检索闭环。
- **T-036**: 在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） 内把 T-033（任务三十三） 的 memory（记忆）读取端口注入 chat（闲聊） / plan（规划） LLM（大语言模型）路径，并按真实 LLM（大语言模型）规则验收。

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
