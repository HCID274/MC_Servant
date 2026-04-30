# 当前任务握手区

【任务序号】: T-046
【当前状态】: 待开发

---

## 任务目标

T-046（任务四十六） 是 `collect`（捡拾）单技能独立验收与接入前验证任务：在 T-045（任务四十五） 已允许 `goTo`（前往坐标） 在线执行的基础上，先创建并验证一个独立 `collect`（捡拾） probe（探针） 文件，再在**同一任务序号**内把 `collect`（捡拾） 以最小必要改动接入 `/svs`（服务端女仆命令）→ planner（规划器）→ ConversationWorker（对话工作线程）→ BotWorker（机器人工作线程）→ BotActor（机器人执行代理） 主链路。

本轮新增的唯一在线技能是 `collect`（捡拾）；`goTo`（前往坐标） 作为既有已通过技能必须保持可用，`mine`（挖掘） / `equip`（装备） / `cutTree`（砍树） 仍不得放行。

---

## 上下文说明

- 用户已确认长期规则：`skill`（技能） 继续保持单技能独立任务；并且每个 `skill`（技能） 任务都必须先做独立 probe（探针） 验证，再在**同一任务**内并入主程序。
- T-045（任务四十五） 已完成 `goTo`（前往坐标） 单技能验收，当前在线允许技能基线为 `goTo`（前往坐标） 单技能。
- 本任务要新增 `collect`（捡拾） 的 probe（探针） 与主程序接入，但不能把 `mine`（挖掘） / `equip`（装备） / `cutTree`（砍树） 顺带接入。
- `collect`（捡拾） 的成功标准必须是**目标物品在 Bot（机器人） 背包中的数量增长**；目标掉落物消失、接近目标、或实体列表变化，都不能替代成功判定。
- 本任务触碰 LLM（大语言模型） 规划 / Prompt（提示词） / parser（解析器） / 对话路由 / 在线入口装配，必须做真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；mock（模拟）测试不能替代真实调用。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 1 节、第 3.1 节、第 3.2 节、第 8 节、第 9 节、第 10 节
- `ts-core/Docs/02_RUNTIME_SPEC.md` 第 1 节、第 2 节、第 3 节、第 5 节
- `ts-core/Docs/04_CONVERSATION_SPEC.md` 第 1 节、第 2 节、第 3 节、第 5 节
- `ts-core/Docs/09_AGENT_WORKFLOW.md` 第 2 节、第 3 节、第 4 节
- `ts-core/scripts/probes/go-to-probe.ts`
- `ts-core/scripts/probes/collect-probe.ts`
- `ts-core/src/conversation/contracts.ts`
- `ts-core/src/conversation/index.ts`
- `ts-core/src/conversation/llm.ts`
- `ts-core/src/conversation/llm/client.ts`
- `ts-core/src/conversation/llm/config.ts`
- `ts-core/src/conversation/llm/diagnostics.ts`
- `ts-core/src/conversation/llm/errors.ts`
- `ts-core/src/conversation/llm/http.ts`
- `ts-core/src/conversation/llm/index.ts`
- `ts-core/src/conversation/llm/messages.ts`
- `ts-core/src/conversation/llm/parsers.ts`
- `ts-core/src/conversation/llm/prompts/index.ts`
- `ts-core/src/conversation/llm/prompts/plan.ts`
- `ts-core/src/conversation/llm/prompts/triage.ts`
- `ts-core/src/conversation/llm/skill-plan-table.ts`
- `ts-core/src/conversation/llm/stage.ts`
- `ts-core/src/conversation/llm/types.ts`
- `ts-core/src/conversation/planning.ts`
- `ts-core/src/conversation/triage.ts`
- `ts-core/src/workers/contracts.ts`
- `ts-core/src/workers/queues.ts`
- `ts-core/src/workers/bot-worker.ts`
- `ts-core/src/workers/conversation-worker/events.ts`
- `ts-core/src/workers/conversation-worker/handlers/cancel-interrupt.ts`
- `ts-core/src/workers/conversation-worker/handlers/chat-reply.ts`
- `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts`
- `ts-core/src/workers/conversation-worker/helpers.ts`
- `ts-core/src/workers/conversation-worker/index.ts`
- `ts-core/src/workers/conversation-worker/runtime.ts`
- `ts-core/src/workers/conversation-worker/types.ts`
- `ts-core/src/runtime/actor.ts`
- `ts-core/src/runtime/transport/collect.ts`
- `ts-core/src/runtime/transport/go-to.ts`
- `ts-core/src/runtime/transport/runtime.ts`
- `ts-core/src/runtime/transport/types.ts`
- `ts-core/src/skills/contracts.ts`
- `ts-core/src/skills/execution.ts`
- `ts-core/src/skills/index.ts`
- `ts-core/src/skills/registry.ts`
- `ts-core/src/core-ports/runtime.ts`
- `ts-core/src/core-ports/skills.ts`
- `ts-core/src/core-ports/tasking.ts`
- `ts-core/src/interfaces/server-bridge/contracts.ts`
- `ts-core/src/interfaces/server-bridge/protocol.ts`
- `ts-core/src/interfaces/server-bridge/route.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/main.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/scripts/probes/collect-probe.ts`
- `ts-core/src/conversation/llm/client.ts`
- `ts-core/src/conversation/llm/errors.ts`
- `ts-core/src/conversation/llm/parsers.ts`
- `ts-core/src/conversation/llm/prompts/plan.ts`
- `ts-core/src/conversation/llm/skill-plan-table.ts`
- `ts-core/src/conversation/llm/types.ts`
- `ts-core/src/conversation/planning.ts`
- `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts`
- `ts-core/src/workers/conversation-worker/runtime.ts`
- `ts-core/src/workers/conversation-worker/types.ts`
- `ts-core/src/workers/bot-worker.ts`
- `ts-core/src/workers/contracts.ts`
- `ts-core/src/runtime/actor.ts`（仅限 `collect`（捡拾） 门禁、执行诊断、状态门控或中断语义的最小必要修复）
- `ts-core/src/runtime/transport/collect.ts`
- `ts-core/src/runtime/transport/runtime.ts`（仅限 `collect`（捡拾） 适配与门禁的最小必要修复）
- `ts-core/src/runtime/transport/types.ts`（仅限 `collect`（捡拾） 类型边界）
- `ts-core/src/skills/contracts.ts`（仅限 `collect`（捡拾） 门禁或共享类型）
- `ts-core/src/skills/execution.ts`（仅限 `collect`（捡拾） 执行与未启用技能拒绝逻辑）
- `ts-core/src/skills/registry.ts`（仅限 `collect`（捡拾） 启用门禁）
- `ts-core/src/core-ports/runtime.ts`（仅限 `collect`（捡拾） 执行端口补齐）
- `ts-core/src/core-ports/skills.ts`（仅限 `collect`（捡拾） 技能门禁类型）
- `ts-core/src/core-ports/tasking.ts`（仅限执行任务类型必要收口）
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `plugin/src/main/java/**`
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`
- `ts-core/src/db/**`
- `ts-core/src/observation/**`
- `ts-core/src/runtime/transport/mine.ts`
- `ts-core/src/runtime/transport/equip.ts`
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. `collect`（捡拾） 必须先走 probe（探针）：
   - 先创建并验证 `ts-core/scripts/probes/collect-probe.ts`。
   - probe（探针） 必须直接验证“目标物品在背包中的数量增长”这一成功标准；目标实体消失、靠近目标或临时拾取动画均不算成功。
   - probe（探针） 验证与主程序并入属于同一任务；不得只交 probe（探针） 不并入主程序，也不得跳过 probe（探针） 直接并入。
2. 在线技能门禁必须精确：
   - T-046（任务四十六） 完成后，在线允许技能集合应为 `goTo`（前往坐标） + `collect`（捡拾）。
   - `mine`（挖掘） / `equip`（装备） / `cutTree`（砍树） 仍必须返回“未通过单技能验收 / 暂未启用”，不得入 `bot:{botId}:exec`（机器人执行队列）。
   - `goTo`（前往坐标） 已有能力不得回退。
3. `collect`（捡拾） 主链路必须复用既有在线入口：
   - `/svs`（服务端女仆命令） 仍由 `SERVER_BRIDGE_CONVERSATION_ENABLED=true`（服务端桥接对话启用） 控制。
   - `player_message`（玩家消息） 进入 `msg:{botId}`（消息队列） 后，由 ConversationWorker（对话工作线程） 统一 triage（分诊） 和 planner（规划）；不得在 Server Bridge（服务端桥接） 层写 `collect`（捡拾） 特殊分支。
   - `jobId`（任务标识） 仍使用 `message_id`（消息标识），重复消息不得重复执行。
4. `collect`（捡拾） 执行路径必须保持 BotActor（机器人执行代理） 单写者：
   - ConversationWorker（对话工作线程） 只负责生成 `ExecJob`（执行任务） 并入 `bot:{botId}:exec`（机器人执行队列）。
   - BotWorker（机器人工作线程） 只通过 BotActor（机器人执行代理） 执行，不得直接调用 Mineflayer（Minecraft 协议客户端） 物理动作。
   - BotActor（机器人执行代理） 未 ready（就绪）、world（世界） 未 ready（就绪）、外部认证未完成、正在执行其他任务时，必须显式失败或按既有串行语义排队，不得伪装成功。
5. `collect`（捡拾） 成功 / 失败语义必须可观测：
   - 成功必须体现目标物品数量增长；数量未增长时必须明确失败。
   - 没有目标掉落物、目标超范围、路程失败、超时、被中断时都必须给出可读诊断。
   - replay（补拉） 至少能观察 `task.accepted`（任务已接受）、`task.started`（任务已开始） 和终态诊断。
6. planner（规划器） 与 Prompt（提示词） 必须保持可控：
   - 真实 OpenAI（开放人工智能）兼容 API（应用程序接口） 必须能从中文 `/svs 把地上的圆石捡起来` 或等价自然语言产出 `collect`（捡拾） 技能调用。
   - 不得在 Prompt（提示词） 或代码中写死 Minecraft（我的世界） 配方、掉落、工具等级、方块组等事实。
   - 若需要中文物品名到标准 id（标识） 的翻译，只能使用现有允许的数据 / 类型边界，不得顺手引入事实知识库。
7. chat（闲聊） / cancel（取消） / 既有 `goTo`（前往坐标） 回归不得退化：
   - 普通 chat（闲聊） 仍走 T-044（任务四十四） 真实 LLM（大语言模型） 回复路径。
   - 显式 cancel（取消） 仍走规则分诊和中断，不调用 LLM（大语言模型） 规划，不应生成动作任务。
   - `goTo`（前往坐标） 在线规划、执行和门禁语义不得被 `collect`（捡拾） 接入破坏。

---

## 验收标准

1. `ts-core/scripts/probes/collect-probe.ts` 已完成真实运行时验证，并以“目标物品背包数量增长”为成功标准记录结果；若 Coder（编码代理） 无法直接实服验证，必须提供最短人工手测步骤。
2. `/svs 把地上的圆石捡起来` 或等价中文自然语言会经真实 planner（规划器） 产出 `collect`（捡拾） 技能调用，进入 `bot:{botId}:exec`（机器人执行队列），并由 BotWorker（机器人工作线程） 调用 BotActor（机器人执行代理） 执行。
3. `mine`（挖掘） / `equip`（装备） / `cutTree`（砍树） 在 T-046（任务四十六） 中仍不得被接入整链路；相关请求或 LLM（大语言模型） 输出必须被拒绝为“未通过单技能验收 / 暂未启用”，且不得入执行队列；`goTo`（前往坐标） 回归测试必须保持通过。
4. replay（补拉） 可看到 `collect`（捡拾） 成功、失败、被中断的可读诊断；成功分支必须以背包数量增长为依据，失败分支不得吞错或伪装成功。
5. 真实 OpenAI（开放人工智能）兼容 API（应用程序接口） planner（规划器） 调用成功；probe（探针） 验证与在线烟测结果已由 Coder（编码代理） 记录或已给出用户可执行手测步骤；`bash ts-core/scripts/pre_review.sh` 必须全部通过。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-046（任务四十六），且 T-045（任务四十五）已完成。
- [ ] 已先完成 `ts-core/scripts/probes/collect-probe.ts` 的独立验证，再把 `collect`（捡拾） 并入主程序。
- [ ] 已确认 `collect`（捡拾） 成功标准是目标物品背包数量增长，没有用目标实体消失替代成功。
- [ ] 已确认本任务完成后在线允许技能仅为 `goTo`（前往坐标） + `collect`（捡拾），`mine`（挖掘） / `equip`（装备） / `cutTree`（砍树） 仍未启用。
- [ ] 已确认未修改 `plugin/src/main/java/**`、`backend/**`、`data`（数据层）、`db`（数据库）、`sandbox`（沙箱）、`observation`（观测）目录，且未修改 `runtime/transport/mine.ts`（挖掘传输） 与 `runtime/transport/equip.ts`（装备传输）。
- [ ] 已保留普通 chat（闲聊） 回复行为、cancel（取消） 中断行为和既有 `goTo`（前往坐标） 在线能力。
- [ ] 已记录真实 LLM（大语言模型） planner（规划器） 调用命令、probe（探针） 验证过程与在线烟测结果；若不能直连实服，已提供最短人工手测步骤。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-047**: `mine`（挖掘）单技能独立验收与接入前验证：先做 `mine`（挖掘） probe（探针），再在同任务内并入主程序；目标识别不得写死 MC（Minecraft，我的世界）事实，必须依赖 runtime（运行时）或 `minecraft-data`（Minecraft 数据源）等事实源。
- **T-048**: `equip`（装备）单技能独立验收与接入前验证：先做 `equip`（装备） probe（探针），再在同任务内并入主程序；只能从现有背包选择物品，找不到必须明确失败。
- **T-049**: `cutTree`（砍树）单技能独立验收与接入前验证：仅在 `collect`（捡拾） 与 `mine`（挖掘） 都独立通过后再派发，仍遵循 probe（探针） 先行并在同任务内并入主程序。
