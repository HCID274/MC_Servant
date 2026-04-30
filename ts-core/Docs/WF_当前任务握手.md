# 当前任务握手区

【任务序号】: T-047B
【当前状态】: 待开发

---

## 任务目标

T-047B（任务四十七 B）是 `cutTree`（砍树）单技能独立验收与接入任务：先创建并验证独立 `cut-tree-probe.ts`（砍树探针），确认 `tree`（树木类） ResourceIndex（资源索引）缓存命中 / miss（未命中）刷新 / 候选块移动与挖掘语义可用；再在同一任务序号内把 `cutTree`（砍树）最小实现并入主程序。

本任务只启用 `cutTree`（砍树）一个新 skill（技能）。完成后在线允许 skill（技能）集合应为 `goTo`（前往坐标）+ `collect`（捡拾）+ `cutTree`（砍树）；`equip`（装备）与 `mine`（挖掘）仍必须保持未启用并返回 `skill_not_enabled`（技能未启用）。

---

## 上下文说明

- 用户已明确要求 skill（技能）必须逐个独立测试、独立验收；`cutTree`（砍树）顺序在 `equip`（装备）与 `mine`（挖掘）之前。
- 用户已明确要求每个 skill（技能）必须 probe（探针）先行：先在 `ts-core/scripts/probes/` 创建独立探针，用户与 Coder（编码代理）充分验证后，再由 Coder（编码代理）在同一任务内并入主程序。
- T-047A（任务四十七 A）已完成 ResourceIndex（资源索引）前置能力：`queryClusters(resourceKey, maxCount?)`（查询资源簇）、`refreshAroundBot(resourceKey, radius)`（围绕 Bot 刷新资源）、半径阶梯 `16 -> 32 -> 64` 与 planner（规划器）短资源摘要。
- T-047B（任务四十七 B）的主程序 `cutTree`（砍树）不得临时扫描世界，也不得绕过 ResourceIndex（资源索引）：必须先只查 `tree`（树木类）缓存；cache_miss（缓存未命中）或 stale_snapshot（快照过期）时才请求 ResourceIndex（资源索引）按 `16 -> 32 -> 64` 刷新；命中后移动到候选块附近并挖掘候选块。
- T-047B（任务四十七 B）不得在代码、Prompt（提示词）或 probe（探针）中硬编码 Minecraft（我的世界）树种、原木、树叶、掉落、工具等级等事实。若当前运行时事实源不能解析 `tree`（树木类），必须返回可读诊断，不能用字符串猜测。
- 本任务触碰 skill（技能）启用、Prompt（提示词）、LLM（大语言模型）解析、对话路由与在线入口装配，因此验收必须包含真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用。

---

## 输入文件白名单

Coder（编码代理）本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 1 节、第 2 节、第 3.1 节、第 3.2 节、第 8 节、第 9 节、第 10 节
- `ts-core/Docs/02_RUNTIME_SPEC.md` 第 1 节、第 2 节、第 3 节、第 5 节、第 8 节
- `ts-core/Docs/04_CONVERSATION_SPEC.md` 第 1 节、第 2 节、第 5 节
- `ts-core/Docs/09_AGENT_WORKFLOW.md` 第 2 节、第 3 节、第 4 节
- `ts-core/src/core-ports/skills.ts`
- `ts-core/src/core-ports/runtime.ts`
- `ts-core/src/core-ports/tasking.ts`
- `ts-core/src/world-model/contracts.ts`
- `ts-core/src/world-model/query.ts`
- `ts-core/src/world-model/minecraft-data.ts`
- `ts-core/src/world-model/index.ts`
- `ts-core/src/runtime/actor.ts`
- `ts-core/src/runtime/transport/runtime.ts`
- `ts-core/src/runtime/transport/types.ts`
- `ts-core/src/runtime/transport/index.ts`
- `ts-core/src/runtime/transport.ts`
- `ts-core/src/runtime/index.ts`
- `ts-core/src/runtime/transport/pathfinder.ts`
- `ts-core/src/runtime/transport/go-to.ts`（只读参考移动适配方式，不得修改）
- `ts-core/src/runtime/transport/mine.ts`（只读参考 dig（挖掘）适配方式，不得修改）
- `ts-core/src/runtime/transport/collect.ts`（只读参考实服诊断与结果口径，不得修改）
- `ts-core/src/skills/execution.ts`
- `ts-core/src/skills/registry.ts`
- `ts-core/src/skills/index.ts`
- `ts-core/src/conversation/llm/prompts/plan.ts`
- `ts-core/src/conversation/llm/skill-plan-table.ts`
- `ts-core/src/conversation/llm/types.ts`
- `ts-core/src/conversation/llm/parsers.ts`
- `ts-core/src/conversation/llm/errors.ts`
- `ts-core/src/conversation/planning.ts`
- `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts`
- `ts-core/src/workers/conversation-worker/helpers.ts`
- `ts-core/src/workers/conversation-worker/types.ts`
- `ts-core/src/workers/conversation-worker/runtime.ts`
- `ts-core/src/workers/bot-worker.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/runtime-core.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/scripts/probes/go-to-probe.ts`
- `ts-core/scripts/probes/collect-probe.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/observation-world-model.spec.ts`

