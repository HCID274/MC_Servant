# 当前任务握手区

【任务序号】: T-037
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `world-model/`（世界模型） 边界内正式接入 `minecraft-data`（MC 事实包），提供一个可测试、可注入、只读的 Minecraft（我的世界）事实查询端口，用于按版本查询 block（方块）、item（物品） 与 recipe（配方） 基础事实。本轮目标是补齐“MC 常识 = 本地确定性 API（应用程序接口）查询”的主通路，不接入 LLM（大语言模型） Prompt（提示词），不改 planner（规划器）决策，不做中文词汇映射，不新增数据库或网络服务。

**上下文说明**:
1. 用户审计补登的 Phase 1（第一阶段） 缺口中，T-缺-A 已明确要求优先做 `minecraft-data`（MC 事实包） 集成。
2. `world-model/`（世界模型） 当前已有 query（查询） / refresh（刷新） 边界与资源 cluster（资源簇） 查询，但尚未引入 `minecraft-data`（MC 事实包）。
3. `AGENTS.md`（仓库规则） 明确禁止在代码或 Prompt（提示词） 中写死 Minecraft（我的世界）领域事实；本轮必须把事实来源限制为 `minecraft-data`（MC 事实包） 包自身。
4. 本轮允许新增运行时依赖 `minecraft-data`（MC 事实包），并更新 `package.json`（依赖清单） 与 `pnpm-lock.yaml`（依赖锁文件）。除此之外不得新增依赖。
5. 本轮不触碰 LLM（大语言模型） 调用链路、Prompt（提示词）、parser（解析器）、对话路由或 online entrypoint（在线入口装配）。如实现中发现必须触碰这些路径，先停止并在反馈区说明原因，等待 Manager（管理代理） 重新派发。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `AGENTS.md` — 第 3 节《Minecraft 事实来源约束》；第 5 节《ts-core 工具链与工程基线》；第 9 节《编码规范》
2. `ts-core/agent.md` — 全文件
3. `ts-core/Docs/01_ARCHITECTURE.md` — 第 12 节 MC（Minecraft，我的世界） 事实来源相关内容；第 15 节《模块划分》；第 18 节 Phase 1（第一阶段） 任务表
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent（编码代理）》；第 5 节《状态流转》；第 6.1 节《正常开发循环》
5. `ts-core/Docs/WF_需求变更索引.md` — 与 Minecraft（我的世界） 事实来源、MVP（最小可运行闭环） 优先级相关条目
6. `ts-core/Docs/WF_开发进度记录.md` — 当前批次记录，尤其 T-031（任务三十一） 至 T-036（任务三十六）
7. `ts-core/scripts/pre_review.sh` — 全文件（只读）
8. `ts-core/package.json` — 允许仅为新增 `minecraft-data`（MC 事实包） 依赖修改
9. `ts-core/pnpm-lock.yaml` — 允许因 `pnpm add minecraft-data`（添加依赖） 自动更新
10. `ts-core/tsconfig.json`、`ts-core/biome.json`、`ts-core/vitest.config.ts` — 只读
11. `ts-core/src/world-model/contracts.ts` — 全文件
12. `ts-core/src/world-model/query.ts` — 全文件
13. `ts-core/src/world-model/index.ts` — 全文件
14. `ts-core/src/index.ts` — 仅允许导出适配
15. `ts-core/src/domain/contracts.ts`、`ts-core/src/domain/invariants.ts` — 只读优先；仅允许因 world-model（世界模型） 导出类型需要做最小适配
16. `ts-core/src/core-ports/skills.ts`、`ts-core/src/core-ports/observation.ts` — 只读，仅用于理解已有 block（方块） / item（物品） 命名边界
17. `ts-core/src/__tests__/observation-world-model.spec.ts` — 允许补充 `minecraft-data`（MC 事实包） 查询测试
18. `ts-core/src/__tests__/scaffold.spec.ts` — 仅允许因根导出变化做最小适配
19. `ts-core/src/__tests__/*.spec.ts` — 其他测试文件仅允许因公共导出或编译失败做最小适配

**核心逻辑要求**:

1. **事实来源边界**:
   - 代码不得手写 Minecraft（我的世界）配方、掉落、工具等级、方块组、硬度、可挖掘规则等事实表。
   - 所有 block（方块）、item（物品）、recipe（配方） 等事实必须来自 `minecraft-data`（MC 事实包） 的版本化 registry（注册表）。
   - 测试不得通过复制大段事实表来证明正确性；应验证封装结果与 `minecraft-data`（MC 事实包） registry（注册表）一致，或验证结构、不可变性、错误边界与版本选择行为。

2. **版本化查询端口**:
   - 新增的查询端口必须显式接收 Minecraft（我的世界）版本，或通过一个清晰的 factory（工厂函数） 固定版本后再查询；不得在模块加载时隐式绑定某个版本。
   - 无效版本必须产生清晰错误，不允许静默 fallback（回退） 到其他版本。
   - 输出对象应为只读快照，不暴露可变的 `minecraft-data`（MC 事实包） 原始对象引用。

