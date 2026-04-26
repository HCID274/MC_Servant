# 当前任务握手区

【任务序号】: T-030
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `conversation/llm`（对话大语言模型） + `interfaces`（接口层） + `domain`（领域基础） + `Docs/01_ARCHITECTURE.md`（架构规范） 这一组模块内完成架构治理批次最后收口：抽出 `executeStage`（阶段执行模板） 统一三段 LLM（大语言模型） 调用流程，把 `parseConversationSkillPlan`（解析对话技能规划） 改为 table-driven（表驱动） skill（技能） 策略表，抽离 Prompt（提示词） 模板，收口小型 DRY（不要重复自己） 问题，并把字段命名约定写入架构文档。目标是降低后续 T-031（任务三十一） 状态投影注入与 T-032（任务三十二） composite output（复合输出） 的改动风险，不新增 MC（Minecraft，我的世界） 行为。

**上下文说明**:
1. `T-028`（任务二十八） 已完成循环依赖治理，`pre_review.sh`（评审前预检脚本） 已接入 `pnpm dep:cycles`（循环依赖检测）；本轮不得重新引入循环依赖。
2. `T-029`（任务二十九） 已把 `conversation/llm.ts`（对话大语言模型入口） 拆到 `conversation/llm/*`，并把五个超大文件拆成职责子目录。本轮必须在这些小文件内做模式重构，禁止回滚拆分。
3. 本轮仍是治理任务，不新增技能、不改 `BotActor`（机器人执行代理） 单写者语义、不改 `ConversationWorker`（对话工作线程） 对外行为、不改 OpenAI（开放人工智能） 兼容接口字段。
4. 当前 `conversation/llm/client.ts`（大语言模型客户端） 三个方法 `generateTriage`（生成分诊） / `generateChatReply`（生成闲聊回复） / `generateSkillPlan`（生成技能规划） 有重复结构：记录开始时间、组消息、发请求、解析、写诊断、失败处理。需要抽成内部模板方法，但三个公共方法签名和失败语义必须保持。
5. 当前 `conversation/llm/parsers.ts`（大语言模型解析器） 的 `parseConversationSkillPlan()` 仍是 `switch`（分支） + 多处类型断言；本轮要改成 skill（技能） 到 guard（守卫） / builder（构建器） 的策略表，新增技能时只需扩表。
6. 当前 Prompt（提示词） 文本内仍有 skill（技能） 样例参数和猫娘人设硬编码。本轮要把模板与 skill（技能） 段生成拆开，避免在 Prompt（提示词） 中写死 Minecraft（我的世界） 事实数据；示例参数只能是占位符或由技能 schema（结构约束）动态生成的字段说明。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 2 节《用户强约束》；第 3 节《Minecraft 事实来源约束》；第 9 节《编码规范》；第 11 节《文档规则》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 15 节《模块划分》；第 16 节《目录结构》；允许新增一节《命名约定》
4. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 2 节《两阶段 LLM 调用模型》；第 3 节《Stage 1: Triage Prompt 设计》；第 4 节《Stage 2-Chat: 闲聊回复》；第 5 节《Stage 2-Plan: 任务规划》；第 14 节《人设一致性保障》；第 15 节《错误处理与降级》；第 16 节《LLM 客户端抽象》
5. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 9 节《预检脚本》
6. `ts-core/Docs/WF_架构治理批次计划.md` — 第 `T-030` 节《模式重构与最后收口》
7. `ts-core/scripts/pre_review.sh` — 全文件（只读）
8. `ts-core/package.json` — 全文件（只读；原则上不修改依赖）
9. `ts-core/tsconfig.json` — 全文件（只读）
10. `ts-core/src/conversation/llm.ts` — 全文件
11. `ts-core/src/conversation/llm/**` — 全部文件；允许新增 `prompts/`、`stage.ts`、`skill-plan-table.ts` 或同等职责文件
12. `ts-core/src/conversation/contracts.ts` — 全文件（仅允许导入路径或类型适配）
13. `ts-core/src/conversation/planning.ts` — 全文件（仅允许导入路径或类型适配）
14. `ts-core/src/conversation/triage.ts` — 全文件（仅允许导入路径或类型适配）
15. `ts-core/src/conversation/index.ts` — 全文件（仅允许导出适配）
16. `ts-core/src/core-ports/skills.ts` — 全文件（只读优先；仅允许导出辅助类型的最小补强，不改已有技能语义）
17. `ts-core/src/core-ports/index.ts` — 全文件（仅允许导出适配）
18. `ts-core/src/domain/invariants.ts` — 全文件（允许新增通用正整数 / 正数断言与只读克隆复用工具）
19. `ts-core/src/interfaces/server.ts` — 全文件（仅允许错误工厂迁移后的导入适配）
20. `ts-core/src/interfaces/errors.ts` — 新增文件，全文件
21. `ts-core/src/interfaces/index.ts` — 全文件（仅允许导出适配）
22. `ts-core/src/app/bootstrap.ts` — 全文件（仅允许导出适配）
23. `ts-core/src/app/bootstrap/**` — 全部文件（仅允许 Prompt（提示词）模板加载 / 注入所需的最小装配适配，不改变启动顺序）
24. `ts-core/src/app/entrypoint.ts` — 全文件（仅允许 Prompt（提示词）模板注入或导入路径适配，不改变在线启动语义）
25. `ts-core/src/workers/conversation-worker.ts` — 全文件（仅允许导入路径适配）
26. `ts-core/src/workers/conversation-worker/**` — 全部文件（仅允许导入路径适配）
27. `ts-core/src/diagnostics/contracts.ts` — 全文件（仅允许类型导入适配）
28. `ts-core/src/diagnostics/logs.ts` — 全文件（仅允许类型导入适配）
29. `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts` — 全文件
30. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件
31. `ts-core/src/__tests__/interfaces-server-model.spec.ts` — 全文件
32. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件（仅允许因 Prompt（提示词）模板注入或导入路径变化做最小适配）
33. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件（仅允许因导入路径、公共导出或通用工具迁移导致的最小适配）

