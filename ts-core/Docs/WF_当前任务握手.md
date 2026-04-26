# 当前任务握手区

【任务序号】: T-028
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `core-ports`（核心端口层） + `runtime`（运行时） + `sandbox`（沙箱） + `skills`（技能） + `observation`（观测） + `diagnostics`（诊断） + `data`（数据层） 这一组架构边界内，完成循环依赖治理。目标是把被多方共享的纯类型、枚举、事件载荷、任务状态与日志类型下沉到 `ts-core/src/core-ports/`（核心端口层），让 `runtime`（运行时）、`sandbox`（沙箱）、`skills`（技能）、`observation`（观测）、`diagnostics`（诊断）、`data`（数据层） 只单向依赖端口层，消除当前模块循环并加入预检守门。

**上下文说明**:
1. `T-027`（任务二十七） 已通过，当前系统已具备真实 `sandbox_code`（沙箱代码） 执行链，但引入后放大了 `runtime`（运行时） ↔ `sandbox`（沙箱） 的值级循环。
2. 最近架构审查确认至少存在两类问题：值级循环包括 `runtime`（运行时） ↔ `sandbox`（沙箱）、`runtime`（运行时） ↔ `diagnostics`（诊断）；类型级循环包括 `runtime`（运行时） ↔ `observation`（观测）、`runtime`（运行时） ↔ `skills`（技能）、`data`（数据层） → `runtime`（运行时）。
3. 本轮是架构止血，不新增业务能力，不改变 `BotActor`（机器人执行代理） 单写者语义，不改变 MC（Minecraft，我的世界） 行为，不改变 `skill_call`（技能调用） / `sandbox_code`（沙箱代码） / `chat`（闲聊） / `cancel`（取消） 的对外行为。
4. 本轮默认新建 `ts-core/src/core-ports/`（核心端口层），不要把更多跨模块共享类型继续堆入 `domain`（领域层）。`domain`（领域层） 只保留更基础的领域对象与不变量工具；`core-ports`（核心端口层） 承载跨模块端口契约。
5. 本轮必须把循环依赖检测接入 `bash ts-core/scripts/pre_review.sh`（评审前预检脚本）。可选 `madge`（依赖图工具） 或 `dependency-cruiser`（依赖巡检工具），优先选改动小、输出明确、能在本项目稳定运行的一种。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 2 节《七层技术架构》；第 6 节《执行核心：BotActor 状态机》；第 8 节《Event Protocol》；第 14 节《数据与持久化边界》；第 15 节《模块划分》；第 16 节《目录结构》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》；第 2 节《状态机完整定义》；第 3 节《中断协议详细规格》；第 5 节《任务执行流》；第 8 节《observation 与 BotActor 的交互契约》；第 9 节《诊断事件清单》
3. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 4 节《Facade API 完整类型定义》；第 5 节《Facade API 注入机制》；第 7 节《超时与生命周期管理》；第 9 节《步骤结果收集》；第 10 节《skill_call 与 sandbox_code 的统一抽象》
4. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 11 节《回复广播与事件发射》；第 12 节《ConversationWorker 完整处理流程》；第 15 节《错误处理与降级》
5. `ts-core/Docs/05_DATA_SPEC.md` — 第 2 节《PostgreSQL Schema 设计》；第 4 节《JSONL 日志规格》；第 6 节《event_log 查询模式》；第 9 节《数据一致性约定》
6. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》；第 5 节《状态流转》；第 9 节《预检脚本》
7. `ts-core/Docs/WF_架构治理批次计划.md` — 第 0 节《起因与硬约束》；第 `T-028` 节《循环依赖治理》
8. `ts-core/scripts/pre_review.sh` — 全文件
9. `ts-core/package.json` — 全文件（仅允许新增循环依赖检测所需开发依赖与脚本）
10. `ts-core/pnpm-lock.yaml` — 全文件（仅随依赖安装更新）
11. `ts-core/tsconfig.json` — 全文件（只读，除非依赖检测工具必须读取配置；原则上不修改）
12. `ts-core/src/core-ports/**` — 新增目录，全文件
13. `ts-core/src/domain/contracts.ts` — 全文件（只读优先；仅当需要复用 `ModuleBoundary`（模块边界） 或基础领域类型时允许最小适配）
14. `ts-core/src/domain/invariants.ts` — 全文件（只读）
15. `ts-core/src/runtime/contracts.ts` — 全文件
16. `ts-core/src/runtime/events.ts` — 全文件
17. `ts-core/src/runtime/tasking.ts` — 全文件
18. `ts-core/src/runtime/state-machine.ts` — 全文件
19. `ts-core/src/runtime/actor.ts` — 全文件
20. `ts-core/src/runtime/transport.ts` — 全文件（仅允许 import（导入）路径与类型来源适配，不拆文件）
21. `ts-core/src/runtime/index.ts` — 全文件
22. `ts-core/src/observation/contracts.ts` — 全文件
23. `ts-core/src/observation/runtime.ts` — 全文件
24. `ts-core/src/observation/snapshot.ts` — 全文件（只读优先；仅允许类型来源适配）
25. `ts-core/src/observation/index.ts` — 全文件
26. `ts-core/src/skills/contracts.ts` — 全文件
27. `ts-core/src/skills/execution.ts` — 全文件
28. `ts-core/src/skills/registry.ts` — 全文件
29. `ts-core/src/skills/index.ts` — 全文件
30. `ts-core/src/sandbox/contracts.ts` — 全文件
31. `ts-core/src/sandbox/execution.ts` — 全文件
32. `ts-core/src/sandbox/facade.ts` — 全文件（只读优先；仅允许类型来源适配）
33. `ts-core/src/sandbox/index.ts` — 全文件
34. `ts-core/src/diagnostics/contracts.ts` — 全文件
35. `ts-core/src/diagnostics/logs.ts` — 全文件
36. `ts-core/src/diagnostics/index.ts` — 全文件
37. `ts-core/src/data/contracts.ts` — 全文件
38. `ts-core/src/data/schema.ts` — 全文件
39. `ts-core/src/data/logs.ts` — 全文件
40. `ts-core/src/data/index.ts` — 全文件
41. `ts-core/src/interfaces/contracts.ts` — 全文件（仅允许类型来源适配）
42. `ts-core/src/interfaces/realtime.ts` — 全文件（仅允许类型来源适配）
43. `ts-core/src/interfaces/server.ts` — 全文件（仅允许类型来源适配）
44. `ts-core/src/interfaces/index.ts` — 全文件（仅允许导出适配）
45. `ts-core/src/conversation/contracts.ts` — 全文件（仅允许类型来源适配）
46. `ts-core/src/conversation/planning.ts` — 全文件（仅允许类型来源适配）
47. `ts-core/src/conversation/triage.ts` — 全文件（仅允许类型来源适配）
48. `ts-core/src/conversation/llm.ts` — 全文件（只读优先；仅允许类型来源适配，不做 `DRY`（不要重复自己） 重构）
49. `ts-core/src/conversation/index.ts` — 全文件（仅允许导出适配）
50. `ts-core/src/workers/contracts.ts` — 全文件（仅允许类型来源适配）
51. `ts-core/src/workers/bot-worker.ts` — 全文件（仅允许类型来源适配）
52. `ts-core/src/workers/conversation-worker.ts` — 全文件（仅允许类型来源适配）
53. `ts-core/src/workers/index.ts` — 全文件（仅允许导出适配）
54. `ts-core/src/app/bootstrap.ts` — 全文件（仅允许依赖注入适配，例如向 `BotActor`（机器人执行代理） 注入日志引用工厂；不拆文件）
55. `ts-core/src/app/entrypoint.ts` — 全文件（仅允许类型来源适配）
56. `ts-core/src/app/index.ts` — 全文件（仅允许导出适配）
57. `ts-core/src/__tests__/*.spec.ts` — 全部测试文件（仅允许因 import（导入）路径、公开类型来源、循环检测新增测试而最小修改）

