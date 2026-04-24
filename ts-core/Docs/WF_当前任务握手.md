# 当前任务握手区

【任务序号】: T-026
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `interfaces`（接口边界） + `diagnostics`（诊断） + `app`（应用装配） 这一组主干模块内，补齐真实 MC（Minecraft，我的世界） 手测所需的只读观测出口：当前状态读取、事件顺序回放、最近一次 `LLM`（大语言模型） 调用摘要查看。本轮目标是让操作者在女仆在线测试时能快速判断“在线状态是什么、刚才发生了哪些事件、最近一次模型调用是否成功”，不是新增控制入口或业务写接口。

**上下文说明**:
1. `T-021`（任务二十一） 已完成真实 MC（Minecraft，我的世界） 在线聊天闭环。
2. `T-022`（任务二十二） 已完成 `goTo`（前往坐标） 最小真实执行链。
3. `T-023`（任务二十三） 已完成 OpenAI（开放人工智能） 兼容闲聊闭环与真实 `cancel`（取消） 中断语义。
4. `T-024`（任务二十四） 已完成真实 `triage`（分诊） + 最小 `goTo`（前往坐标） 规划。
5. `T-025`（任务二十五） 已把真实技能面扩到 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备）。
6. 当前缺口不是“女仆不能做事”，而是“手测时看不清系统状态”：操作者需要一个只读接口判断 Bot（机器人） 是否在线、事件是否按序产生、最近一次 `LLM`（大语言模型） 调用是否失败，以及失败日志引用在哪里。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 8 节《Event Protocol》；第 15 节《模块划分》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 6 节《Worker 生命周期》；第 9 节《诊断事件清单》；第 10 节《错误分类》
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 4.4 节《LLM I/O 日志格式》；第 6 节《event_log 查询模式》；第 8.3 节《state 缓存结构》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/README.md` — 全文件（仅在需要补最小手测说明时允许更新）
7. `ts-core/src/interfaces/contracts.ts` — 全文件
8. `ts-core/src/interfaces/api.ts` — 全文件
9. `ts-core/src/interfaces/server.ts` — 全文件
10. `ts-core/src/interfaces/realtime.ts` — 全文件
11. `ts-core/src/interfaces/index.ts` — 全文件
12. `ts-core/src/diagnostics/contracts.ts` — 全文件
13. `ts-core/src/diagnostics/logs.ts` — 全文件
14. `ts-core/src/diagnostics/index.ts` — 全文件
15. `ts-core/src/app/contracts.ts` — 全文件
16. `ts-core/src/app/bootstrap.ts` — 全文件
17. `ts-core/src/app/entrypoint.ts` — 全文件
18. `ts-core/src/app/index.ts` — 全文件
19. `ts-core/src/data/contracts.ts` — 全文件（仅在需要复用事件 / 回放契约时允许更新）
20. `ts-core/src/data/schema.ts` — 全文件（仅在需要复用 `event_log`（事件日志） 字段定义时允许更新；本轮不做 migration（迁移））
21. `ts-core/src/data/logs.ts` — 全文件（仅在需要读取 `LLM`（大语言模型） 日志引用摘要时允许更新）
22. `ts-core/src/data/index.ts` — 全文件
23. `ts-core/src/workers/conversation-worker.ts` — 全文件（仅允许接出最近一次 `LLM`（大语言模型） 调用摘要的只读诊断 sink（汇点））
24. `ts-core/src/workers/contracts.ts` — 全文件（仅允许补只读诊断类型，不允许改任务生命周期语义）
25. `ts-core/src/conversation/llm.ts` — 全文件（仅允许复用或导出既有诊断摘要类型，不允许改 prompt（提示词） 语义）
26. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
27. `ts-core/src/__tests__/interfaces-model.spec.ts` — 全文件
28. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
29. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
30. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件（仅在复用 JSONL（结构化日志） 诊断断言时允许更新）

**核心逻辑要求**:

1. **状态读取必须只读、脱敏、可手测**:
   - 现有 `/api/status`（状态接口） 若已存在，应在其上收口；若缺字段，补最小字段，不另起写接口。
   - 返回内容应至少包含 `bot_id`（机器人标识）、运行时状态、Mineflayer（Minecraft 协议客户端） 连接 / `world_ready`（世界交互就绪） 快照、工作线程是否已装配、可选的最近一次 `LLM`（大语言模型） 调用摘要。
   - 绝不能暴露 `LLM_API_KEY`（大语言模型接口密钥）、EasyAuth（离线服认证模组） 明文密码、PostgreSQL（关系型数据库） 连接串、Redis（缓存） 密码或底层 Bot（机器人） 可写句柄。

2. **事件回放必须保持 append-only（只追加） 语义**:
   - `/api/replay`（事件回放接口） 必须按 `bot_id`（机器人标识） 过滤，按 `seq`（序号） 升序返回，`after_seq`（起始序号） 必须是排他条件。
   - `limit`（数量限制） 必须有上限，默认值和最大值要稳定；非法 `after_seq` / `limit` 不能进入数据层。
   - 若当前环境有真实 `event_log`（事件日志） repository（仓库 / 存储适配） 注入，应读取真实来源；测试环境可用注入式内存实现，但不能把“空列表”伪装成真实 PG（关系型数据库） 查询成功。
   - 回放接口只读，不允许补任何调试写入、事件伪造或队列写入能力。

3. **最近一次 LLM 调用摘要必须最小可诊断**:
   - 摘要只保存最近一次即可，本轮不做完整审计查询；完整原始 I/O（输入输出） 仍以 JSONL（结构化日志） 文件为准。
   - 摘要字段建议限制为：`stage`（阶段：triage / chat / plan）、`message_id`（消息标识）、`status`（状态：ok / error）、`model`（模型名）、`log_ref`（日志引用）、`error_summary`（错误摘要，可选）、`created_at`（创建时间）。
   - 不得把完整 prompt（提示词）、completion（补全）、用户原文长上下文、密钥或认证信息塞进状态接口；状态接口只给定位线索。
   - `ConversationWorker`（对话工作线程） 若需要接出诊断，只能通过依赖注入的只读诊断 sink（汇点） 记录摘要，不得反向依赖 `interfaces`（接口边界）。

4. **在线装配必须复用现有入口**:
   - `startAppOnlineRuntime()`（真实在线启动入口） 负责把状态读取、回放读取、最近 `LLM`（大语言模型） 摘要源接到 Fastify（接口网关） 路由。
   - 不新增新的进程入口，不改变 `POST /api/message`（消息提交接口） 的入队语义，不改变 `BotWorker`（机器人工作线程） / `ConversationWorker`（对话工作线程） 的任务生命周期。
   - Socket.io（实时推送） 若已有广播模型，本轮最多补只读事件类型适配；不得把 Socket.io 变成消息入口。

5. **范围边界**:
   - 本任务不引入 `sandbox`（沙箱） / `isolated-vm`（隔离虚拟机）。
   - 本任务不新增技能、不改 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 执行语义。
   - 本任务不新增数据库 migration（迁移），除非发现现有 `event_log`（事件日志） 契约与代码完全缺失且必须补纯 TypeScript（类型脚本） 契约；这种情况需在反馈里说明。
   - 本任务不做网页 UI（用户界面），只提供可用 `curl`（命令行请求） 或测试调用验证的接口能力。

**验收标准**:

1. `/api/status`（状态接口） 能返回真实在线装配的只读运行状态、连接 / `world_ready`（世界交互就绪） 摘要与最近一次 `LLM`（大语言模型） 调用摘要，且不含任何密钥 / 明文密码 / 可写 Bot（机器人） 句柄。
2. `/api/replay`（事件回放接口） 按 `bot_id`（机器人标识） + `after_seq`（起始序号） + `limit`（数量限制） 返回升序事件；非法参数被路由层拒绝或规范化，不进入数据读取层。
3. `ConversationWorker`（对话工作线程） 的 `triage`（分诊） / `chat`（闲聊） / `plan`（规划） 成功与失败路径能更新最近一次 `LLM`（大语言模型） 摘要；失败摘要能指向 `log_ref`（日志引用） 或错误摘要。
4. `POST /api/message`（消息提交接口）、`chat`（闲聊）、`cancel`（取消）、`goTo`（前往坐标）、`mine`（挖掘）、`collect`（捡拾）、`equip`（装备） 既有路径不回归。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-026`
- [ ] 仅读取并修改白名单内文件
- [ ] `/api/status`（状态接口） 为只读、脱敏输出，不暴露密钥 / 明文密码 / 可写 Bot（机器人） 句柄
- [ ] `/api/replay`（事件回放接口） 按 `bot_id`（机器人标识） 过滤、按 `seq`（序号） 升序、`after_seq`（起始序号） 排他、`limit`（数量限制） 有上限
- [ ] 最近一次 `LLM`（大语言模型） 调用摘要覆盖成功与失败路径，且只保存最小诊断字段
- [ ] 未新增调试写接口、未改变消息入队 / 技能执行 / cancel（取消） 中断语义
- [ ] 自动化测试覆盖状态读取、事件回放、`LLM`（大语言模型） 摘要脱敏与既有路径回归
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

**回填序号**: 

**修改文件**:
- 

**执行摘要**:
- 

**预检输出摘要**:
- 

**遗留疑问**:
- 

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-027（可选 / MVP 后置）**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 `isolated-vm`（隔离虚拟机） 真实执行与 Facade API（门面接口） 桥接；启动前必须评估“渐进披露 + LRU（最近最少使用） 热队列”，不默认一次性塞入全量 Facade（门面接口） 手册。
- **T-028**: 在 `conversation`（对话） + `runtime`（运行时） + `diagnostics`（诊断） 内补 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，让女仆执行任务时能回答“我正在做什么”。
- **T-029**: 在 `brain`（摘要工作线程） + `data`（数据层） + `conversation`（对话） 内补齐任务摘要沉淀与可检索记忆，为复杂任务与后续 sandbox（沙箱） 经验蒸馏做准备。
