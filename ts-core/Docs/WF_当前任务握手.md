# 当前任务握手区

【任务序号】: T-038
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `runtime/`（运行时） 的 BotActor（机器人执行代理） 边界内补齐脊髓反射动作最小执行闭环：当 observation（观测） 已产生的 `reflex`（反射） 中断信号进入 BotActor（机器人执行代理） 时，BotActor（机器人执行代理） 应进入 `REFLEXING`（反射中）、选择硬编码的最低风险反射动作、通过可注入执行端口执行动作，并在完成后回到 `IDLE`（空闲）。本轮只做 BotActor（机器人执行代理） 内部反射执行与事件投影，不接入 LLM（大语言模型）、Prompt（提示词）、planner（规划器）、数据库、HTTP（超文本传输协议） 路由或真实 JAR（自定义服务端插件） 桥接。

**上下文说明**:
1. T-缺-B 已明确要求把脊髓反射动作硬编码到 BotActor（机器人执行代理） 中；当前 observation（观测） 已能产出 `ThreatAssessment`（威胁评估） 并创建 `ReflexInterruptSource`（反射中断来源）。
2. `runtime/state-machine.ts`（运行时状态机） 已存在 `REFLEXING`（反射中） 状态和 `reflex.triggered`（反射已触发） / `reflex.done`（反射已完成） 事件判定，但 `createBotActorRuntime()`（创建机器人执行代理运行时） 尚未暴露真实 `interrupt()`（中断）入口，也没有执行反射动作。
3. 当前 `MineflayerRuntimeTransport`（Minecraft 协议客户端运行时传输） 没有低层 `attack`（攻击） / `jump`（跳跃） / `sprint`（疾跑） 端口；本轮允许在 BotActor（机器人执行代理） 内新增可注入 `reflexActionExecutor`（反射动作执行器）端口，用测试假实现证明闭环。若需要改真实 transport（传输层） 暴露 Mineflayer（Minecraft 协议客户端） 原始 Bot（机器人）句柄，必须停止并在反馈区说明，不得直接打开原始句柄。
4. 本轮不重新设计 threat detector（威胁检测器）规则、不修改 observation（观测） 规则阈值、不引入 `minecraft-data`（MC 事实包） 新用法；反射动作只依据 `ThreatAssessment`（威胁评估） 中已有 `level`（等级）、`rule_id`（规则标识）、实体摘要与 Bot（机器人）状态摘要。
5. 本轮不要求真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；如果实际触碰 LLM（大语言模型）调用链路、Prompt（提示词）、parser（解析器）、对话路由或 online entrypoint（在线入口装配），必须按长期规则补真实 API（应用程序接口）结果。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 0.2 节《真实 LLM API 验收规则》；第 5 节《ts-core 工具链与工程基线》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 4.2 节《第一层：脊髓反射》；第 5 节《中断协议》；第 6 节《执行核心：BotActor 状态机》；第 15 / 18 节相关模块与 Phase 1（第一阶段） 表
4. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2 节状态机；第 3 节中断协议；第 4 节脊髓反射系统；第 8 节 observation（观测） 与 BotActor（机器人执行代理） 交互契约
5. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent（编码代理）》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
6. `ts-core/Docs/WF_开发进度记录.md` — 当前批次记录，尤其 T-025（任务二十五）到 T-037（任务三十七）相关运行时、观测与事实来源记录
7. `ts-core/Docs/WF_需求变更索引.md` — 与 MVP（最小可运行闭环） 优先级、真实 LLM（大语言模型）验收相关条目
8. `ts-core/scripts/pre_review.sh` — 全文件（只读）
9. `ts-core/package.json`、`ts-core/pnpm-lock.yaml` — 只读；本轮不得新增依赖
10. `ts-core/tsconfig.json`、`ts-core/biome.json`、`ts-core/vitest.config.ts` — 只读
11. `ts-core/src/core-ports/runtime.ts` — 全文件，允许为中断 / 反射动作端口做最小契约适配
12. `ts-core/src/core-ports/observation.ts` — 全文件，优先只读；仅允许导出类型需要时做最小适配
13. `ts-core/src/core-ports/events.ts`、`ts-core/src/core-ports/tasking.ts` — 只读优先；仅允许为反射事件载荷做最小补充
14. `ts-core/src/runtime/contracts.ts` — 全文件
15. `ts-core/src/runtime/state-machine.ts` — 全文件
16. `ts-core/src/runtime/events.ts` — 全文件
17. `ts-core/src/runtime/actor.ts` — 全文件
18. `ts-core/src/runtime/index.ts`、`ts-core/src/runtime.ts`、`ts-core/src/index.ts` — 仅允许导出适配
19. `ts-core/src/runtime/transport/types.ts`、`ts-core/src/runtime/transport/runtime.ts`、`ts-core/src/runtime/transport/index.ts` — 只读；如确需新增低层动作端口，先在反馈区说明原因，等待 Manager（管理代理） 重新派发
20. `ts-core/src/observation/snapshot.ts`、`ts-core/src/observation/runtime.ts`、`ts-core/src/observation/index.ts` — 只读，仅用于理解现有 `ThreatAssessment`（威胁评估） 来源
21. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 允许补充 BotActor（机器人执行代理） 反射执行测试
22. `ts-core/src/__tests__/runtime-model.spec.ts`、`ts-core/src/__tests__/observation-world-model.spec.ts`、`ts-core/src/__tests__/observation-runtime-model.spec.ts` — 仅允许因公共契约或导出变化做最小适配
23. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件仅允许因公共导出或编译失败做最小适配