**核心逻辑要求**:

1. **只做治理收口，不改业务语义**:
   - `generateTriage()`（生成分诊） 失败仍回退为 `chat/normal`（闲聊 / 普通）。
   - `generateChatReply()`（生成闲聊回复） 失败仍抛 `ConversationLlmChatError`（对话大语言模型闲聊错误） 并携带诊断。
   - `generateSkillPlan()`（生成技能规划） 失败仍抛 `ConversationLlmPlanError`（对话大语言模型规划错误）。
   - `chat`（闲聊）、`cancel`（取消）、`skill_call`（技能调用）、`sandbox_code`（沙箱代码）、`status`（状态） / `replay`（回放） 既有测试语义不得改变。

2. **抽 `executeStage`（阶段执行模板）**:
   - 在 `conversation/llm`（对话大语言模型） 内新增内部模板方法，统一 startedAt（开始时间）、logRef（日志引用）、invocationLines（调用日志行）、`requestChatCompletionPayload()`（发起对话补全请求）、成功诊断、失败诊断的重复流程。
   - 三个公共方法只保留 `buildMessages`（构建消息）、`parse`（解析）、`onFailure`（失败策略） 等差异点。
   - 模板方法必须保持诊断字段、日志引用路径、token（文本配额）统计和耗时语义不变。

3. **把 `parseConversationSkillPlan()`（解析对话技能规划） 改为策略表**:
   - 新增 skill（技能） 到 `{ guard, buildPlan }` 的只读策略表，覆盖 `goTo`（前往坐标）、`mine`（挖掘）、`collect`（捡拾）、`equip`（装备）。
   - 移除现有 `switch`（分支） 中重复 case（分支） 结构；新增技能时应只扩表。
   - 尽量移除 `as ConversationLlmPlanResult`（类型断言）。若 TypeScript（类型脚本） 泛型收敛确实需要一个极小断言，必须限制在策略表内部并加中文注释说明原因，禁止散落在每个技能分支。

4. **Prompt（提示词）模板化与 skill（技能）段动态生成**:
   - 把 triage（分诊）、chat（闲聊）、plan（规划） 的 Prompt（提示词）正文从 `messages.ts`（消息构造） 中拆出到 `conversation/llm/prompts/`（提示词目录） 或同等独立模板文件；`messages.ts` 只负责参数填充和消息组装。
   - plan（规划） 的允许技能列表、参数字段说明与非法输出规则必须从 `SKILL_DIRECTORY`（技能目录） / 策略表 / 参数 schema（结构约束）生成或集中定义，不要在多处手写。
   - 不得在 Prompt（提示词） 中写死 Minecraft（我的世界） 领域事实数据；`stone`、`cobblestone`、`stone_pickaxe` 等具体样例应替换为 `<block_name>`、`<item_name>`、`<destination>` 等占位符或通用 schema（结构约束）说明。
   - 如果采用 `.md`（Markdown 文档） 模板文件，必须保证测试和运行时能稳定加载；若需要注入模板对象，在线入口必须提供默认模板，不能让缺文件导致已通过路径启动失败。

