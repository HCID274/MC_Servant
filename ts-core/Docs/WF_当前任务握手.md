# 当前任务握手区

【任务序号】: T-008
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `conversation`（对话） / `workers`（工作线程） 模块的最小强类型契约，收口 `ConversationWorker`（对话工作线程） 的分诊 / 闲聊 / 规划三类产物、`msg:{botId}` / `bot:{botId}:exec` / `brain` 三类队列名与任务包边界，以及 cancel / modify（取消 / 修改） 对 `runtime`（运行时） 中断协议的桥接语义，为后续 `db`（数据库接入） / `config`（配置） 接线与首轮无 MC（Minecraft） 冒烟闭环提供稳定的任务流转骨架；但不接入真实 `BullMQ`（队列）、`Redis`（缓存）、`LLM`（大语言模型） SDK、网络 I/O（输入输出） 或任何 Worker（工作线程） 进程。

**上下文说明**:
1. `T-006` 已稳定 `interfaces`（接口层） 的消息入口、会话绑定与 replay（补拉） 边界，`T-007` 已稳定 `sandbox`（沙箱） / `diagnostics`（诊断） 的执行与日志契约；当前距离无 MC（Minecraft） 联调最近的结构性缺口，转为“消息进入后如何分诊、产出什么、由哪个 Worker（工作线程） 接手”。
2. `01_ARCHITECTURE.md` 明确三队列模型：`msg:{botId}` 由 `ConversationWorker`（对话工作线程） 消费，`bot:{botId}:exec` 由 `BotWorker`（机器人工作线程） 串行消费，`brain` 由 `BrainWorker`（摘要工作线程） 异步消费；模块间只能通过队列、事件与类型接口通信，不能直接 import（导入） 对方内部实现。
3. `04_CONVERSATION_SPEC.md` 已定义 Stage 1 `triage`（分诊） 与 Stage 2 `chat` / `plan`（闲聊 / 规划） 的职责、产物与 modify（修改任务） 特殊流程；本任务需要把这些行为规格沉淀为可测试的纯类型与纯函数边界，而不是直接上真实 Prompt（提示词） 组装器、模型调用器或队列执行器。
4. 当前 Phase 1（第一阶段） 可执行技能仍以 `skills`（技能） 模块现有目录为准。对话规划契约可以声明 `skill_call`（技能调用） 与 `sandbox_code`（沙箱代码） 双路径，但不能抢跑引入尚未落地的平行技能名，也不能默认依赖未来 `goToOwner` / `follow` / `attack` 等未进入当前主线的动作。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 3 节《三队列异步架构》、第 5 节《中断与优先级》、第 15 节《模块划分》、第 16 节《目录结构》
2. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》、第 2 节《两阶段 LLM 调用模型》、第 3 节《Stage 1: Triage Prompt 设计》、第 4 节《Stage 2-Chat: 闲聊回复》、第 5 节《Stage 2-Plan: 任务规划》、第 6 节《上下文预算管理》、第 12 节《ConversationWorker 完整处理流程》、第 13 节《modify 意图的特殊处理》、第 14 节《人设一致性保障》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/src/index.ts` — 全文件
6. `ts-core/src/domain/contracts.ts` — 全文件
7. `ts-core/src/runtime/contracts.ts` — 全文件
8. `ts-core/src/runtime/tasking.ts` — 全文件
9. `ts-core/src/interfaces/contracts.ts` — 全文件
10. `ts-core/src/skills/contracts.ts` — 全文件
11. `ts-core/src/sandbox/contracts.ts` — 全文件
12. `ts-core/src/diagnostics/contracts.ts` — 全文件
13. `ts-core/src/observation/index.ts` — 全文件
14. `ts-core/src/conversation/index.ts` — 全文件（允许新建）
15. `ts-core/src/conversation/contracts.ts` — 全文件（允许新建）
16. `ts-core/src/conversation/triage.ts` — 全文件（允许新建）
17. `ts-core/src/conversation/chat.ts` — 全文件（允许新建）
18. `ts-core/src/conversation/planning.ts` — 全文件（允许新建）
19. `ts-core/src/workers/index.ts` — 全文件（允许新建）
20. `ts-core/src/workers/contracts.ts` — 全文件（允许新建）
21. `ts-core/src/workers/queues.ts` — 全文件（允许新建）
22. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
23. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `conversation`（对话） 模块中至少拆清四类概念：Stage 1 `MessageTriage`（消息分诊） 输入输出、Stage 2 `chat`（闲聊） 回复产物、Stage 2 `plan`（规划） 产物、以及基于 intent / priority（意图 / 优先级） 的纯路由结果；不得接入真实 `LLM`（大语言模型） SDK、Prompt（提示词） 拼接器、记忆检索器、数据库查询或网络调用。
2. `plan`（规划） 契约必须显式区分 `skill_call`（技能调用） 与 `sandbox_code`（沙箱代码） 两条路径，并与现有 `skills`（技能） / `runtime`（运行时） / `sandbox`（沙箱） 契约对齐；不得再造平行技能名集合，也不得默认引入当前未落地的未来技能。
3. 在 `workers`（工作线程） 模块中至少拆清三类边界：队列名与队列 Key（键） 生成规则、`ConversationWorker` / `BotWorker` / `BrainWorker` 的输入任务与输出动作、以及 cancel / modify（取消 / 修改） 到 `InterruptSignal`（中断信号） 的桥接语义；不得接入真实 `BullMQ`（队列）、`Redis`（缓存）、后台线程或并发执行器。
4. `modify`（修改任务） 语义必须收口为“先中断，再基于当前消息重新规划”的契约，不得引入旧计划 diff（差异对比） 模型；`cancel`（取消任务） 则必须收口为无需二次规划的直接中断 + 模板回复路径。
5. 测试优先覆盖：根导出、三队列命名、分诊回退、`skill_call` / `sandbox_code` 双路径对齐、cancel / modify 分流、优先级到队列侧行为的映射、负向类型约束；不要写依赖真实 `BullMQ`（队列）、`Redis`（缓存）、`LLM`（大语言模型）、数据库、文件系统或网络的测试。

**验收标准**:
1. `conversation`（对话） 与 `workers`（工作线程） 模块已落地并接入 `src/`（源代码） 根导出，模块职责与三队列模型可从类型层直接读出。
2. `MessageTriage`（消息分诊）、闲聊回复、规划产物、路由决策、队列任务包与 Worker（工作线程） 输出动作均具备强类型模型或纯函数构造边界。
3. `plan`（规划） 契约已明确区分 `skill_call`（技能调用） 与 `sandbox_code`（沙箱代码），且前者严格对齐现有 Phase 1（第一阶段） `skills`（技能） 目录，后者复用既有 `sandbox`（沙箱） 执行请求边界。
4. cancel / modify（取消 / 修改） 已通过纯契约明确桥接到 `runtime`（运行时） 中断协议；不存在旧计划 diff（差异对比） 模型、平行技能命名集合或跨模块实现耦合。
5. 新增测试覆盖根导出、三队列命名、分诊回退、双路径规划、cancel / modify 分流与负向类型约束，且执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-008`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实 `BullMQ`（队列） / `Redis`（缓存） / `LLM`（大语言模型） / 网络 I/O（输入输出）
- [ ] `skill_call`（技能调用） / `sandbox_code`（沙箱代码） 双路径已与现有 `skills`（技能） / `sandbox`（沙箱） 契约对齐，未引入平行技能集合
- [ ] 三队列命名、cancel / modify（取消 / 修改） 路由与 `InterruptSignal`（中断信号） 语义已对齐文档
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: `T-008`
- **修改文件**:
- **执行摘要**:
- **自检结果**:
  - [ ] 任务序号核对为 `T-008`
  - [ ] 仅读取并修改白名单内文件
  - [ ] 新增导出符号均补充中文文档注释
  - [ ] 未引入真实 `BullMQ`（队列） / `Redis`（缓存） / `LLM`（大语言模型） / 网络 I/O（输入输出）
  - [ ] `skill_call`（技能调用） / `sandbox_code`（沙箱代码） 双路径已与现有 `skills`（技能） / `sandbox`（沙箱） 契约对齐，未引入平行技能集合
  - [ ] 三队列命名、cancel / modify（取消 / 修改） 路由与 `InterruptSignal`（中断信号） 语义已对齐文档
  - [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过
- **预检输出摘要**:
- **遗留疑问**:

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-009: 建立 `db`（数据库接入） / `config`（配置） 的最小边界，收口 PostgreSQL（关系型数据库） / Redis（缓存） / 日志路径 / 环境变量契约。
- T-010: 建立本地应用装配与首轮无 MC（Minecraft） 冒烟闭环骨架，串起 `interfaces`（接口层）、`workers`（工作线程）、`runtime`（运行时） 与 `sandbox`（沙箱） 的启动边界。
- T-011: 建立 `game-chat`（游戏聊天适配） / `server-bridge`（服务端桥接） 的最小 ingress（入口） 契约，收口网页与游戏双端消息进入主线的统一包结构。