Coder（编码代理）本轮允许新增 / 修改：

- `ts-core/scripts/probes/cut-tree-probe.ts`
- `ts-core/src/core-ports/skills.ts`（仅限 `cutTree`（砍树）参数 / 结果 / 适配器契约）
- `ts-core/src/runtime/transport/cut-tree.ts`
- `ts-core/src/runtime/transport/runtime.ts`（仅限接入 `cutTree`（砍树）适配器与复用 ResourceIndex（资源索引）只读刷新端口）
- `ts-core/src/runtime/transport/types.ts`（仅限 `cutTree`（砍树）与候选块所需 Mineflayer（Minecraft 协议客户端）端口类型）
- `ts-core/src/runtime/transport/index.ts`
- `ts-core/src/runtime/transport.ts`（仅限导出 `cutTree`（砍树）传输类型 / 适配器所需桶导出）
- `ts-core/src/runtime/index.ts`（仅限导出 `cutTree`（砍树）传输类型 / 适配器所需桶导出）
- `ts-core/src/runtime/actor.ts`（仅限允许 `cutTree`（砍树）通过 BotActor（机器人执行代理）单写者技能分发；`mine`（挖掘）/ `equip`（装备）仍禁用）
- `ts-core/src/skills/execution.ts`
- `ts-core/src/skills/registry.ts`
- `ts-core/src/skills/index.ts`
- `ts-core/src/conversation/llm/prompts/plan.ts`（仅限启用 `cutTree`（砍树）规划说明，仍声明 `mine`（挖掘）/ `equip`（装备）未启用）
- `ts-core/src/conversation/llm/skill-plan-table.ts`
- `ts-core/src/conversation/llm/types.ts`
- `ts-core/src/conversation/llm/parsers.ts`
- `ts-core/src/conversation/llm/errors.ts`
- `ts-core/src/conversation/planning.ts`
- `ts-core/src/workers/conversation-worker/handlers/plan-exec.ts`
- `ts-core/src/workers/conversation-worker/helpers.ts`（仅限未启用技能文案从 T-046 更新为 T-047B）
- `ts-core/src/workers/conversation-worker/types.ts`
- `ts-core/src/workers/conversation-worker/runtime.ts`
- `ts-core/src/workers/bot-worker.ts`（仅限允许 `cutTree`（砍树）入 BotActor（机器人执行代理），`mine`（挖掘）/ `equip`（装备）仍禁用）
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/runtime-core.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/src/__tests__/skills-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`
- `ts-core/src/__tests__/runtime-skill-execution-model.spec.ts`
- `ts-core/src/__tests__/bot-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/conversation-llm-planning-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/observation-world-model.spec.ts`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `plugin/src/main/java/**`
- `ts-core/src/runtime/transport/equip.ts`
- `ts-core/src/runtime/transport/mine.ts`
- `ts-core/src/runtime/transport/go-to.ts`
- `ts-core/src/runtime/transport/collect.ts`
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`
- `ts-core/src/db/**`
- `ts-core/src/interfaces/server-bridge/**`
- 除 `ts-core/scripts/probes/cut-tree-probe.ts` 外的 `ts-core/scripts/probes/**`
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. probe（探针）先行：
   - 新增 `ts-core/scripts/probes/cut-tree-probe.ts`，必须能独立连接实服或等价 Mineflayer（Minecraft 协议客户端）运行时。
   - probe（探针）必须输出 ResourceIndex（资源索引）查询状态、刷新半径、候选 cluster（资源簇）、候选方块坐标、移动 / 挖掘尝试与最终结果。
   - probe（探针）不得把 `tree`（树木类）硬编码成 `logs`（原木标签）、任何树种或任何固定方块名；事实源不能识别时必须报告 `unsupported_resource_key`（不支持的资源键）并停止。
2. 主程序 `cutTree`（砍树）必须通过 ResourceIndex（资源索引）：
   - 执行前先 `queryClusters("tree", ...)`（查询树木类资源簇），命中后选择排序最优候选。
   - cache_miss（缓存未命中）或 stale_snapshot（快照过期）时按 `16 -> 32 -> 64` 调用 `refreshAroundBot("tree", radius)`（围绕 Bot 刷新树木类资源），命中即停止扩大半径。
   - 仍未命中或返回 `unsupported_resource_key` / `runtime_unavailable` 时必须失败并给出明确诊断，不得回退到临时全图扫描。
3. `cutTree`（砍树）最小执行语义：
   - 参数仍保持单技能最小形态：`{ count: positive integer }`（正整数数量）。不得在本任务引入多技能、批量规划或复杂树冠清理。
   - 每次只从 ResourceIndex（资源索引）候选中选择要挖的候选块，移动到可挖距离后调用 Mineflayer（Minecraft 协议客户端）受控 `dig`（挖掘）能力。
   - 成功结果必须包含已挖数量、候选 cluster（资源簇）标识、使用的刷新半径 / 快照版本、已挖方块位置；失败结果必须明确区分 `resource_not_found`（资源未找到）、`unsupported_resource_key`（资源键不支持）、`runtime_unavailable`（运行时不可用）、`unreachable`（不可达）或 `dig_failed`（挖掘失败）。
4. 单技能门禁必须正确推进：
   - conversation（对话）/ planner（规划器）/ BotWorker（机器人工作线程）/ BotActor（机器人执行代理） 只新增 `cutTree`（砍树）为已启用技能。
   - `mine`（挖掘）与 `equip`（装备）仍必须在 LLM（大语言模型）违规输出、直接入队或 sandbox（沙箱）调用时返回 `skill_not_enabled`（技能未启用）语义，不得进入执行路径。
   - `goTo`（前往坐标）与 `collect`（捡拾）既有行为不得退化。
5. 不得写死 Minecraft（我的世界）事实：
   - 代码、Prompt（提示词）、probe（探针） 和测试生产路径不得硬编码树种、原木列表、树叶列表、掉落规则、工具等级或 `tree -> logs`（树木类到原木标签）之类映射。
   - 测试可以构造 fake registry（伪注册表） 或 fake block.tags（伪方块标签） 来证明“运行时提供 `tree`（树木类）事实时可以命中；只提供 `logs`（原木标签）时不能被当成 `tree`（树木类）”。

---

## 验收标准

1. `cut-tree-probe.ts`（砍树探针）已完成实服或等价运行时验证，反馈区记录命令、输入参数、ResourceIndex（资源索引）摘要、候选块、执行结果；若实服事实源无法识别 `tree`（树木类），必须记录 `unsupported_resource_key`（不支持的资源键）诊断和最短复测步骤。
2. 主程序 `cutTree`（砍树）只通过 ResourceIndex（资源索引）查询 / 刷新选择候选；测试覆盖命中缓存、miss（未命中）后按 `16 -> 32 -> 64` 刷新、运行时不可用、资源键不支持、不可达 / 挖掘失败等关键分支。
3. 在线允许 skill（技能）集合变为 `goTo`（前往坐标）+ `collect`（捡拾）+ `cutTree`（砍树）；`mine`（挖掘）与 `equip`（装备）仍被拒绝为 `skill_not_enabled`（技能未启用），且不得入 BotActor（机器人执行代理）物理执行路径。
4. 未在代码、Prompt（提示词）或 probe（探针） 中写死 Minecraft（我的世界）树木事实；测试明确证明 `tree`（树木类）不会因 `logs`（原木标签）而误命中。
5. 真实 OpenAI（开放人工智能）兼容 API（应用程序接口）planner（规划器）调用已执行，反馈区必须记录调用命令、输入摘要、`snapshot_context`（快照上下文）资源摘要片段、模型输出和结果判断；`bash ts-core/scripts/pre_review.sh` 必须全部通过。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-047B（任务四十七 B），且 T-047A（任务四十七 A）已完成。
- [ ] 已先完成 `ts-core/scripts/probes/cut-tree-probe.ts`（砍树探针），并记录实服或等价运行时验证结果。
- [ ] 已确认 `cutTree`（砍树）主程序只查询 `tree`（树木类） ResourceIndex（资源索引）缓存，miss（未命中）才按 `16 -> 32 -> 64` 刷新。
- [ ] 已确认 `cutTree`（砍树）不直接临时扫描世界、不绕过 ResourceIndex（资源索引）、不写死 `tree -> logs`（树木类到原木标签） 或任何树木事实。
- [ ] 已确认 `cutTree`（砍树）成功 / 失败结果包含可审查诊断，且不会伪装成功。
- [ ] 已确认在线允许 skill（技能）仅新增 `cutTree`（砍树），`mine`（挖掘）与 `equip`（装备）仍保持 `skill_not_enabled`（技能未启用）。
- [ ] 已确认 `goTo`（前往坐标）与 `collect`（捡拾）既有测试和行为不退化。
- [ ] 已记录真实 LLM（大语言模型）planner（规划器）调用命令、输入摘要、资源摘要片段、模型输出与结果判断；若不能访问本地网关，已提供最短人工手测步骤。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-048**: `equip`（装备）单技能独立验收与接入前验证：先做 `equip-probe.ts`（装备探针），再在同任务内并入主程序；只能从现有背包选择物品，找不到必须明确失败。
- **T-049**: `mine`（挖掘）单技能独立验收与接入前验证：先做 `mine-probe.ts`（挖掘探针），再在同任务内并入主程序；目标识别不得写死 MC（Minecraft，我的世界）事实，必须依赖 runtime（运行时）或 `minecraft-data`（Minecraft 数据源）等事实源。
- **T-050**: 基础 skill（技能）端到端 demo（演示）收口：在已通过单技能验收的范围内做 `/svs`（服务端女仆命令）真实对话到执行闭环复测，不新增新 skill（技能）。