**核心逻辑要求**:

1. **BotActor（机器人执行代理） 中断入口**:
   - `BotActorRuntime`（机器人执行代理运行时） 应新增 `interrupt(signal)`（中断）方法，接收现有 `InterruptSignal`（中断信号）。
   - 非 `reflex`（反射）中断不得被本轮扩大成复杂调度系统；若当前状态不是 `EXECUTING`（执行中） 且不是可接受反射状态，应按现有 `resolveTransition()`（解析状态转换） 决策忽略或排队。
   - `reflex`（反射）中断在 `IDLE`（空闲） 或 `EXECUTING`（执行中） 状态下必须触发 `REFLEXING`（反射中） 转换；`INITIALIZING`（初始化中）、`REFLEXING`（反射中）、`DEAD`（死亡）、`SHUTDOWN`（关闭） 的行为必须与状态机决策一致。

2. **硬编码反射动作选择**:
   - 新增一个小而明确的反射动作模型，例如 `flee`（逃离）、`fight`（战斗）、`emergency`（紧急）、`no_op`（无操作） 中的有限集合；命名由 Coder（编码代理）按现有风格确定。
   - 动作选择只依据 `ThreatAssessment`（威胁评估） 现有字段：
     - `ThreatLevel.Flee`（逃离等级） 默认选择逃离类动作。
     - `ThreatLevel.Fight`（战斗等级） 默认选择战斗类动作。
     - `ThreatLevel.Emergency`（紧急等级） 根据 `rule_id`（规则标识） 区分最低风险动作；`Falling`（坠落） 必须选择 `no_op`（无操作），避免干扰物理引擎。
   - 不新增 Minecraft（我的世界）事实表，不写死配方、掉落、工具等级或方块规则。

3. **可注入动作执行器**:
   - BotActor（机器人执行代理） 内部必须硬编码“从威胁到反射动作”的选择逻辑，但具体物理执行可通过注入的 `reflexActionExecutor`（反射动作执行器）完成，便于测试与后续接入真实 Mineflayer（Minecraft 协议客户端）底层动作。
   - 没有注入执行器时应有明确、可测试的安全降级：可以执行 `no_op`（无操作）并记录 `reflex.done`（反射完成），但不得假装已攻击或已逃离。
   - 执行器失败或超时不得让 BotActor（机器人执行代理） 卡在 `REFLEXING`（反射中）；必须回到 `IDLE`（空闲） 并留下可审计结果。超时可用可注入 `now()`（当前时间函数）或短超时 Promise（异步承诺）实现，测试不得依赖真实长等待。

4. **事件与快照**:
   - `BotActorRuntimeSnapshot`（机器人执行代理运行时快照） 应能反映最近反射执行摘要，至少包含 action（动作）、threat rule（威胁规则）、status（状态）或 error（错误）摘要；字段命名需保持只读和可冻结。
   - `emitted_events`（已发事件） 应包含 `state.transition`（状态转换）、`reflex.triggered`（反射触发） 与 `reflex.done`（反射完成）；若从 `EXECUTING`（执行中） 进入反射，还应包含 `task.interrupted`（任务已中断）。
   - 反射执行期间不得允许普通技能或沙箱任务并发进入；现有单写者边界不能放宽。

