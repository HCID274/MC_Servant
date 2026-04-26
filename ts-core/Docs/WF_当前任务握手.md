# 当前任务握手区

【任务序号】: T-027
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**:
在 `sandbox`（沙箱） + `runtime`（运行时） + `workers`（工作线程） 这一组执行主干模块内，接入最小真实 `sandbox_code`（沙箱代码） 执行链：`BotWorker`（机器人工作线程） 能消费 `sandbox_code`（沙箱代码） 任务，交给 `BotActor`（机器人执行代理） 在 `isolated-vm`（隔离虚拟机） 中执行 TypeScript（类型脚本） 代码，沙箱内只能通过 Facade API（门面接口） 请求 BotActor（机器人执行代理） 执行动作或发送聊天。本轮同时把“渐进披露 + LRU（最近最少使用）热队列”的上下文治理做成最小纯契约 / 纯函数，避免后续重新回到“一次性把全量 Facade（门面接口） 手册塞进 prompt（提示词）”的旧模式。

**上下文说明**:
1. `T-021`（任务二十一） 到 `T-026`（任务二十六） 已完成真实 MC（Minecraft，我的世界） 在线聊天、真实 `goTo`（前往坐标） / `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 技能、OpenAI（开放人工智能） 兼容 `LLM`（大语言模型） 闲聊 / 分诊 / 规划，以及 `status`（状态） / `replay`（事件回放） / 最近 `LLM`（大语言模型） 摘要观测出口。
2. 当前 `conversation`（对话） 层已有 `ConversationSandboxCodePlanDraft`（沙箱代码规划草案） 与 `createSandboxCodeJob()`（创建沙箱代码任务） 契约，但真实执行链目前仍没有 `isolated-vm`（隔离虚拟机） 执行器。
3. 本轮不要求 `LLM`（大语言模型） 自动生成 `sandbox_code`（沙箱代码） prompt（提示词） 并上线使用；可以通过测试直接注入 `SandboxCodeJob`（沙箱代码任务） 验证真实执行链。是否让线上 planner（规划器） 产出 `sandbox_code`（沙箱代码） 留到后续复合输出 / 上下文治理任务。
4. 需求变更索引已明确：启动 sandbox（沙箱） 前必须评估“渐进披露 + LRU（最近最少使用）热队列”，不得默认沿用旧的全量 Facade（门面接口） 手册一次性注入方式。本轮至少要沉淀可测试的 Facade（门面接口） 目录索引、按命名空间展开描述、LRU（最近最少使用）热队列预算裁剪。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《三队列异步架构》；第 7 节《TS 代码沙箱》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 3.4 节《EXECUTING 状态的中断序列》；第 5.2 节《任务执行主流程》；第 5.3 节《两种 Job 类型》；第 5.5 节《执行超时》
3. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 2 节《技术选型：isolated-vm》；第 3 节《代码转译流程》；第 4 节《Facade API 完整类型定义》；第 5 节《Facade API 注入机制》；第 6 节《安全边界》；第 7 节《超时与生命周期管理》；第 8 节《LLM 代码生成约束》；第 9 节《步骤结果收集》；第 10 节《skill_call 与 sandbox_code 的统一抽象》
4. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 5 节《Stage 2-Plan: 任务规划》；第 6 节《上下文预算管理》
5. `ts-core/Docs/05_DATA_SPEC.md` — 第 4.3 节《沙箱执行日志格式》；第 4.4 节《LLM I/O 日志格式》
6. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
7. `ts-core/scripts/pre_review.sh` — 全文件
8. `ts-core/package.json` — 全文件（仅允许新增沙箱执行所需依赖，如 `isolated-vm`（隔离虚拟机） / `esbuild`（转译器））
9. `ts-core/pnpm-lock.yaml` — 全文件（仅随依赖安装更新）
10. `ts-core/src/sandbox/contracts.ts` — 全文件
11. `ts-core/src/sandbox/execution.ts` — 全文件
12. `ts-core/src/sandbox/facade.ts` — 全文件
13. `ts-core/src/sandbox/index.ts` — 全文件
14. `ts-core/src/runtime/actor.ts` — 全文件
15. `ts-core/src/runtime/tasking.ts` — 全文件
16. `ts-core/src/runtime/events.ts` — 全文件（仅允许补沙箱执行事件映射或复用既有事件）
17. `ts-core/src/runtime/index.ts` — 全文件
18. `ts-core/src/workers/bot-worker.ts` — 全文件
19. `ts-core/src/workers/contracts.ts` — 全文件
20. `ts-core/src/workers/index.ts` — 全文件
21. `ts-core/src/skills/contracts.ts` — 全文件（仅用于复用技能参数类型，不允许改技能语义）
22. `ts-core/src/skills/execution.ts` — 全文件（仅用于复用技能执行边界，不允许改现有技能行为）
23. `ts-core/src/skills/index.ts` — 全文件
24. `ts-core/src/diagnostics/contracts.ts` — 全文件（仅允许补沙箱日志行所需字段）
25. `ts-core/src/diagnostics/logs.ts` — 全文件（仅允许补沙箱日志工厂 / 引用校验）
26. `ts-core/src/diagnostics/index.ts` — 全文件
27. `ts-core/src/conversation/contracts.ts` — 全文件（只读参考，除非 sandbox_code 现有类型无法编译）
28. `ts-core/src/conversation/planning.ts` — 全文件（只读参考，除非 sandbox_code 现有转换无法编译）
29. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件
30. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 全文件
31. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件
32. `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts` — 全文件（仅回归既有 skill_call）
33. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件（仅回归 sandbox_code 入队契约，如必须）
34. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件（只读参考；本轮不要求修改 LLM prompt 语义）

**核心逻辑要求**:

1. **真实 `sandbox_code`（沙箱代码） 执行链必须收口在 BotActor（机器人执行代理） 单写者内**:
   - `BotWorker`（机器人工作线程） 遇到 `SandboxCodeJob`（沙箱代码任务） 时，不能再直接报“不支持”；必须交给 `BotActor`（机器人执行代理） 的受控入口执行。
   - `BotActor`（机器人执行代理） 需要提供与 `executeSkill()`（执行技能） 并列的受控执行能力，例如 `executeSandboxCode()`（执行沙箱代码）。它必须复用 ready gate（就绪门控）、`world_ready`（世界交互就绪）、状态机 `EXECUTING`（执行中） / terminal（终态） 流转与失败回滚。
   - 沙箱内的 `api.bot.*`（机器人动作） 与 `api.chat.*`（聊天动作） 不能绕过 BotActor（机器人执行代理），也不能拿到底层 Mineflayer（Minecraft 协议客户端） Bot 句柄。
   - 沙箱内 `api.bot.goTo` / `mine` / `collect` / `equip` 至少要复用已实现的真实技能执行边界；`cutTree`（砍树） 若当前技能目录未真实支持，可在 Facade（门面接口） 中显式拒绝为 `FacadeCallError`（门面调用错误），不得伪成功。

2. **沙箱安全边界必须真实存在，而不是只做类型占位**:
   - 引入 `isolated-vm`（隔离虚拟机） 与 `esbuild`（转译器） 时必须通过 `package.json` / `pnpm-lock.yaml` 管理依赖。
   - 执行管线至少包含：静态预检禁止 `import` / `require` / `process` / `globalThis` / `eval` / `Function` / 文件系统或网络相关入口；`esbuild.transform()`（转译） TypeScript（类型脚本）；`isolated-vm`（隔离虚拟机） 创建 isolate/context；执行结束或失败后 dispose（释放） isolate。
   - 资源限制必须使用现有 `SandboxExecutionResourceLimits`（沙箱执行资源限制），至少覆盖 `memory_limit_mb`（内存上限）、`timeout_ms`（总超时）、`script_timeout_ms`（脚本超时）、`max_sleep_ms`（单次睡眠上限）、`abort_cleanup_timeout_ms`（中断清理超时）。
   - 静态预检失败、转译失败、脚本超时、Facade（门面接口） 调用失败、未捕获异常必须形成结构化 `SandboxExecutionError`（沙箱执行错误） 与失败结果，不能吞错或伪装成功。

3. **Facade API（门面接口） 要最小可执行、可审计、按读写边界分层**:
   - 本轮可执行最小集：`api.bot.goTo()`、`api.bot.mine()`、`api.bot.collect()`、`api.bot.equip()`、`api.chat.say()`、`api.chat.report()`。
   - 只读最小集：`api.task.id`、`api.task.userMessage`、`api.task.intent`；`api.owner.position`（主人位置） 若当前 observation（观测） 只读投影无法稳定实时提供，可先不暴露，或暴露为显式不可用错误，但不能提供冻结的假实时值。
   - 每个写方法完成后必须产出 `SandboxStepResult`（沙箱步骤结果） 或等价步骤记录；只读查询不产出步骤。
   - `chat.say()` / `chat.report()` 最终必须走 BotActor（机器人执行代理） 的受控聊天写入，不得直接调用 transport（传输层）。

4. **渐进披露 + LRU（最近最少使用）热队列必须落为可测试契约**:
   - 在 `sandbox`（沙箱） 模块中提供最小 Facade（门面接口） 上下文目录：初始 prompt（提示词） 只暴露命名空间索引和 `describe(namespace)`（描述命名空间） 方式，不暴露全量 API 手册。
   - 提供 `describeFacadeNamespace()`（描述门面命名空间） 或同等函数，可按 `bot` / `chat` / `world` / `task` 等命名空间返回压缩签名文本。
   - 提供有界 LRU（最近最少使用） 热队列纯函数或小型类，按 token（文本配额） 预算裁剪，而不是按条数裁剪；测试要覆盖重复访问刷新热度、超预算淘汰最旧 namespace（命名空间）、空队列与非法预算。
   - 本轮不要求把该 LRU（最近最少使用） 热队列接入真实 LLM（大语言模型） planner（规划器），但 API（应用程序接口） 形态必须能被后续 `conversation`（对话） 层直接调用。

5. **现有真实技能与观测出口不得回归**:
   - `skill_call`（技能调用） 路径的 `goTo` / `mine` / `collect` / `equip` 行为不能因接入 sandbox（沙箱） 改变。
   - `/api/status`（状态接口）、`/api/replay`（事件回放接口）、`chat`（闲聊）、`cancel`（取消） 不属于本轮修改目标，除非测试发现编译适配必须微调。
   - 本轮不新增网页 UI（用户界面）、不新增数据库 migration（迁移）、不引入 Minecraft（我的世界） 事实 JSON（结构化数据） 知识库。

**验收标准**:

1. 注入一个 `SandboxCodeJob`（沙箱代码任务） 后，`BotWorker`（机器人工作线程） 能通过 `BotActor`（机器人执行代理） 执行最小代码，例如 `await api.chat.say("...")` 或 `await api.bot.goTo(1, 64, 1)`，并产出 started（已开始） / completed（已完成） 或 failed（已失败） 生命周期事件。
2. 静态预检、转译失败、脚本超时、Facade（门面接口） 调用失败至少各有一个自动化测试覆盖；失败不得伪成功，错误名必须落在 `SandboxExecutionError`（沙箱执行错误） 契约内。
3. 沙箱执行期间不暴露 `process`（进程对象）、`require`（模块加载）、`import`（导入）、文件系统、网络、底层 Mineflayer（Minecraft 协议客户端） Bot 句柄；测试中尝试访问这些能力必须失败。
4. Facade（门面接口） 渐进披露与 LRU（最近最少使用） 热队列有纯函数 / 契约测试，证明不会默认输出全量 Facade（门面接口） 手册，且能按 namespace（命名空间） 与 token（文本配额） 预算裁剪。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-027`
- [ ] 仅读取并修改白名单内文件
- [ ] `sandbox_code`（沙箱代码） 真实执行链只通过 `BotActor`（机器人执行代理） 单写者入口，不绕过到 Mineflayer（Minecraft 协议客户端） 句柄
- [ ] 静态预检、转译、`isolated-vm`（隔离虚拟机） 执行、超时、dispose（释放） 与结构化错误全部有测试覆盖
- [ ] Facade API（门面接口） 写动作能产出步骤记录；只读查询不产出步骤
- [ ] 渐进披露 + LRU（最近最少使用） 热队列按 namespace（命名空间） 与 token（文本配额） 预算测试通过
- [ ] 既有 `skill_call`（技能调用）、`chat`（闲聊）、`cancel`（取消）、`status`（状态）、`replay`（事件回放） 路径不回归
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-028**: 在 `conversation`（对话） + `runtime`（运行时） + `diagnostics`（诊断） 内补 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，让女仆执行任务时能回答“我正在做什么”。
- **T-029**: 在 `conversation`（对话） 内把 triage（分诊） 输出从单 intent（意图） 升级为 composite output（复合输出），支持 cancel（取消） + reply（回复） + action（动作） 的有序派发。
- **T-030**: 在 `brain`（摘要工作线程） + `data`（数据层） + `conversation`（对话） 内补齐任务摘要沉淀与可检索记忆，为复杂任务与 sandbox（沙箱） 经验蒸馏做准备。