**核心逻辑要求**:

1. **必须消除真实循环依赖，而不是只让工具安静**:
   - `runtime`（运行时） 不得值级依赖 `sandbox`（沙箱）、`diagnostics`（诊断）、`skills`（技能）、`observation`（观测）。
   - `sandbox`（沙箱）、`diagnostics`（诊断）、`skills`（技能）、`observation`（观测）、`data`（数据层） 不得反向依赖 `runtime`（运行时） 的实现文件来获取共享枚举或载荷类型。
   - 若只靠 `import type`（类型导入） 保持双向类型耦合，仍不算完成；本轮目标是架构方向收敛，不只是运行时加载无环。

2. **共享契约下沉到 `core-ports`（核心端口层）**:
   - 至少下沉这些跨模块共享项：`BotStatus`（机器人状态）、`InterruptSource`（中断来源）、任务历史状态、任务终态、执行任务类型 / 载荷、运行时事件类型 / 载荷、技能名 / 技能参数、威胁评估相关纯类型、日志行需要复用的任务状态。
   - 原模块可保留 re-export（重新导出） 以降低调用方迁移成本，但 re-export（重新导出） 不得重新制造循环。
   - `core-ports/index.ts`（核心端口层入口） 需要提供清晰 barrel（聚合导出），便于后续模块按端口依赖。

