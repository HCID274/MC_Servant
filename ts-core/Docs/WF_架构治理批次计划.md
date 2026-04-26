# 架构治理批次计划（备忘）

【批次状态】: T-028（任务二十八） 已派发
【创建日期】: 2026-04-26
【触发来源】: 2026-04-26 Code Review（代码评审），用户决策暂停原 T-028（任务二十八） 功能扩展，先做架构止血

---

## 0. 起因与硬约束

1. **循环依赖比清单更严重**：值级循环至少存在 `runtime`（运行时） ↔ `sandbox`（沙箱）、`runtime`（运行时） ↔ `diagnostics`（诊断）；类型级循环还包括 `runtime`（运行时） ↔ `observation`（观测）、`runtime`（运行时） ↔ `skills`（技能）、`data`（数据层） → `runtime`（运行时）。
2. **超大文件**：`app/bootstrap.ts` 1719、`data/contracts.ts` 1575、`runtime/transport.ts` 1023、`conversation/llm.ts` 988、`workers/conversation-worker.ts` 615。
3. **conversation/llm.ts（对话大语言模型文件） 内三段几乎复制粘贴** + `parseConversationSkillPlan`（解析对话技能规划） 违反 OCP（开闭原则）。
4. **Prompt（提示词） 与 skill（技能） 样例参数硬编码**，已逼近 `AGENTS.md`（代理规则文件） 第 3 条边界。
5. **`MineflayerBotHandle`（Mineflayer 机器人句柄） 是胖接口**，违反 ISP（接口隔离原则）。
6. **小型 DRY（不要重复自己） 与命名约定** 未集中落地。

**顺序硬约束**：

- T-028（任务二十八） 必须最先做。继续推进原 T-028（chat_reply BotActor 状态投影） 会扩大 conversation ↔ runtime 耦合，必须先把依赖图变 DAG（有向无环图）。
- T-029（任务二十九） 必须在 T-030（任务三十） 之前。先把超大文件拆开，T-030 的模式重构只在小文件内改逻辑，改动面最小。
- T-028（任务二十八） 与 T-029（任务二十九） 弱依赖：T-028 先做，可以让 T-029 拆出的小文件直接落到正确的依赖层，避免返工。
- 原功能队列整体顺延：原 T-028 / T-029 / T-030 改为 T-031 / T-032 / T-033，避免违反任务序号递增规则。

---

## T-028: 循环依赖治理（架构止血，最高优先级）

### 目标
- 消除全部 5 对模块循环：`runtime ↔ sandbox`、`runtime ↔ diagnostics`、`runtime ↔ observation`、`runtime ↔ skills`、`data → runtime`。
- 模块依赖图收敛为 DAG（有向无环图）。
- 不动任何业务语义；仅做类型与文件位置搬运。

### 实施
1. 新建端口层 `ts-core/src/core-ports/`（也可选择扩展现有 `domain/`），收纳被多方共享的纯类型/枚举/事件载荷/任务状态/日志类型，例如：
   - `runtime/events.ts`（运行时事件） 中被 `data`、`diagnostics` 引用的事件类型与载荷
   - `runtime/tasking.ts`（任务模型） 中被 `data`、`diagnostics`、`sandbox` 引用的 `TaskHistoryStatus`（任务历史状态） 等
   - `runtime/contracts.ts`（运行时契约） 中被 `interfaces`、`observation` 引用的状态枚举
   - `skills/contracts.ts`（技能契约） 中被 `runtime`、`sandbox` 引用的 `SkillName`、`SkillParamsByName` 等
   - `observation/contracts.ts`（观测契约） 中被 `runtime` 引用的 `ThreatLevel`、`ThreatRuleId` 等