3. **最小事实能力**:
   - 至少提供 block（方块） 按 name（名称） 与 numeric id（数字标识） 查询。
   - 至少提供 item（物品） 按 name（名称） 与 numeric id（数字标识） 查询。
   - 至少提供 recipe（配方） 按 result item name（产出物品名称） 查询的只读结果；本轮只封装事实，不做规划推理或自动合成步骤。
   - 查询未命中时返回 `null`（空结果） 或空数组，不抛业务异常；只有版本错误、输入非法等边界错误才抛出。

4. **world-model（世界模型） 集成方式**:
   - 新增能力优先落在 `world-model/`（世界模型） 内，可新建小文件，例如 `minecraft-data.ts`（MC 事实包适配） 或 `facts.ts`（事实查询），但不得把实现塞进 god file（巨型文件）。
   - `worldModelModuleBoundary`（世界模型模块边界） 的职责 / `placeholderExports`（占位导出） 应更新到能反映事实查询已存在。
   - 根入口导出可以补齐，但不要让 app（应用装配）、conversation（对话） 或 runtime（运行时） 依赖它。

5. **范围禁止**:
   - 不修改 LLM（大语言模型） Prompt（提示词）、message（消息）构造、parser（解析器）、triage（分诊）、planner（规划器） 或 online entrypoint（在线入口装配）。
   - 不新增数据库迁移、PostgreSQL（关系型数据库） 查询、Redis（缓存） 查询、JSONL（结构化日志） 读取、HTTP（超文本传输协议） 路由、WebSocket（全双工通信协议） 或 Socket.io（实时通信库） 服务。
   - 不新增中文词汇映射；中文到标准 id（标识） 翻译后续独立任务处理。

**验收标准**:

1. `package.json`（依赖清单） 与 `pnpm-lock.yaml`（依赖锁文件） 只新增 `minecraft-data`（MC 事实包） 所需变更，无其他依赖漂移。
2. 单元测试覆盖有效版本创建查询端口、无效版本错误、block（方块） name（名称） / id（标识） 查询、item（物品） name（名称） / id（标识） 查询、recipe（配方） result（产出） 查询、未命中返回空结果。
3. 单元测试证明输出为不可变快照，调用方修改返回对象不会污染后续查询结果。
4. `world-model/`（世界模型） 导出与根入口导出保持可用；既有 resource cluster（资源簇） 查询测试不回退。
5. 未触碰 LLM（大语言模型） / Prompt（提示词） / parser（解析器） / online entrypoint（在线入口装配） 时，不要求真实 OpenAI（开放人工智能）兼容 API（应用程序接口） 验收；如实际触碰，必须按长期规则补充真实 API（应用程序接口） 结果。
6. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-037`
- [ ] 仅读取并修改白名单内文件
- [ ] 除 `minecraft-data`（MC 事实包） 外未新增依赖
- [ ] 未在代码、Prompt（提示词） 或测试中复制 Minecraft（我的世界）事实表
- [ ] block（方块） / item（物品） / recipe（配方） 查询均来自 `minecraft-data`（MC 事实包） registry（注册表）
- [ ] 无效版本、未命中、不可变快照测试已覆盖
- [ ] 未触碰 LLM（大语言模型） / Prompt（提示词） / parser（解析器） / online entrypoint（在线入口装配）；若触碰，已回填真实 API（应用程序接口） 验收
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 回填）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-038**: BotActor（机器人执行代理） 脊髓反射动作硬编码，基于 observation（观测） 威胁等级进入 `REFLEXING`（反射中） 并执行最低风险避险动作。
- **T-039**: JAR（自定义服务端插件） 桥接通信落地；派发前必须先与用户确认 JAR（自定义服务端插件）端是否已具备发包能力。
- **T-040**: PostgreSQL（关系型数据库） / vector（向量） memory provider（记忆提供器） 最小真实读适配，承接 T-033（任务三十三） 与 T-036（任务三十六） 的端口。

---

### Phase 1（第一阶段） 必做项遗漏补登（2026-04-26 由用户审计后追加，Manager（管理代理） 排期前必读，禁止再次误删）

下列三项是 `01_ARCHITECTURE.md`（架构文档） 第 18 节 Phase 1（第一阶段） 必做表与第 12 / 4.2 / 2 节明确承诺、但截至当前批次仍需排期的盲区。Manager（管理代理） 在排定 `T-037`（任务三十七） 及之后任务前，必须先把它们纳入候选，不得再被新增对话能力优先级覆盖；本节由用户审计追加，Manager（管理代理） 不得在轮换批次时静默删除，如需重排请保留本节并显式更新候选编号。

- **T-缺-A（当前 T-037）：`minecraft-data`（MC 事实包） 集成**
  - 缺口现状：`world-model/`（世界模型） 模块壳完整，但 `package.json`（依赖清单） 与 `src/` 全仓均未引入 `minecraft-data`（MC 事实 npm 包）。文档第 12.1 节承诺的“MC 常识 = 本地确定性 API（应用程序接口）查询”事实上未通路；目前所有 MC（Minecraft，我的世界）事实仍依赖 LLM（大语言模型）回忆，存在幻觉风险。
  - 排期状态：已作为 T-037（任务三十七） 派发。

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
