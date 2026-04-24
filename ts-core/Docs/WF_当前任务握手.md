# 当前任务握手区

【任务序号】: T-024
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**:
在 `conversation`（对话） + `workers`（工作线程） + `app`（应用装配） 这一组主干模块内，把真实 OpenAI（开放人工智能） 兼容 LLM（大语言模型） 从“只会闲聊回包”扩到**轻量分诊 + 最小任务规划**：启动 `pnpm start`（启动命令） 后，普通闲聊继续走真实 LLM（大语言模型） 聊天回复；而带明确坐标的自然语言移动指令，必须能经真实 LLM（大语言模型） 规划为 `skill_call`（技能调用） `goTo`（前往坐标），进入 `bot:{botId}:exec`（执行队列） 并复用现有 `BotWorker`（机器人工作线程） / `BotActor`（机器人执行代理） 真实执行链。

本任务仍然坚持最小可演示闭环：只要求把“闲聊 / 取消 / 带坐标的自然语言移动”三类消息拉到真实 LLM（大语言模型） 路径，不引入 `sandbox_code`（沙箱代码） 生成，不扩到多技能编排。

**上下文说明**:
1. `T-021`（任务二十一） 已完成真实在线聊天闭环，消息可进入 `msg:{botId}`（消息队列） 并写回 MC（Minecraft，我的世界） 聊天。
2. `T-022`（任务二十二） 已完成确定性 `goTo`（前往坐标） 最小真实执行链，`BotWorker`（机器人工作线程） 可消费执行队列并驱动真实移动。
3. `T-023`（任务二十三） 已完成真实 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 闲聊闭环，并补齐在线 `cancel`（取消） 的中断 + 模板回执语义。
4. 当前缺口在于：真实 LLM（大语言模型） 仍只用于闲聊文本回包，没有真正参与 `triage`（分诊） / `plan`（规划）；自然语言任务仍只支持窄格式正则 `goTo`（前往坐标） 命令。
5. 当前队列已按“女仆最快上线”重排，本任务优先级高于观测 / 回放与 `sandbox`（沙箱），目标是尽快让女仆达到“能听懂简单自然语言并动起来”的可演示门槛。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《消息流》
2. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》；第 2 节《两阶段 LLM 调用模型》；第 3 节《Stage 1: Triage Prompt 设计》；第 5 节《Stage 2-Plan: 任务规划》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/README.md` — 全文件（仅在需要补最小手测说明时允许更新）
6. `ts-core/.env.example` — 全文件（仅在需要补新增环境变量说明时允许更新）
7. `ts-core/src/conversation/contracts.ts` — 全文件
8. `ts-core/src/conversation/chat.ts` — 全文件
9. `ts-core/src/conversation/triage.ts` — 全文件
10. `ts-core/src/conversation/planning.ts` — 全文件
11. `ts-core/src/conversation/llm.ts` — 全文件
12. `ts-core/src/conversation/index.ts` — 全文件
13. `ts-core/src/workers/contracts.ts` — 全文件
14. `ts-core/src/workers/conversation-worker.ts` — 全文件
15. `ts-core/src/workers/bot-worker.ts` — 全文件
16. `ts-core/src/workers/index.ts` — 全文件
17. `ts-core/src/runtime/tasking.ts` — 全文件
18. `ts-core/src/skills/contracts.ts` — 全文件
19. `ts-core/src/skills/index.ts` — 全文件
20. `ts-core/src/app/bootstrap.ts` — 全文件
21. `ts-core/src/app/entrypoint.ts` — 全文件
22. `ts-core/src/app/index.ts` — 全文件
23. `ts-core/src/main.ts` — 全文件
24. `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts` — 全文件
25. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
26. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件
27. `ts-core/src/__tests__/interfaces-message-queue-model.spec.ts` — 全文件
28. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:

1. **真实 LLM（大语言模型） 进入分诊阶段**:
   - 不能再只把 LLM（大语言模型） 用作闲聊文本生成器；必须新增最小 `triage`（分诊） 调用，让在线路径能区分至少三类语义：
     - `chat`（闲聊）
     - `task`（任务）
     - `cancel`（取消）
   - `cancel`（取消） 仍优先保留现有显式规则命中与模板中断语义，不允许因为接入 LLM（大语言模型） 而退化。
   - 若 `triage`（分诊） 输出非法或无法解析，必须安全回退为 `chat/normal`（闲聊 / 普通），不得把闲聊误判成中断或任务。

2. **最小任务规划只落到 `goTo`（前往坐标）**:
   - 本轮真实 `plan`（规划） 只允许生成 `skill_call`（技能调用） `goTo`（前往坐标）；不得冒进到 `sandbox_code`（沙箱代码） 或其他尚未完成真实执行链的技能。
   - 允许支持的自然语言范围应至少覆盖“非正则窄格式、但含明确坐标”的移动指令，例如：
     - “帮我走到 10 64 -5”
     - “请去坐标 x=10 y=64 z=-5”
     - “去 10, 64, -5 那里”
   - 规划成功后必须复用现有 `createExecJobFromPlan()`（由规划产物创建执行任务） / `bot:{botId}:exec`（执行队列） / `BotWorker`（机器人工作线程） / `BotActor.executeSkill()`（机器人执行代理执行技能） 真实路径，不新增旁路执行入口。

3. **聊天、取消、任务三条路径必须同时成立**:
   - 普通闲聊继续走 `chat.completions`（对话补全） 回复文本，并保留 `T-023`（任务二十三） 的最小诊断留痕。
   - `cancel`（取消） 继续保持“中断 + 模板回执”，不得触发闲聊 LLM（大语言模型） 回复。
   - 带明确坐标的自然语言任务必须走“LLM 分诊 → LLM 规划 → 执行队列 → 真实移动”，而不是退回模板聊天或继续依赖旧正则快路径。

4. **失败处置必须显式且安全**:
   - `triage`（分诊） 失败：安全回退 `chat/normal`（闲聊 / 普通）。
   - `plan`（规划） 失败或产物非法：不得入执行队列；必须向用户返回一条明确的模板失败回执，说明当前未能规划该任务。
   - 不允许把失败的任务规划伪装成成功闲聊回复，也不允许生成弱类型、未校验的 `skill_call`（技能调用） 载荷。

5. **范围边界**:
   - 本任务不引入 `sandbox_code`（沙箱代码） 执行，不接 `isolated-vm`（隔离虚拟机）。
   - 本任务不扩到 `mine`（挖掘） / `cutTree`（砍树） / `collect`（捡拾） / `equip`（装备） 等新增真实执行技能；这些留给 `T-025`（任务二十五）。
   - 本任务不新增调试写接口，不改 EasyAuth（离线服认证模组） 数据源，不扩观测 / 回放接口。

**验收标准**:

1. 在线运行后，普通闲聊消息仍会走真实 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 并写回 MC（Minecraft，我的世界） 聊天。
2. 至少一种非正则窄格式、但含明确坐标的自然语言移动消息，可被真实 LLM（大语言模型） 规划为 `goTo`（前往坐标） `skill_call`（技能调用） 并进入真实执行队列。
3. `cancel`（取消） 在线真实路径仍然不触发闲聊 LLM（大语言模型） 回复，并继续发送中断信号与模板回执。
4. 自动化测试覆盖：
   - `triage`（分诊） 请求与解析
   - `plan`（规划） 请求与 `goTo`（前往坐标） 载荷校验
   - 规划失败不入队、只回失败回执
   - 在线装配时三条路径都真实接线
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-024`
- [ ] 仅读取并修改白名单内文件
- [ ] 真实 LLM（大语言模型） 已进入 `triage`（分诊） 与最小 `plan`（规划） 路径
- [ ] 自然语言 `goTo`（前往坐标） 已复用现有执行队列与 `BotActor`（机器人执行代理） 真实执行链
- [ ] `cancel`（取消） 仍保持中断 + 模板回执，不会误走闲聊 LLM（大语言模型）
- [ ] `plan`（规划） 失败不会入执行队列，且会返回明确失败回执
- [ ] 未引入 `sandbox_code`（沙箱代码） / `isolated-vm`（隔离虚拟机） / 新调试写入口
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

**回填序号**: `T-024`

**修改文件**:
- （待填写）

**执行摘要**:
- （待填写）

**预检输出摘要**:
- （待填写）

**遗留疑问**:
- （待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-025**: 在 `skills`（技能） + `runtime`（运行时） + `workers`（工作线程） 内补齐 2-3 个真实可执行技能（例如 `follow`（跟随） / `comeHere`（过来） / `sayHi`（打招呼）），全部复用 `BotActor.executeSkill`（机器人执行代理执行技能） 单写者路径，不引入 `isolated-vm`（隔离虚拟机） 沙箱。
- **T-026**: 在 `interfaces`（接口边界） + `diagnostics`（诊断） + `app`（应用装配） 内补齐状态读取、事件顺序回放与最近一次 LLM（大语言模型） 调用摘要查看，支撑真实 MC（Minecraft，我的世界） 手测复核。
- **T-027（可选 / MVP 后置）**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 `isolated-vm`（隔离虚拟机） 真实执行与 Facade API（门面接口） 桥接；仅当“多技能 + LLM（大语言模型） 选技能”被证明仍不足以覆盖实际场景时才推进。
