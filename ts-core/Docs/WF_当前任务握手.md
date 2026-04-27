# 当前任务握手区

【任务序号】: T-045
【当前状态】: 待开发

---

## 任务目标

T-045（任务四十五） 是 Phase 1（第一阶段）基础动作模块的一次性批量收口任务：在 T-044（任务四十四）已经打通 `/svs`（服务端女仆命令）到 conversation（对话）闲聊回复的基础上，把 `/svs` 自然语言任务、LLM（大语言模型） planner（规划器）、ConversationWorker（对话工作线程）、BotWorker（机器人工作线程）、BotActor（机器人执行代理）和 runtime skills（运行时技能）收成一个可实服验证的动作闭环。

本轮不再按单技能拆任务。`goTo`（前往坐标）、`collect`（捡拾）、`mine`（挖掘）、`equip`（装备）必须在同一轮完成到可测试口径；`cutTree`（砍树）若能复用 `mine`（挖掘）/ `collect`（捡拾）能力则一并纳入，若无法低风险完成，必须留下明确不可纳入原因和后续最小缺口。目标是让用户在真实 MC（Minecraft，我的世界）服务器里能用 `/svs` 触发几类基础动作，而不是继续只验证聊天。

---

## 上下文说明

- 用户已明确长期准则：必须降低握手成本。同一模块、同一上下文、同一目标闭环内的相关工作应一次性批量派发，不能拆成大量单步骤小任务。
- T-044（任务四十四） 已完成 `SERVER_BRIDGE_CONVERSATION_ENABLED=true`（服务端桥接对话启用） 后 `player_message`（玩家消息）入 `msg:{botId}`（消息队列）、ConversationWorker（对话工作线程）生成 LLM（大语言模型）闲聊回复、BotActor（机器人执行代理）写回 MC（Minecraft，我的世界）聊天。
- 现有动作链路已有 planner（规划器）、exec queue（执行队列）、BotWorker（机器人工作线程）、BotActor（机器人执行代理）和 Mineflayer transport（Minecraft 协议客户端传输）骨架；本任务不是重写架构，而是把基础动作面一次性打到可测。
- 本任务触碰 LLM（大语言模型）规划 / Prompt（提示词） / parser（解析器） / 对话路由 / 在线入口装配，必须做真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；mock（模拟）测试不能替代真实调用。
- 如 Coder（编码代理）环境不能进入真实 MC（Minecraft，我的世界）服务器，必须回填最短人工手测步骤；Manager（管理代理）审查代码后会等待用户手测回报，再最终通过或打回。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/WF_需求变更索引.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 1 节、第 3.1 节、第 3.2 节、第 8 节、第 9 节、第 10 节
- `ts-core/Docs/02_RUNTIME_SPEC.md` 第 1 节、第 2 节、第 3 节、第 5 节
- `ts-core/Docs/04_CONVERSATION_SPEC.md` 第 1 节、第 2 节、第 3 节、第 5 节
- `ts-core/Docs/09_AGENT_WORKFLOW.md` 第 2 节、第 3 节、第 4 节
- `ts-core/src/conversation/**`
- `ts-core/src/workers/contracts.ts`
- `ts-core/src/workers/queues.ts`
- `ts-core/src/workers/bot-worker.ts`
- `ts-core/src/workers/conversation-worker/**`
- `ts-core/src/runtime/actor.ts`
- `ts-core/src/runtime/transport.ts`
- `ts-core/src/skills/**`
- `ts-core/src/core-ports/**`
- `ts-core/src/interfaces/server-bridge/**`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/main.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/src/conversation/**`
- `ts-core/src/workers/conversation-worker/**`
- `ts-core/src/workers/bot-worker.ts`
- `ts-core/src/workers/contracts.ts`
- `ts-core/src/runtime/actor.ts`（仅限执行诊断、状态门控或中断语义的最小必要修复）
- `ts-core/src/runtime/transport.ts`
- `ts-core/src/skills/**`
- `ts-core/src/core-ports/**`（仅限技能类型 / 执行端口补齐，不得引入反向依赖）
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `plugin/src/main/java/**`（本任务不改 Fabric mod（Fabric 模组）代码）
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`
- `ts-core/src/db/**`
- `ts-core/src/observation/**`
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. 动作入口必须复用 T-044（任务四十四）的主链路：
   - `/svs`（服务端女仆命令）动作消息仍由 `SERVER_BRIDGE_CONVERSATION_ENABLED=true`（服务端桥接对话启用）显式开启。
   - `player_message`（玩家消息）进入 `msg:{botId}`（消息队列）后，由 ConversationWorker（对话工作线程）统一 triage（分诊）和 planner（规划）；不得在 Server Bridge（服务端桥接）层写特殊动作分支。
   - `jobId`（任务标识）仍使用 `message_id`（消息标识），重复消息不得重复执行。
2. 基础技能面必须同轮批量收口：
   - `goTo`（前往坐标）：自然语言坐标或相对位置描述能生成可执行 skill call（技能调用），并通过 BotActor（机器人执行代理）单写者移动。
   - `collect`（捡拾）：只能以背包内目标物品数量增长作为成功条件，不得把目标实体消失误判为成功。
   - `mine`（挖掘）：不得写死 Minecraft（我的世界）方块事实；目标识别应依赖输入标准 id（标识）/ runtime（运行时）/ minecraft-data（Minecraft 数据源）已有能力，无法确认时明确失败。
   - `equip`（装备）：只能从现有背包选择物品并通过 BotActor（机器人执行代理）执行；找不到物品必须明确失败。
   - `cutTree`（砍树）：优先复用已有 `mine`（挖掘）/ `collect`（捡拾）能力做最小版本；如需要额外领域事实或复杂树识别，本轮可以不落地，但必须在反馈中说明。
3. planner（规划器）与 Prompt（提示词）必须保持可控：
   - 真实 OpenAI（开放人工智能）兼容 API（应用程序接口）必须能从中文 `/svs` 自然语言产出上述技能调用。
   - 不得在 Prompt（提示词）或代码中写死 Minecraft（我的世界）配方、掉落、工具等级、方块组等事实。
   - task（任务）规划失败时必须给模板失败回执或明确失败诊断，不得伪装成已执行。
4. 执行路径必须保持 BotActor（机器人执行代理）单写者：
   - ConversationWorker（对话工作线程）只负责生成 `ExecJob`（执行任务）并入 `bot:{botId}:exec`（机器人执行队列）。
   - BotWorker（机器人工作线程）只通过 BotActor（机器人执行代理）执行，不得直接调用 Mineflayer（Minecraft 协议客户端）物理动作。
   - 执行成功、失败、被中断都必须有 replay（补拉）可观察诊断；不能只在测试内吞掉错误。
5. 回复、cancel（取消）和并发语义不得回退：
   - 普通 chat（闲聊）仍走 T-044（任务四十四）真实 LLM（大语言模型）回复路径。
   - 显式 cancel（取消）仍走规则分诊和中断，不调用 LLM（大语言模型）规划，不应生成动作任务。
   - BotActor（机器人执行代理）忙碌、未 ready（就绪）、外部认证未完成、world（世界）未 ready（就绪）时，动作必须显式失败或排队，不得伪装成功。
6. 实测与验收必须分三层：
   - mock（模拟）测试覆盖确定性路由、入队、单写者、失败分支和 cancel（取消）。
   - 真实 LLM（大语言模型）调用覆盖 planner（规划器）输出，默认 `LLM_BASE_URL=http://127.0.0.1:8045/v1`、`LLM_API_KEY=sk-local-dev`、`LLM_MODEL=bl-auto`。
   - 真实 MC（Minecraft，我的世界）烟测如 Coder（编码代理）不能执行，必须给用户可复制的最短步骤、输入命令和预期 replay（补拉）事件序列。

---

## 验收标准

1. `/svs 去到 <x> <y> <z>` 或等价中文自然语言会经真实 planner（规划器）产出 `goTo`（前往坐标）任务，进入 `bot:{botId}:exec`（机器人执行队列），并由 BotWorker（机器人工作线程）调用 BotActor（机器人执行代理）执行。
2. `collect`（捡拾）、`mine`（挖掘）、`equip`（装备）均有在线链路或 runtime（运行时）级回归测试；若 `cutTree`（砍树）未纳入，反馈区必须说明阻塞原因和最小后续缺口。
3. replay（补拉）至少能看到 `server_bridge.player_message`（服务端桥接玩家消息）、`task.accepted`（任务已接受）、`task.started`（任务已开始）和终态诊断；失败分支必须包含可读错误摘要。
4. cancel（取消）路径回归测试通过：显式取消不调用 LLM（大语言模型）规划，不入 `bot:{botId}:exec`（机器人执行队列），仍发中断和模板回执。
5. 真实 OpenAI（开放人工智能）兼容 API（应用程序接口） planner（规划器）调用成功；真实 MC（Minecraft，我的世界）烟测已由 Coder（编码代理）执行并记录结果，或已给出用户可执行手测步骤并等待用户回报；`bash ts-core/scripts/pre_review.sh` 必须全部通过。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-045（任务四十五），且 T-044（任务四十四）已完成。
- [ ] 已确认本任务按基础动作模块批量完成，没有拆成单技能 / 单函数 / 单步骤小任务。
- [ ] 已确认未修改 `plugin/src/main/java/**`、`backend/**`、`data`（数据层）、`db`（数据库）、`sandbox`（沙箱）或 `observation`（观测）目录。
- [ ] 已保留 T-044（任务四十四）未启用时 observe-only（仅观测）行为、普通 chat（闲聊）回复行为和 cancel（取消）中断行为。
- [ ] 已锁定 BotActor（机器人执行代理）单写者路径，没有在 interfaces（接口层）或 workers（工作线程）中直接写 Mineflayer（Minecraft 协议客户端）动作。
- [ ] 已记录真实 LLM（大语言模型） planner（规划器）调用命令、输入摘要、关键输出与判断；若不能实服烟测，已提供最短手测步骤。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-046**: interface（接口）与 light panel（轻面板）模块一次性收口：网页消息、状态、replay（补拉）、WebSocket（全双工通信协议）推送和最小 UI（用户界面）放在同一任务，不拆成接口/页面/推送小任务。
- **T-047**: deployment（部署）与 runbook（运行手册）模块一次性收口：Docker（容器）、本地启动脚本、环境变量模板、MC（Minecraft，我的世界）实服回归清单和故障诊断合并完成。
- **T-048**: sandbox（沙箱）模块重启评估与最小落地：基于 T-045（任务四十五）实服动作结果，决定是否恢复 `isolated-vm`（隔离虚拟机）多步脚本链路，并优先评估渐进披露与热队列方案。