5. **范围禁止**:
   - 不修改 LLM（大语言模型） Prompt（提示词）、message（消息）构造、parser（解析器）、triage（分诊）、planner（规划器） 或 online entrypoint（在线入口装配）。
   - 不新增依赖，不新增数据库迁移、PostgreSQL（关系型数据库）查询、Redis（缓存）查询、JSONL（结构化日志）读取、HTTP（超文本传输协议）路由、WebSocket（全双工通信协议）或 Socket.io（实时通信库）服务。
   - 不新增 JAR（自定义服务端插件）通信实现；T-039（任务三十九） 前必须先确认 JAR（自定义服务端插件）端发包能力。
   - 不暴露 Mineflayer（Minecraft 协议客户端）原始 Bot（机器人）句柄给上层模块。

**验收标准**:

1. 单元测试覆盖 `IDLE`（空闲） 状态收到 `reflex`（反射）中断后进入反射动作、执行动作、回到 `IDLE`（空闲），并记录 `reflex.triggered`（反射触发） / `reflex.done`（反射完成）。
2. 单元测试覆盖 `EXECUTING`（执行中） 状态收到 `reflex`（反射）中断时记录 `task.interrupted`（任务已中断） 并执行反射动作；不得把原任务标记为 completed（已完成）。
3. 单元测试覆盖 `Flee`（逃离）、`Fight`（战斗）、`Emergency/Falling`（紧急/坠落） 至少三类动作选择，且 `Falling`（坠落） 为 `no_op`（无操作）。
4. 单元测试覆盖执行器缺省、执行器失败或超时后的安全回到 `IDLE`（空闲） 行为。
5. 快照与返回结果为只读对象；调用方不能污染后续快照。
6. 未新增依赖，未触碰 LLM（大语言模型） / Prompt（提示词） / parser（解析器） / online entrypoint（在线入口装配）；因此不要求真实 API（应用程序接口）验收。
7. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-038`
- [ ] 仅读取并修改白名单内文件
- [ ] 未新增依赖、公开路由、数据库迁移或网络服务
- [ ] `interrupt(signal)`（中断） 入口遵循现有状态机决策
- [ ] 反射动作选择硬编码在 BotActor（机器人执行代理） 边界内，且不包含 Minecraft（我的世界）事实表
- [ ] 反射动作执行器可注入；缺省、失败、超时均安全回到 `IDLE`（空闲）
- [ ] `IDLE`（空闲） / `EXECUTING`（执行中） / `Flee`（逃离） / `Fight`（战斗） / `Emergency/Falling`（紧急/坠落） 测试已覆盖
- [ ] 未触碰 LLM（大语言模型） / Prompt（提示词） / parser（解析器） / online entrypoint（在线入口装配）；若触碰，已回填真实 API（应用程序接口）验收
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 回填）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-039**: JAR（自定义服务端插件） 桥接通信落地；派发前 Manager（管理代理） 必须先与用户确认 JAR（自定义服务端插件）端是否已具备发包能力。
- **T-040**: PostgreSQL（关系型数据库） / vector（向量） memory provider（记忆提供器） 最小真实读适配，承接 T-033（任务三十三） 与 T-036（任务三十六） 的端口。
- **T-041**: 视 T-039（任务三十九）结果决定，可能进入端到端 demo（演示） 收口或架构治理批次。

---

### Phase 1（第一阶段） 必做项遗漏补登（2026-04-26 由用户审计后追加，Manager（管理代理） 排期前必读，禁止再次误删）

下列三项是 `01_ARCHITECTURE.md`（架构文档） 第 18 节 Phase 1（第一阶段） 必做表与第 12 / 4.2 / 2 节明确承诺、但截至当前批次仍需排期的盲区。Manager（管理代理） 在排定后续任务前，必须先把它们纳入候选，不得再被新增对话能力优先级覆盖；本节由用户审计追加，Manager（管理代理） 不得在轮换批次时静默删除，如需重排请保留本节并显式更新候选编号。

- **T-缺-A（已完成 T-037）：`minecraft-data`（MC 事实包） 集成**
  - 缺口现状：`world-model/`（世界模型） 模块壳完整，但此前未引入 `minecraft-data`（MC 事实依赖包）。文档第 12.1 节承诺的“MC 常识 = 本地确定性 API（应用程序接口）查询”此前未通路。
  - 排期状态：已作为 T-037（任务三十七） 完成并通过审查。

- **T-缺-B（当前 T-038）：脊髓反射动作硬编码到 BotActor（机器人执行代理）**
  - 缺口现状：observation（观测） 已能产出 `threat_level`（威胁等级） 并向 BotActor（机器人执行代理） 发中断信号，`runtime/state-machine.ts`（运行时状态机） 已有 `REFLEXING`（反射中） 状态，但文档承诺的反射动作仍未在 BotActor（机器人执行代理） 内硬编码执行。
  - 排期状态：已作为 T-038（任务三十八） 派发。

- **T-缺-C（候选 T-039）：JAR（自定义服务端插件） 桥接通信落地**
  - 缺口现状：`interfaces/server-bridge/`（服务端桥接接口） 目前只有 `contracts.ts`（契约） + `index.ts`（导出），无 WebSocket（全双工通信协议） / TCP（传输控制协议） 真实通信、无 JAR（自定义服务端插件）端最小协议握手。
  - 排期前置依赖：Manager（管理代理） 必须在派发前与用户确认 JAR（自定义服务端插件）端是否已具备发包能力；若尚未实现，需先决定是“TS Core（TypeScript 单核心）端先做通信骨架 + mock（模拟）JAR（自定义服务端插件）端测试”还是“等 JAR（自定义服务端插件）端就绪再排”。

---

### 潜在代码债备忘（2026-04-26 由用户审计追加，未排期但已记账，禁止误删）

下列条目不构成 Phase 1（第一阶段） 必做项缺口，也不影响当前批次推进；仅作为"代码已经在不优雅的状态，未来某次架构治理批次应集中处理"的提示。Manager（管理代理） 不需要立即排期，但在下一次架构治理批次（参考历史 T-028 ~ T-030）启动时，应把本节作为候选清单读入。

- **代码债 D-1：`src/app/entrypoint.ts` 已达 804 行，需要按职责拆分**
  - 现状：T-029（任务二十九） 已完成 `app/bootstrap/` 子目录拆分（11 文件），但 `entrypoint.ts` 本体仍以 804 行单文件承载在线运行时装配、启停顺序、健康检查投影、状态投影注入等多个职责，是当前 `src/` 中最大的单文件之一。
  - 建议拆分方向（仅为参考，最终由治理批次的 Manager（管理代理） 决定）：`online-runtime-assemble.ts`（在线运行时装配） / `online-runtime-lifecycle.ts`（在线运行时启停） / `health-snapshot.ts`（健康投影） / `state-projection-wiring.ts`（状态投影接线）。
  - 触发条件：当 `entrypoint.ts` 再次因为新增能力而显著膨胀（例如 T-034（任务三十四） 实时推送装配 / T-036（任务三十六） memory（记忆） 注入装配 / 后续真实 provider（提供器） 装配陆续接入），优先级即应升至下一次架构治理批次的候选首位。
  - 不做范围：不在此条记账下做任何"顺手拆一下"的零散修改；拆分必须作为独立任务由 Manager（管理代理） 派发，避免与功能任务混在同一 commit。

- **架构文档 v0.4 同步范围说明（与本备忘联动）**
  - 已同步：`01_ARCHITECTURE.md`（架构文档） 第 2 节七层架构图、第 15 节模块表、第 16 节目录结构 已按当前实际代码追认 `app/`（应用装配） 与 `core-ports/`（核心端口） 两层，并升级为反映子目录拆分的两层视图。
  - 未同步（语义级，留待整批次收口后再做）：BotActor（机器人执行代理） 状态机 6 态图（含 `INITIALIZING` / `DEAD` / `SHUTDOWN`）、`createRuntimeReadyGate`（运行时就绪门控） 显式建模、`broadcastReply`（广播回复） 收口于单写者、`ConversationCompositeTriage`（对话复合分诊） 升级 Triage Prompt（分诊提示词） 设计、BotActor（机器人执行代理）反射动作执行闭环 等差异。这些属于"代码语义级演进"，建议等 T-033 ~ T-040 批次收口后由 Manager（管理代理） 统一推进 v0.4 文档跃迁，不要在功能任务中夹带文档语义改动。