2. 让 `runtime`、`skills`、`observation`、`diagnostics`、`data`、`sandbox` 全部单向依赖端口层；具体实现走 DI（依赖注入），由 `app/bootstrap.ts`（应用引导） 装配。
3. 关键 cut（切线）：
   - `runtime/actor.ts` 不再 `import` `diagnostics/logs.js`；改成由 `bootstrap` 把 `createSandboxLogRef` 等以工厂注入。
   - `runtime/{actor,tasking,transport}.ts` 不再 `import` `skills/index.js` 的实现；只保留对 `core-ports/skills` 的纯类型依赖。
   - `runtime/actor.ts` 与 `runtime/contracts.ts` 不再 `import` `observation/*`；把 `ThreatLevel`、`ThreatAssessment`、`ObservationRuntimeCache` 等纯类型下沉到端口层。
   - `sandbox/execution.ts` 不再 `import` `runtime/tasking.ts` 的实现；改用端口层枚举。
   - `data/{schema,contracts}.ts` 不再 `import` `runtime/*`；改用端口层。
4. CI（持续集成） 守门：在 `scripts/pre_review.sh`（评审前预检脚本） 接入 `madge --circular` 或 `dependency-cruiser`，未来出现新循环直接拒绝合并。

### 验收
- `madge --circular ts-core/src` 输出为空。
- `pre_review.sh`（评审前预检脚本） 通过；类型检查、Biome（代码规范检查）、Vitest（测试） 全绿；不修改任何对外行为，已有 161 条测试不变。
- 对依赖关系画一张 ASCII（美国标准信息交换码） DAG（有向无环图） 贴在本任务执行反馈区。

### 边界
- 不改业务逻辑、不改对外接口、不改测试断言（仅允许补必要的 import 路径变更）。
- 不拆超大文件（留给 T-029）；不重构 `conversation/llm.ts`（留给 T-030）。

---

## T-029: 超大文件拆分（SRP 落地）

### 目标
- 5 个超大文件全部拆到单文件 ≤ 约 400 行（硬性以"按聚合根 / 按职责" 切分为准）。
- 顺手把 `MineflayerBotHandle`（Mineflayer 机器人句柄） 按能力切成多个 port（端口）。

### 实施

1. **`data/contracts.ts` 1575 → 按聚合根拆**
   - 目录化为 `data/contracts/{owners,bots,sessions,chat-messages,event-log,task-history,task-summaries,session-summaries,config,index}.ts`。
   - `data/index.ts`（数据层入口） 重新导出，保持外部 import 路径稳定。

2. **`runtime/transport.ts` 1023 → 按技能 adapter（适配器） 拆**
   - `runtime/transport/{base,go-to,mine,collect,equip,pathfinder,index}.ts`。
   - 同时按能力切 port（端口）：`ChatPort`（聊天端口） / `MovementPort`（移动端口） / `MiningPort`（挖掘端口） / `InventoryPort`（背包端口） / `LifecyclePort`（生命周期端口）；`MineflayerBotHandle` 改为这些端口的组合类型，便于按需 mock（模拟）。

3. **`app/bootstrap.ts` 1719 → 按子系统拆**
   - `app/bootstrap/{db,interfaces,runtime,workers,conversation,sandbox,index}.ts`，每个子系统装配函数返回该子系统的资源契约；`app/bootstrap/index.ts` 只做 compose（组合）。

4. **`workers/conversation-worker.ts` 615 → 路由 handler（处理器） 分文件**
   - `workers/conversation-worker/{runtime,handlers/{chat-reply,cancel-interrupt,plan-exec,modify-then-plan},events,index}.ts`；主 runtime 只做调度。

5. **`conversation/llm.ts` 988 → 关注点分离**
   - `conversation/llm/{config,types,client,http,parsers,errors,index}.ts`；`prompts/` 子目录为 T-030 留位。

### 验收
- `find ts-core/src -name "*.ts" -not -path "*/__tests__/*" | xargs wc -l | awk '$1 > 500'` 输出仅剩明显合理的少数例外（应当为空或近似空）。
- `pre_review.sh` 全绿；外部 import 路径若变化，需保留 barrel（聚合导出文件） 或更新调用方一次到位。
- 行为零回归：原 161 条测试不变；新增结构性测试可选。

### 边界
- 拆分必须只动文件位置与导出，不动业务逻辑。
- 不做 DRY（不要重复自己） / OCP（开闭原则） 重构（留给 T-030）。

---

## T-030: 模式重构与最后收口（DRY / OCP / Prompt / 命名）