5. **小型 DRY（不要重复自己） 与错误工厂收口**:
   - 把 `timeout_ms`（超时毫秒） 正数校验等通用校验收敛到 `domain/invariants.ts`（领域不变量），不要在 `conversation/llm/config.ts`（大语言模型配置） 继续内联重复。
   - 新增 `interfaces/errors.ts`（接口错误工厂），集中 `createHttpBadRequest`（HTTP 400 错误） 与 `createHttpServiceUnavailable`（HTTP 503 错误）；`interfaces/server.ts`（接口服务器） 只导入使用。
   - 对诊断记录等只读克隆逻辑优先复用 `cloneReadonlyValue`（只读值克隆） 或同等已有工具，避免重复手写多层 `Object.freeze()`（冻结对象）。

6. **命名约定写入架构文档**:
   - 在 `Docs/01_ARCHITECTURE.md`（架构规范） 增补《命名约定》小节。
   - 明确：对外协议 / 持久化字段使用 `snake_case`（下划线命名）；运行时 JS（JavaScript） / TS（TypeScript） 内部变量使用 `camelCase`（驼峰命名）；跨边界转换由工厂函数集中处理，例如 `bot_id`（机器人标识字段） ↔ `botId`（机器人标识变量）。
   - 不把阶段性实现清单堆进 `AGENTS.md`（代理规则文件）。

7. **依赖图与文件边界保持健康**:
   - 不新增模块循环；`pnpm dep:cycles`（循环依赖检测） 必须继续通过。
   - 不把 `conversation`（对话） 反向依赖 `app`（应用装配） 或 `runtime`（运行时） 实现。
   - 不新增重量级依赖，不改变 `package.json`（包配置） 依赖集。

**验收标准**:

1. `conversation/llm/client.ts`（大语言模型客户端） 通过 `executeStage`（阶段执行模板） 消除三段重复流程，三条公共路径的成功 / 失败诊断、异常类型和返回值语义保持原样。
2. `parseConversationSkillPlan()`（解析对话技能规划） 改为表驱动；新增技能扩展点集中，重复 `switch`（分支） case（分支） 与分散类型断言被移除或最小化。
3. Prompt（提示词） 模板已独立组织，plan（规划） 技能段不再写死具体 Minecraft（我的世界） 物品 / 方块样例；相关测试覆盖模板加载 / 消息组装 / 技能段生成。
4. `interfaces/errors.ts`（接口错误工厂）、`domain/invariants.ts`（领域不变量） 与 `Docs/01_ARCHITECTURE.md`（架构规范命名约定） 完成收口，且不引入新循环依赖。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-030`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增 MC（Minecraft，我的世界） 行为、未改对外 API（应用程序接口） 字段、未改 BotActor（机器人执行代理） 单写者语义
- [ ] `conversation/llm`（对话大语言模型） 已完成 `executeStage`（阶段执行模板） 与 skill（技能） 策略表收口
- [ ] Prompt（提示词） 已独立组织，且未写死 Minecraft（我的世界） 事实数据
- [ ] 小型 DRY（不要重复自己） 与接口错误工厂已收口
- [ ] `Docs/01_ARCHITECTURE.md`（架构规范） 已新增命名约定
- [ ] `pnpm dep:cycles`（循环依赖检测） 无循环
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-031**: 在 `conversation`（对话） + `runtime`（运行时） + `diagnostics`（诊断） 内补 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，让女仆执行任务时能回答“我正在做什么”。
- **T-032**: 在 `conversation`（对话） 内把 triage（分诊） 输出从单 intent（意图） 升级为 composite output（复合输出），支持 cancel（取消） + reply（回复） + action（动作） 的有序派发。
- **T-033**: 在 `data`（数据层） + `workers`（工作线程） 内恢复 BrainWorker（摘要工作线程） 任务摘要与可检索记忆沉淀，放在可运行主干与架构治理之后推进。