3. **实现依赖通过 DI（依赖注入） 装配，不能从核心层反向 import（导入） 上层实现**:
   - `runtime/actor.ts`（运行时执行代理） 不再直接 `import`（导入） `diagnostics/logs.ts`（诊断日志文件）。`createSandboxLogRef`（创建沙箱日志引用） 或等价能力由 `app/bootstrap.ts`（应用引导） 注入。
   - `runtime`（运行时） 不再从 `skills/index.ts`（技能入口） 导入实现或目录对象；如需技能参数校验，只依赖 `core-ports`（核心端口层） 的纯端口契约，真实执行仍由注入的 skill executor（技能执行器） / adapter（适配器） 完成。
   - `sandbox/execution.ts`（沙箱执行器） 不再从 `runtime/tasking.ts`（运行时任务模型） 取任务状态；改为从 `core-ports`（核心端口层） 取纯枚举。
   - `data/contracts.ts`（数据契约） 与 `data/schema.ts`（数据结构） 不再依赖 `runtime/events.ts`（运行时事件） 或 `runtime/tasking.ts`（运行时任务模型）。

4. **预检守门必须可重复执行**:
   - `pre_review.sh`（评审前预检脚本） 必须增加循环检测步骤，位置应在 typecheck（类型检查） 之前或之后均可，但失败时必须让脚本退出非零。
   - 若使用 `madge`（依赖图工具），命令必须能识别 TypeScript（类型脚本） / NodeNext（节点下一代模块解析） 项目；若工具对 `type-only`（仅类型） 边表现不稳定，需要在 Coder（编码代理） 反馈中说明实际检测口径。
   - 循环检测不能依赖全局安装，必须通过 `package.json`（包配置） / `pnpm-lock.yaml`（依赖锁文件） 固化。

5. **严格控制范围，禁止借机重构大文件或改业务语义**:
   - 不拆 `app/bootstrap.ts`（应用引导）、`data/contracts.ts`（数据契约）、`runtime/transport.ts`（运行时传输）、`conversation/llm.ts`（对话大语言模型） 等超大文件；这些留给 `T-029`（任务二十九）。
   - 不抽 `executeStage`（阶段执行模板）、不改 prompt（提示词） 文件化、不做 skill（技能） 策略表重构；这些留给 `T-030`（任务三十）。
   - 不新增 MC（Minecraft，我的世界） 事实数据，不改变 EasyAuth（离线服认证模组） 外部认证策略，不改变任何 HTTP（超文本传输协议） 接口字段。

**验收标准**:

1. `runtime`（运行时） ↔ `sandbox`（沙箱）、`runtime`（运行时） ↔ `diagnostics`（诊断）、`runtime`（运行时） ↔ `observation`（观测）、`runtime`（运行时） ↔ `skills`（技能）、`data`（数据层） → `runtime`（运行时） 这五类循环被消除；依赖检测工具输出无循环。
2. 新增 `core-ports`（核心端口层） 后，各业务模块只从该层读取共享纯类型 / 枚举 / 载荷；`data`（数据层） 与 `diagnostics`（诊断） 不再 import（导入） `runtime/*`（运行时目录） 实现文件。
3. `BotActor`（机器人执行代理） 的业务行为保持不变：`chat`（闲聊）、`cancel`（取消）、`skill_call`（技能调用）、`sandbox_code`（沙箱代码） 的既有测试仍通过，且没有修改对外 API（应用程序接口） 字段。
4. Coder（编码代理） 反馈区必须贴出一张 ASCII（美国标准信息交换码） DAG（有向无环图） 或等价依赖方向摘要，说明当前模块方向，例如 `core-ports -> domain` 不允许，`runtime -> core-ports` 允许。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-028`
- [ ] 仅读取并修改白名单内文件
- [ ] `core-ports`（核心端口层） 承载跨模块共享纯类型 / 枚举 / 载荷，未继续扩大 `domain`（领域层） 职责
- [ ] 五类循环依赖均已消除，且不是仅靠忽略规则绕过
- [ ] `runtime`（运行时） 不再值级依赖 `sandbox`（沙箱）、`diagnostics`（诊断）、`skills`（技能）、`observation`（观测）
- [ ] `data`（数据层） 与 `diagnostics`（诊断） 不再依赖 `runtime/*`（运行时目录） 实现文件获取共享类型
- [ ] `pre_review.sh`（评审前预检脚本） 已加入可重复执行的循环依赖检测
- [ ] 未拆超大文件、未重构 `conversation/llm.ts`（对话大语言模型文件）、未改变业务语义
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-029**: 超大文件拆分 — 拆 `app/bootstrap.ts`、`data/contracts.ts`、`runtime/transport.ts`、`conversation/llm.ts`、`workers/conversation-worker.ts`，并把 `MineflayerBotHandle`（Mineflayer 机器人句柄） 按能力切 port（端口）。
- **T-030**: 模式重构与收口 — `conversation/llm.ts` 抽 `executeStage`（阶段执行模板） 模板方法、`parseConversationSkillPlan`（解析对话技能规划） 改 skill（技能） 策略表、Prompt（提示词） 抽到 `prompts/` 模板文件、小型 DRY（不要重复自己） 收口、命名约定写入 `01_ARCHITECTURE.md`（架构规范）。
- **T-031**: 在 `conversation`（对话） + `runtime`（运行时） + `diagnostics`（诊断） 内补 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，让女仆执行任务时能回答“我正在做什么”。
