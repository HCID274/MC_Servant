# 当前任务握手区

【任务序号】: T-025
【当前状态】: 进行中

---

## Manager 任务指令

**任务目标**:
在 `skills`（技能） + `runtime`（运行时） + `workers`（工作线程） + `conversation`（对话） 这一组主干模块内，把 Phase 1（第一阶段） 真实可执行技能面从单个 `goTo`（前往坐标） 扩到三项现有技能：`mine`（挖掘） / `collect`（捡拾） / `equip`（装备）。本轮目标不是上 `sandbox`（沙箱），而是让女仆在真实 MC（Minecraft，我的世界） 在线入口里，能通过自然语言被规划为这三类 `skill_call`（技能调用），并复用现有 `BotWorker`（机器人工作线程） / `BotActor`（机器人执行代理） 单写者链路执行。

**上下文说明**:
1. `T-021`（任务二十一） 已完成真实消息入队与在线聊天闭环。
2. `T-022`（任务二十二） 已完成 `goTo`（前往坐标） 最小真实执行链与 `world_ready`（世界交互就绪） 门控。
3. `T-023`（任务二十三） 已完成真实 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 闲聊闭环与在线 `cancel`（取消） 语义。
4. `T-024`（任务二十四） 已完成真实 `triage`（分诊） + 最小 `goTo`（前往坐标） `plan`（规划），并确认在线入口不暴露 `modify`（修改当前任务） 半通路。
5. 当前缺口在于：真实动作面仍几乎只有“移动到坐标”。如果不把现有 Phase 1（第一阶段） 技能目录里至少 2-3 个能力接到真实执行链，女仆虽然能“听懂并移动”，但演示面依然过窄。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》；第 3 节《消息流》；第 9 节《Phase 1 实施顺序》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 2 节《BotActor 状态机》；第 5 节《单写者执行边界》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 2 节《两阶段 LLM 调用模型》；第 5.1 节《输出格式选择：skill_call 优先》；第 5.6 节《skill_call 路径的 Prompt》；第 5.7 节《skill_call 输出解析》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/README.md` — 全文件（仅在需要补最小手测说明时允许更新）
7. `ts-core/.env.example` — 全文件（仅在需要补新增环境变量说明时允许更新）
8. `ts-core/src/skills/contracts.ts` — 全文件
9. `ts-core/src/skills/execution.ts` — 全文件
10. `ts-core/src/skills/index.ts` — 全文件
11. `ts-core/src/runtime/transport.ts` — 全文件
12. `ts-core/src/runtime/actor.ts` — 全文件
13. `ts-core/src/runtime/tasking.ts` — 全文件
14. `ts-core/src/workers/contracts.ts` — 全文件
15. `ts-core/src/workers/bot-worker.ts` — 全文件
16. `ts-core/src/workers/conversation-worker.ts` — 全文件
17. `ts-core/src/workers/index.ts` — 全文件
18. `ts-core/src/conversation/contracts.ts` — 全文件
19. `ts-core/src/conversation/llm.ts` — 全文件
20. `ts-core/src/conversation/planning.ts` — 全文件
21. `ts-core/src/app/entrypoint.ts` — 全文件（仅在需要补在线装配时允许更新）
22. `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts` — 全文件
23. `ts-core/src/__tests__/runtime-actor-model.spec.ts` — 全文件
24. `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts` — 全文件
25. `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts` — 全文件
26. `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts` — 全文件
27. `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts` — 全文件
28. `ts-core/src/__tests__/app-entrypoint-model.spec.ts` — 全文件

**核心逻辑要求**:

1. **真实执行技能扩到三项现有技能**:
   - 本轮只允许扩 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 三个现有 Phase 1（第一阶段） 技能；不得新增 `follow`（跟随） / `goToOwner`（前往主人） / `attack`（攻击） 等新技能名。
   - `skills/execution.ts`（技能执行边界） 不能再只放行 `goTo`（前往坐标）；必须把这三项现有技能接入真实执行分发，并保持强类型参数校验。
   - 任何真实动作仍只能经 `BotActor.executeSkill()`（机器人执行代理执行技能） 单写者入口进入 Mineflayer（Minecraft 协议客户端） 侧能力，不得旁路直连底层 Bot（机器人） 实例。

2. **自然语言规划扩到受限多技能 `skill_call`（技能调用）**:
   - `LLM`（大语言模型） `plan`（规划） 路径不再只允许 `goTo`（前往坐标），而是允许在 `goTo` / `mine` / `collect` / `equip` 四个现有技能中择一输出单个 `skill_call`（技能调用）。
   - 仍然只允许单个 `skill_call`（技能调用）；不得引入 `sandbox_code`（沙箱代码）、多步编排或代码生成。
   - 规划结果必须做强校验：技能名必须在允许集合内，参数必须与 `skills/contracts.ts`（技能契约） 一一对齐；非法产物只允许按“规划失败”处理，不得伪装成闲聊成功。

3. **三项技能的最小在线语义必须可演示**:
   - `mine`（挖掘）：至少支持“挖某种方块 N 个”的最小真实执行语义，失败必须显式抛错，不得静默成功。
   - `collect`（捡拾）：至少支持“捡某种掉落物”的最小真实执行语义，允许先做近距离 / 单目标版本，但不能是纯占位。
   - `equip`（装备）：至少支持“把某物装备到手上或指定槽位”的最小真实执行语义，非法槽位或物品缺失必须显式失败。
   - 若底层能力暂时只能做到收窄版本，允许做“最小必要收窄”，但必须在测试与手测说明里明确边界。

4. **对话与执行链路必须一起升级**:
   - `ConversationWorker`（对话工作线程） 规划成功后仍必须复用 `createExecJobFromPlan()`（由规划产物创建执行任务） / `bot:{botId}:exec`（执行队列） / `BotWorker`（机器人工作线程） 链路，不新增任何技能旁路。
   - `BotWorker`（机器人工作线程） 的生命周期事件不能退化；新技能至少要保持 accepted（已接收） / started（已开始） / completed（已完成） / failed（已失败） 语义一致。
   - `cancel`（取消） 与 `chat`（闲聊） 路径不得被本轮技能扩展打坏。

5. **范围边界**:
   - 本任务不引入 `sandbox`（沙箱） / `isolated-vm`（隔离虚拟机）。
   - 本任务不接 `cutTree`（砍树）；该技能依赖更高层资源流程，留到后续再评估。
   - 本任务不新增调试写接口，不改 EasyAuth（离线服认证模组） 数据源，不扩状态 / 回放接口。

**验收标准**:

1. 自动化测试证明 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 已进入真实技能执行分发边界，且参数强校验生效。
2. 至少三条自然语言消息可分别被真实 LLM（大语言模型） 规划为 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 的单个 `skill_call`（技能调用），并进入现有执行队列。
3. 规划失败或非法技能输出不会入执行队列，只会返回明确失败回执。
4. `chat`（闲聊） / `cancel`（取消） / 已有 `goTo`（前往坐标） 路径在本轮后仍保持通过。
5. `bash ts-core/scripts/pre_review.sh` 全部通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-025`
- [ ] 仅读取并修改白名单内文件
- [ ] `mine`（挖掘） / `collect`（捡拾） / `equip`（装备） 已进入真实技能执行边界
- [ ] 真实 LLM（大语言模型） `plan`（规划） 已扩到 `goTo` / `mine` / `collect` / `equip` 单技能输出
- [ ] 规划失败或非法产物不会入执行队列
- [ ] `chat`（闲聊） / `cancel`（取消） / 已有 `goTo`（前往坐标） 路径未回归
- [ ] 未引入 `sandbox_code`（沙箱代码） / `isolated-vm`（隔离虚拟机） / 新调试写入口
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

**回填序号**: `T-025`

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

- **T-026**: 在 `interfaces`（接口边界） + `diagnostics`（诊断） + `app`（应用装配） 内补齐状态读取、事件顺序回放与最近一次 `LLM`（大语言模型） 调用摘要查看，支撑真实 MC（Minecraft，我的世界） 手测复核。
- **T-027（可选 / MVP 后置）**: 在 `sandbox`（沙箱） + `runtime`（运行时） 内接入 `isolated-vm`（隔离虚拟机） 真实执行与 Facade API（门面接口） 桥接；优先评估“渐进披露 + LRU（最近最少使用） 热队列”而不是一次性全量 Facade（门面接口） 上下文。
- **T-028**: 在 `brain`（摘要工作线程） + `data`（数据层） + `conversation`（对话） 内补齐任务摘要沉淀与可检索记忆，为后续复杂任务与沙箱经验蒸馏做准备。