### 目标
- 在已拆好的小文件内做最终重构；消除三段复制粘贴、消灭 OCP 违反、把 Prompt 与 skill 段抽到模板文件、集中小型工具。

### 实施

1. **`conversation/llm/client.ts`（对话大语言模型客户端） 抽 `executeStage<TIn,TOut>()` 模板方法**
   - 三个公共方法 `generateTriage`（生成分诊） / `generateChatReply`（生成闲聊回复） / `generateSkillPlan`（生成技能规划） 只剩 `buildMessages` / `parse` / `onFailure` 三个差异点。
   - 估算正文规模缩到原来 1/3。

2. **`parseConversationSkillPlan`（解析对话技能规划） 改 skill→{guard, builder} 策略表**
   ```ts
   const SKILL_PLAN_TABLE: { [K in SkillName]?: {
     guard: (p: unknown) => p is SkillParamsByName[K];
     buildPlan: (reply: string, params: SkillParamsByName[K]) => ConversationLlmPlanResult;
   } } = { goTo: ..., mine: ..., collect: ..., equip: ... };
   ```
   - 新增 skill 只加一行；不再有 `as ConversationLlmPlanResult`（类型断言）。

3. **Prompt（提示词） 文件化**
   - `conversation/llm/prompts/{triage,chat,plan}.md` 存模板正文。
   - skill 段从 `SKILL_DIRECTORY`（技能目录） + 策略表自动生成；`stone` / `cobblestone` / `stone_pickaxe` 等示例替换为占位符或动态注入，避开 `AGENTS.md`（代理规则文件） 第 3 条边界。
   - 启动时由 `bootstrap` 注入 `loadPromptTemplates()` 结果，便于后续单元测试与无代码改动迭代。

4. **小型 DRY（不要重复自己） 收口**
   - 把 `assertPositiveInteger`（正整数断言） 提到 `domain/invariants.ts`（领域不变量）；移除 `llm.ts` 内联校验。
   - 新建 `interfaces/errors.ts`（接口层错误工厂） 集中 `createHttpBadRequest`（HTTP 400 错误） / `createHttpServiceUnavailable`（HTTP 503 错误）。
   - 工厂内手写 `Object.freeze({ ..., lines: Object.freeze([...lines]) })` 改为 `cloneReadonlyValue`（只读深克隆）。

5. **命名约定文档化**
   - 在 `Docs/01_ARCHITECTURE.md`（架构规范） 增补一节《命名约定》：
     - 对外契约字段使用 `snake_case`（下划线命名）；
     - 运行时 JS（JavaScript） 对象内部参数使用 `camelCase`（驼峰命名）；
     - 跨边界处由工厂统一桥接（`bot_id` ↔ `botId` 等）。

### 验收
- `pre_review.sh` 全绿；161+ 条测试通过。
- `conversation/llm/client.ts` 行数显著下降；策略表与 prompts 模板各自有最小契约测试。
- 命名约定段落进入 `01_ARCHITECTURE.md`（架构规范）。

### 边界
- 不改对外接口、不改 `BotActor`（机器人执行代理） 单写者语义、不改技能行为。

---

## 后续（架构治理完成后再恢复）

- **T-031（任务三十一）**: `chat_reply`（闲聊回复） 注入 `BotActor`（机器人执行代理） 状态只读投影。
- **T-032（任务三十二）**: triage（分诊） 单 intent（意图） 升级为 composite output（复合输出）。
- **T-033（任务三十三）**: 任务摘要沉淀与可检索记忆。

---

## 备注

- 本批次定位为"架构止血 + 结构整理"，**严禁** 借机引入新功能或调整业务语义。
- 每个任务派发时，再单独写入 `WF_当前任务握手.md`（当前任务握手） 的输入文件白名单与详细验收标准；本备忘只承担"为什么 / 顺序 / 范围 / 验收骨架"。
- 机械预检本次未执行；任何 T-X 启动前 Coder（编码代理） 仍须按 `09_AGENT_WORKFLOW.md`（代理工作流） 跑 `pre_review.sh`（评审前预检脚本） 全套。
