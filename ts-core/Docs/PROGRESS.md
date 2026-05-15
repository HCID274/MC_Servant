# 项目进度记录

> Reviewer C 在审查通过后追加。一条一个任务。
> 历史批次摘要 (T-001 ~ T-040) 见 `PROGRESS_LEGACY.md`。
> 本文件只保留审查结论、边界和关键决策；完整命令输出、长日志与反复排查过程不放入进度文档。

## 字段格式

```
## T-XXX | YYYY-MM-DD | 一句话功能描述

- 摘要: 用户目标 + 抽象边界; C 审查结果 + 必要返修原因 + 验证概况; 关键取舍;无冲突写“无”
```

---

## 进行中 (旧系统遗留)

### T-047B | cutTree 单技能验收 + 接入

- 状态: 旧 Manager 工作流下规划,未完成。新工作流启用后可由 Planner A 重新评估或接续。
- 目标/约束: 在线 skill 从 `goTo + collect` 扩到 `goTo + collect + cutTree`;probe 先行,ResourceService 查询/刷新,不得硬编码 MC 树木事实,`mine`/`equip` 仍保持未启用。
- 后续: T-048 equip、T-049 mine、T-050 基础 skill 端到端 demo 收口。

---

## 已完成 (新工作流下)

## T-072/T-073 | 2026-05-07 | eval JSONL 契约与 LLM 阶段离线评测 runner

- 摘要: 定义 eval case/run/attempt/metric JSONL 契约,并用固定样本真实调用 triage/plan/chat/report;不接 PG schema/API/event_log,只落本地 JSONL。; 曾打回 1 次;失败 attempt 的 `input_tokens=0` 未回退估算已修。真实 eval 产出 6 cases/13 JSONL,指标齐全,预检全绿。; A1/D1/D2/D3/E2 只作 metric id,case 用 `case_*`;D3 用 chat 样本做反事实 token 节省估算。冲突: 无。

## T-074R | 2026-05-07 | 生产指标事件契约与自动落盘

- 摘要: 暂停主动 execution/recovery eval 主路线,改成真实运行自动写生产指标 JSONL;边界为 diagnostics/data contracts/conversation/workers/runtime 摘要。; 曾打回 1 次;补了正常 TS Core + MC 实服闭环证据,包含 triage、plan、plan accepted、task started/failed、report。预检与真实 LLM 验证通过。; 主指标来源改为 `logs/metrics/YYYY-MM-DD/production-metrics.jsonl`;固定 LLM eval 仅保留离线验证。冲突: 无。

## T-075R | 2026-05-07 | LLM 与 Plan 输出生产指标自动记录

- 摘要: 每次 triage/chat/plan/report 后记录延迟、token、Plan 解析、门禁和静态预检结果;输出 10 个语义化 LLM 指标。; 通过。Plan parser 细分严格 JSON、code-only、门禁和静态预检结果,生产指标新增对应字段;真实生产链路覆盖 triage/plan/report/chat。; 在 LLM diagnostic 层记录质量,由 workers 映射到 production metrics,不反向解析日志文本。冲突: 无。

## T-076R | 2026-05-07 | 执行链路生产指标自动记录

- 摘要: BotWorker 真实任务终态自动记录状态、耗时、步骤数、失败码、人工干预;输出执行链路 7 个语义化指标。; 通过。终态事件包含 `terminal_status`、`step_count`、`is_manual_intervention`;实服短任务完成并可汇总 run_count/completion_rate/step_count。; 从 BotWorker 生命周期映射指标,不让 diagnostics 读取 runtime/sandbox 内部状态。冲突: 无。

## T-077R | 2026-05-07 | 失败恢复链路关联与自动统计

- 摘要: 将失败任务、Failure Capsule、continuation Plan、二次执行串成恢复链,统计 recoverable 成功率和重规划次数。; 曾打回 1 次;continuation 再失败会换链和重置计数已修,`recovery_chain_id`/`replan_count` 沿 ExecJob/lifecycle/recent context 透传。实服恢复链验证通过。; 恢复链元数据隐藏透传,不写 prompt 文本、不改 PG schema/event_log。冲突: 无。

## T-078R/T-079R | 2026-05-07 | 生产指标汇总脚本与固定样本 benchmark 降级

- 摘要: 生产指标 JSONL 汇总支持时间窗口、模型、prompt 版本、任务类型和 JSON/表格/中文摘要;固定样本 runner 降级为 benchmark。; 通过。新增 `metrics:summary` 与 `benchmark:llm`,旧 A/B/C/D/E 编号不再作为主指标名;旧运行态日志和 PG 运行态表清理为新基线。; 简历数据来自生产自动落盘 + 汇总脚本;主动 CLI 只做固定样本回归和反事实 token 指标。冲突: 无。

## T-071D | 2026-05-07 | terrain-router 水平挖穿成本与 A* 诊断修复

- 摘要: 实服发现同水平障碍前不挖穿而耗尽 A* expanded;要求按根因调整成本并加诊断。; 通过。降低 terrain change 相对成本并输出 cost 诊断;实机坐标任务完成,预检全绿。; 优先修成本模型而非扩大搜索预算;保留“短距离可绕行时不挖墙”回归。冲突: 无。

## T-071C | 2026-05-07 | terrain/mine BFS 净空语义与 digStepDown 契约收敛

- 摘要: BFS 边必须代表 Bot 真实可执行一步;平移/跳跃/阶梯/垫高净空语义需统一到 helper。; 曾打回 1 次;mine `digStepDown` 未按 jump 语义执行已修。typecheck、定向测试、预检通过。; 抽 `clearancePositions/hasClearance/collectClearanceDigs`,同步 mine 与 terrain planner/executor 契约。冲突: 无。

## T-071B | 2026-05-07 | ReportLLM 终态润色与 terrain goTo/mine 实服返修

- 摘要: 终态汇报由 ReportLLM 润色但不得篡改事实;实服又暴露 goTo/mine 地形执行和垫高问题。; 曾打回 1 次;散落 MC 方块事实已收敛到 `MineBlockFactReader`,ReportLLM 模板回退和事实校验保留。真实 LLM 与实机任务验证通过。; 采用“确定性模板 -> LLM 润色 -> required facts 校验 -> 回退模板”;地形路由接管移动/挖掘动作。冲突: 无。

## T-080 | 2026-05-07 | mine/goTo 脚位移动内核收敛与挖矿掉落恢复

- 摘要: 实服挖 10 石头暴露工具检查、旧移动跑飞、Y 未落下、180 度折返、8 次上限和掉落未捡等问题。; 通过。工具事实回到 runtime registry/minecraft-data;新增共享 `foot-step`,修 mine BFS、动态尝试上限和 drop collect recovery。实服完成 `cobblestone x10` 并返回主人。; 对外保留 `goTo`/`mine` 两个高内聚接口,只合并底层脚位移动;掉落名只从 runtime 结构化错误读取。冲突: 无。

## T-070B | 2026-05-06 | runGoal/until/report 任务生命周期闭环

- 摘要: 建立 `reply -> runGoal -> ensure/until -> report` 生命周期,统一目标结果、完成条件和终态汇报。; 多次实服返修后通过。修复 cutTree ensure 误用、垫高不稳定、Plan search 多轮拖死、mine 起点误判等;真实 LLM 多动作代码通过。; 终态事实由 `GoalResult` 统一消费;禁止不稳定一格塔,修 mine queue 起点离散化。冲突: 无。

## T-069B | 2026-05-06 | 通用 ensure 依赖解析器与事实端口收敛

- 摘要: 将具体 ensure 函数组收敛为 `ensure(action, condition)`,依赖补齐由结构化失败码和运行时事实驱动。; 曾打回 1 次;硬编码矿物/镐子/掉落事实已移除,改由 `ToolchainEnsureFacts` 读取 registry/recipe/drops/harvestTools。真实 LLM 与实服分诊返修通过。; ensure 只编排,事实端口读 MC 事实;不新增 demo 函数,不把工具链写进 prompt。冲突: 无。

## T-067 | 2026-05-06 | Plan 输出契约收敛为唯一 code 任务

- 摘要: Plan 在线输出统一为 `{ "code": "..." }`,删除旧 `skill_call` / `sandbox_code` 双路径语义。; 曾打回 1 次;内部 ExecJob 双类型已收敛为 code 语义,旧字段只在拒绝清单和负向测试中出现。真实 LLM 验证通过。; 执行层任务类型统一为 `ExecutionTaskKind.Code`,底层 skill 仍作为 TS 语义函数复用。冲突: 无。

## T-068B | 2026-05-06 | Semantic API 注入与 cutTree 执行桥接返修

- 摘要: Plan 代码直接调用 `reply/runGoal/ensure/until/mine/cutTree/.../report/search/owner`,由沙箱映射到底层 BotActor 单写者。; 通过。Prompt 改教顶层语义 API,owner/search 只读注入;cutTree 实服返修后成功。真实 LLM 样本不含 `api.bot`。; 语义 API 映射到既有 facade,不新增物理动作实现;过渡形态由 T-069/T-070 后续收敛。冲突: 过渡语义已后续解决。

## T-070 | 2026-05-06 | SkillResultSummary 世界键全链路补齐

- 摘要: goTo/collect/equip 等早期 skill 成功结果补 `world_key`,与 mine/cutTree 摘要契约统一。; 通过。世界键从 runtime transport 透传到 summary/reporter,实测汇报显示 `multiworld:resource` 而非 unknown。; 复用 transport `getCurrentWorldKey` 语义,summary/reporter 只消费不猜测。冲突: 无。

## T-069 | 2026-05-06 | Failure Capsule 运行链路与失败后继续规划

- 摘要: 执行失败生成短 Failure Capsule,continuation Plan 换策略且不得重复 retry_guard;完整详情留 diagnostics/JSONL。; 曾打回 1 次;失败后全新任务不再错误只注入 capsule。真实 LLM continuation 会换策略而非重复原动作。; TaskResultSummary 确定性生成胶囊,ConversationWorker 只渲染和路由。冲突: 无。

## T-068 | 2026-05-05 | Failure Capsule 文档契约对齐

- 摘要: 文档化失败 continuation 只注入短 Failure Capsule,完整失败详情进 diagnostics/JSONL。; 曾打回 1 次;明确普通 recent context 仍可注入 sandbox TS,失败 continuation 例外只用短胶囊。文档预检通过。; 不删除全部 sandbox TS 注入,只对失败场景控 token 和暴露最小事实。冲突: 无。

## T-066 | 2026-05-05 | Plan Prompt v2 与 sandbox_code 闭环门禁

- 摘要: Prompt v2 用规则和短正反例约束组合能力,禁止 `demoMineIron`,要求 sandbox_code 检查结果并汇报。; 通过。Prompt 未写死配方/掉落/工具等级/路线;parser 做最低门禁;真实 LLM 样本通过。; 用 prompt 规则 + parser 门禁,不新增硬编码 demo;单步走 skill_call、多步走 sandbox_code 的旧阶段语义后续已收敛。冲突: 无。

## T-OPS-001 | 2026-05-01 | Docker 一键启停与开发模式入口

- 摘要: 保留三端 Docker 验收,新增 PostgreSQL + Redis 开发模式;不动 MC 服务端和 LLM 链路。; 通过。根目录启停脚本、ts-core Dockerfile/README 与旧 Python 入口调整完成。; 复用同一 Compose 和 `.env`,用 `dev-infra.sh` 只拉 infra,避免第二份配置漂移。冲突: 无。

## T-NET-001 | 2026-05-01 | 受击 knockback 物理反馈诊断与最小修复

- 摘要: 修复 bot 受击后缺失原版等价击退位移;限定 Mineflayer 适配层和探针。; 通过。兼容 1.20.3+ `entity_velocity` 包结构并按协议速度单位写回 entity velocity。; 不 fork 或 monkey-patch Mineflayer,只在适配层处理协议差异。冲突: 无。

## T-NET-003 | 2026-05-01 | multiworld 方块事实可信修复

- 摘要: 修复 `multiworld:resource` 下方块事实失真;不动 LLM/prompt/skill 规划层。; 曾打回 1 次;用户放宽代码量和并发验收后通过。根因定位为 Mineflayer blocks plugin 维度切换后 worldName 恢复失败。; 先在 adapter 做兼容补丁,不进入 JAR 权威 block change 推送路径。冲突: 无。

## T-CTX-RES-0 | 2026-05-02 | ResourceService 接口落地与存量补丁收编

- 摘要: ResourceIndex 升格为 ResourceService,公共 API 保持 `query/refresh`,内部按 `(world_key, resource_key)` 路由。; 曾打回 1 次;补跨维度实服回归后通过。世界读取端口与缓存桶落地。; 世界解析唯一在 transport,业务层只消费 ResourceService/WorldReader。冲突: 无。

## T-CTX-001 | 2026-05-02 | Planner prompt 注入真实 Bot/世界/主人/背包快照

- 摘要: 用真实 observation 快照替换在线 planner 占位上下文,渲染 §7.1 八行信息。; 曾打回 1 次;补 world-state-reset 清理 pathfinder/控制状态/实体索引后通过。; app 根实时采样,`world_key` 由 transport 读取;无玩家名时按主人离线降级。冲突: 无。

## T-LLM-THINK-OFF | 2026-05-03 | LLM thinking 模式默认关闭

- 摘要: 统一配置关闭 MiMo thinking,不在业务层散落供应商私有参数。; 曾打回 1 次;非 MiMo 坏组合配置阶段显式拒绝。运行时与 app 回归通过。; MiMo 下沉 `enable_thinking=false`,非 MiMo 仅在 force 且 effort 非 none 时发送 reasoning 字段。冲突: 无。

## T-CTX-CHAT-1 | 2026-05-03 | Chat 路径快照模板与 Stage 2-Chat 回归

- 摘要: Chat 路径注入 Bot/世界/主人/背包/背包变化/最近上下文/时间子集,并修 triage 直出 reply 绕过 Chat。; 通过。triage 只做路由,运行时忽略 `reply.content` 进入 Stage 2-Chat;本地日志旁路落盘。; 空背包变化和最近上下文按规则省略;日志失败不阻断回复。冲突: 无。

## T-CTX-DLG-1 | 2026-05-03 | 最近上下文双 owner 时间线全链路

- 摘要: ConversationWorker 与 BotActor 写入统一双 owner 时间线,Chat/Plan/Modify 消费同一上下文。; 曾打回 1 次;改为 RuntimeRecentEventFormatter 端口注入并收敛 sandbox finalize sink 后通过。; 进程内 round store 聚合、10 轮 LRU、从旧到新渲染;泛指捡拾 prompt 走无 itemName collect。冲突: 无。

## T-CTX-002 | 2026-05-03 | inventory diff cache 三路共享

- 摘要: bot_id 维度进程内 baseline,Chat/Plan/Modify 渲染背包变化后推进 baseline。; 通过;实服 collect 修正默认半径 32、最大 64,扩半径逻辑在 runtime transport。; diff 不放 observation 时钟,由 ConversationWorker 路径出口推进;泛指捡拾以主人坐标为中心。冲突: 无。

## T-CONV-001 | 2026-05-03 | Triage 净化与 composite schema 收敛

- 摘要: Stage 1-Triage 只做路由,统一 composite schema,删除旧 `{intent, priority, reason}` 和 `reply.content`。; 曾打回 1 次;解析失败 diagnostics 已落本地 LLM JSONL,不再只存在内存回调。真实 LLM 验证通过。; 严格拒绝旧 schema,由 `ConversationLlmTriageError` 携带诊断向上暴露。冲突: 无。

## T-CONV-002 | 2026-05-03 | 删除 Modify 路径并降级为 cancel + task

- 摘要: 删除 `modify_interrupt_then_plan`,修改诉求统一为 composite `cancel + action(task)`。; 通过;实服打回后补 `stopCurrentAction` transport port,取消后物理动作能停止。; ConversationWorker 只串联 cancel/reply/action,Mineflayer 停止细节收敛在 runtime transport。冲突: 无。

## T-CONV-003 | 2026-05-03 | control fast-path 入口接入与取消词去重

- 摘要: 精确控制词前移到接口网关/消息接入层,命中后直接 BotActor interrupt,不入队。; 通过。HTTP 和 server-bridge 共用 matcher,ConversationWorker 删除重复取消词兜底。; 控制词只在 interfaces 边界精确匹配,避免 LLM/triage 参与紧急停止。冲突: 无。

## T-CONV-004 | 2026-05-03 | intent_epoch Redis INCR 单调源接入

- 摘要: `intent_epoch` 以 Redis INCR 为唯一单调源,贯穿接入、任务上下文、过期丢弃和中断。; 通过。消息入口取号,BotWorker 异步读当前 epoch 并丢弃过期任务。; 真实路径 Redis 实现,测试路径同端口内存实现。冲突: 无。

## T-BRAIN-001 | 2026-05-03 | PG schema 与 Drizzle 模型落地

- 摘要: 落地 Brain 五张表及索引/约束/全文/向量索引;只改 schema 和 migration。; 曾打回 1 次;首个 migration 已补成空库可重放完整当前 schema。; 高级索引用原始 SQL,Drizzle 只声明可类型化结构。冲突: 无。

## T-BRAIN-002 | 2026-05-03 | BotWorker 任务卡入队与 BrainWorker 写入 B 层

- 摘要: BotWorker 终态推任务卡,BrainWorker 独占 embedding API 和 `task_events` 写入。; 曾打回 2 次;主程 `EMBEDDING_*` 装配和真实链路验证补齐后通过。; embedding endpoint 独立配置,不复用 LLM base_url;app 只做装配。冲突: 无。

## T-BRAIN-003 | 2026-05-03 | A.5 滚动摘要维护与触发式 takeaway

- 摘要: BrainWorker 落地失败要点、会话静默要点和滚动摘要追加/重压。; 通过。任务日志前 50 行读取、滚动摘要阈值压缩和静默触发条件落地。; BrainWorker 独占 B/A.5 写入;会话静默由主人心跳、队列 idle、BotActor 活跃三条件判定。冲突: 无。

## T-BRAIN-004 | 2026-05-03 | Rubric 候选识别与 bot_memory 自动提拔

- 摘要: C 层候选识别、置信度提拔、安全扫描、容量决策和审计。; 曾打回 1 次;“这里/基地”坐标改为发话时 snapshot 结构化透传,避免异步 live snapshot 污染。; BrainWorker 统一编排候选/提拔/审计;安全命中保留 pending 但禁止自动提拔。冲突: 无。

## T-BRAIN-005 | 2026-05-04 | ConversationWorker 注入 Brain 上下文与 search 工具

- 摘要: Chat/Plan 注入 A/A.5/C 层上下文和 search 工具,Stage 1-Triage 不暴露工具。; 曾打回 3 次;补三 worker 集成、task_history 父链、Brain fact best-effort 旁路和双失败测试后通过。; ConversationWorker 通过端口消费 Brain 上下文;BotWorker 维护 task_history,BrainWorker 写 task_events。冲突: 无。

## T-CONV-005 | 2026-05-04 | Composite Triage 空路由片段从 reply 改名为 chat

- 摘要: 将 Triage 空路由片段改为 `chat:{}`,避免与旧 `reply.content` 混淆。; 通过。旧 `reply` 字段硬拒绝,真实 LLM 纯闲聊返回 `{"chat":{}}`。; 不保留兼容双轨,让 schema 漂移进入 diagnostics。冲突: 无。

## T-052A | 2026-05-04 | BFS 资源簇提取与缓存更新

- 摘要: ResourceService/world-model 资源簇从距离聚类改为按 blockName BFS 连通聚类,支持方块变化更新缓存。; 曾打回 1 次;补 app 生产 blockUpdate 接线并移出越界改动后通过。; BFS 与断裂重切分在 world-model/ResourceService 内,world_key 仍只从 transport 读取。冲突: 无。

## T-052B | 2026-05-04 | 树木资源簇分类与 cutTree 目标选择

- 摘要: 把原木资源簇分类为 accepted/rejected,按距离累计满足 requiredLogCount。; 曾打回 4 次;补 runtime tag/可挖/候选事实、`tree -> logs` 内部解析和远距离回归后通过。; 公共资源键保留 `tree`,runtime 用 minecraft-data tag 解析,不在 world-model 按名字猜原木。冲突: 无。

## T-052C | 2026-05-04 | plugin 树木/矿石相连连锁掉落

- 摘要: 服务端 plugin 支持树木/矿石连锁掉落,供 TS Core cutTree/mine 使用真实物理结果。; 通过。连锁掉落边界保留在 plugin,TS Core 只消费 Mineflayer/ResourceService 观察结果。; 不把连锁规则写入 prompt 或 skill;服务端负责物理掉落,客户端按背包 diff 验收。冲突: 无。

## T-053 | 2026-05-04 | cutTree 技能接入资源簇执行链

- 摘要: 正式 cutTree 从 ResourceService 选择树簇并执行砍伐、捡拾和背包增量验证。; 通过。cutTree 接入资源簇选择、执行和 summary;后续长程与捡拾问题由 T-053-DBG/T-080 等返修。; cutTree 表达“获得原木”语义,资源事实来自 ResourceService,不让 LLM 猜树种。冲突: 无。

## T-053-DBG | 2026-05-04 | cutTree 长程任务目标选择与捡拾修复

- 摘要: 修复 cutTree 长任务目标选择、连锁掉落后的收集和背包增量问题。; 通过。修复推荐目标、collect 触发和结果摘要;保留整簇删除语义以匹配原木连锁掉落。; 砍树后的树苗/木棍/原木可一并 collect,但完成证明只看原木增量。冲突: 无。

## T-055 | 2026-05-04 | 最小 CraftService 与 Mineflayer 合成适配

- 摘要: 建立最小合成服务和 Mineflayer 合成适配,供工具链恢复使用。; 通过。合成能力从 runtime transport 暴露,错误保留缺材料/工作台等结构。; 配方事实来自 Mineflayer/minecraft-data,Phase 1 allowlist 只限制目标范围。冲突: 无。

## T-056 | 2026-05-04 | 最小 PlacementService 与 crafting table 放置执行链

- 摘要: 放置工作台能力接入 runtime transport,支持后续 craft/toolchain。; 通过。候选点选择、靠近、放置和真实方块确认落地;后续 place 鲁棒性由 T-089 前后继续收敛。; Placement 负责放置,不承载合成材料规则。冲突: 无。

## T-057 | 2026-05-04 | 最小 equip 技能启用与主手切换

- 摘要: 启用 equip 技能,把主手装备切换纳入 skill/result summary。; 通过。装备动作通过 BotActor/transport 单写者执行,结果携带世界和装备摘要。; equip 只表达装备目标,工具选择和依赖补齐由 toolchain 处理。冲突: 无。

## T-058 | 2026-05-04 | StairBFSPlanner 采矿核心

- 摘要: 建立早期阶梯挖矿规划核心,用于 mine 技能接入前验证。; 通过。规划器能给出安全阶梯路径和基础诊断;后续逐步演进为自研 mine/terrain router。; 先用可审计 BFS 建模挖矿动作,不交给黑盒 pathfinder。冲突: 无。

## T-059 | 2026-05-05 | mine 技能接入 StairBFSPlanner

- 摘要: mine 接入真实 runtime 挖掘、背包增量和失败语义。; 通过。mine 成功以目标掉落/背包 diff 为准,不是动作没抛错;后续大量实服边界由 T-080/T-081R 等修复。; mine 保持强语义单动作,工具和掉落事实来自 runtime。冲突: 无。

## T-060 | 2026-05-05 | Toolchain ensure 函数组

- 摘要: 建立早期工具链 ensure 能力,为缺工具/缺工作台/缺材料恢复提供基础。; 通过。具体函数组后续由 T-069B 收敛为通用 ensure + facts port。; 工具链恢复先接通链路,后续再删除 prompt 可见的具体 ensure 函数。冲突: 过渡已收敛。

## T-061 | 2026-05-05 | sandbox TS 可编程 API 与失败上下文

- 摘要: 建立沙箱 TS 执行、能力注入和失败上下文输出。; 通过。沙箱能执行规划代码并把动作结果/错误暴露给上层;后续由 T-082 拆分组件。; 沙箱只提供受控语义能力,不暴露 Mineflayer 对象。冲突: 无。

## T-062 | 2026-05-05 | TaskResultReporter 终态主动汇报

- 摘要: 任务完成/失败/中断后主动向用户汇报。; 通过。早期 reporter 生成终态文本;后续由 T-086 收敛为只消费统一事实摘要。; 汇报发生在任务终态,不让 skill 层直接对用户拼最终话术。冲突: 无。

## T-063 | 2026-05-05 | SkillResultSummary 统一契约

- 摘要: 统一技能结果摘要结构,供 BotWorker、sandbox、reporter 消费。; 通过。早期结果摘要契约落地;后续由 T-085/T-088 严格化完成证明。; summary 是事实投影,不是补成功的兜底层。冲突: 无。

## T-064 | 2026-05-05 | LLM 调用分段 metrics 诊断

- 摘要: 对 triage/plan/chat/report 等 LLM 阶段记录 token、延迟和错误。; 通过。早期 LLM diagnostics 接通;后续由 T-075R 升级为生产指标。; 诊断旁路写入,不改变 LLM 路由结果。冲突: 无。

## T-081R | 2026-05-11 | ensure 默认验收后的 runtime/transport 实服返修

- 摘要: ensure 默认验收后连续修复 cutTree/mine/goTo/place/collect/pathfinding/cancel 等实服问题。; 通过。收敛自研 terrain router、progress watchdog、placeUp 清障、self-placed memory、取消信号标准化、ensure preflight、placement target/approach 拆分等;多轮实服验证通过。; 统一 TS code + 语义函数 + BotActor 单写者保持不变;底层移动可在小步位移中有限使用 pathfinder 辅助,但规划语义仍由自研约束和 runtime 事实控制。冲突: 无。

## T-065 | 2026-05-05 | AsyncDiagnosticSink 旁路写入

- 摘要: 建立异步诊断汇点,让日志/诊断旁路写入不阻塞主流程。; 通过。写入失败可观测但不影响主链路;后续 T-093 统一最小诊断要求。; 诊断 sink 是旁路能力,失败要记录但不得伪造业务结果。冲突: 无。

## T-082 | 2026-05-15 | 沙箱执行链路内部组件拆分

- 摘要: 拆分沙箱大模块为执行编排、API 注入、host call、结果工厂、资源限制、控制和错误归一。; 通过。`execution.ts` 收敛为编排入口,行为不退化;在线路径仍只执行 Plan TS code。预检全绿。; 按职责拆内部组件,不改 Prompt 和执行语义。冲突: 无。

## T-083 | 2026-05-15 | 在线沙箱旧 API 执行面清理

- 摘要: 在线沙箱只暴露顶层语义函数,移除可见 `api.bot/api.chat/api.task/api.owner`。; 通过。`globalThis.api` 不再注入,旧接口负向测试覆盖,`placeCraftingTable()` 不再作为顶层 API。预检全绿。; 删除在线可见旧 API,内部 host bridge 仍作为闭包实现细节。冲突: 无。

## T-084 | 2026-05-15 | runtime transport 运行时端口边界拆分

- 摘要: 拆分 runtime transport 为世界身份、只读状态、资源刷新、事实读取、诊断、动作执行等窄端口。; 通过。共享端口上提到 `core-ports/runtime.ts`,skills/ResourceService/ensure 依赖窄端口;world key 隔离回归通过。; 业务层不依赖完整 transport,世界键读取统一复用 transport 内部函数。冲突: 无。

## T-085 | 2026-05-15 | 统一动作完成语义与条件检查器

- 摘要: 统一动作结果规范化与 until 条件检查,成功必须表示真实状态满足目标。; 通过。语义动作缺完成证明转 `unknown_completion`,数量不足转 `condition_not_met`;task summary 不再默认完成。预检全绿。; 直接动作强语义,ensure 以 baseline/current 条件检查裁决。冲突: 无。

## T-086 | 2026-05-15 | 任务汇报输入收敛

- 摘要: 最终用户汇报只消费统一任务摘要,ReportLLM 只能润色结构化事实。; 通过。新增 `task-report-facts`,Reporter 消费窄事实,ReportLLM 记录模板/事实/润色/最终输出;真实任务汇报保留完成事实。; 确定性模板 + required facts 校验是可靠兜底,LLM 只做短句润色。冲突: 无。

## T-087 | 2026-05-15 | Plan Prompt 收窄与正例重写

- 摘要: Plan Prompt 收窄为硬输出契约、语义 API、少量正确 TS 正例,不灌 MC 百科。; 曾打回 1 次;修复 ensure/cutTree 后 report 变 `logs x1` 的完成证明来源问题。真实 benchmark 与实服任务通过。; Prompt 只教 `reply -> runGoal -> ensure/until -> report`;完成证明在 sandbox 层修,不在 summary/reporter 下游兜底。冲突: 无。

## T-088 | 2026-05-15 | 拆分 skill 公共契约并严格化结果工厂

- 摘要: 将 `core-ports/skills.ts` 拆成目录/参数、结果、toolchain、adapter 窄契约,移除伪造成功默认值。; 曾打回 1 次;mine/collect/cutTree 缺完成证明会 `unknown_completion`,兼容 summary 不再补成功。预检全绿。; `skills.ts` 只作 barrel;资源强语义动作必须携带真实完成证明。冲突: 无。

## T-089 | 2026-05-15 | 收敛 Craft / Placement 职责并保留工具链自动恢复

- 摘要: Craft 只合成,Placement 只放置,Toolchain/Ensure 串联缺工具、缺工作台、缺材料恢复链。; 通过。裸 `place("crafting_table")` 不再偷偷合成;Toolchain 负责 craft table -> place -> 继续原目标。预检全绿。; Placement 不保留递归合成兜底;配方/工作台需求仍来自 Mineflayer/minecraft-data。冲突: 无。

## T-090 | 2026-05-15 | Conversation 规划执行处理器拆分

- 摘要: plan-exec 拆成上下文、continuation、planner、job、dispatch、metrics 等小组件;provider 降级必须诊断。; 通过。`plan-exec.ts` 收敛为编排入口,provider 失败落 `conversation.context_provider_failed`;真实 LLM eval 通过。; 上下文缺失可降级但可观测;LLM/规划失败仍 discarded,不伪装成功。冲突: 无。

## T-091 | 2026-05-15 | runtime / sandbox 兼容出口收敛

- 摘要: 隔离旧 Facade、SkillCall、宽 transport barrel,legacy 只能命名为 legacy/replay/test-only。; 曾打回 1 次;`__sandbox*` 顶层绕过、`placeCraftingTable` 在线能力和普通 transport 宽入口已清理。预检全绿。; 旧入口显式 legacy/test-only,host bridge 只作为沙箱内部闭包协议。冲突: 无。

## T-092 | 2026-05-15 | 测试主路径迁移与 legacy fixture 隔离

- 摘要: 测试默认正确路径改为纯 TS 语义 API、真实完成证明、结构化失败;旧接口只在 legacy 或负向测试。; 通过。旧 SkillCall/executor 测试拆到 legacy 文件,新增 `test-skill-proofs`,scaffold 静态守门防旧接口回流。预检全绿。; 测试 helper 不再猜 MC 掉落或补默认成功,测试体系成为新语义守门。冲突: 无。

## T-093 | 2026-05-15 | 错误与 fallback 策略收口

- 摘要: 清理多层 fallback、空 catch、默认 unknown 成功和重复 recoverable 推断;不可降级错误必须结构化暴露。; 曾打回 1 次;`findBlocks` provider 异常不再伪装成无目标,sandbox terminal failure 统一 recoverable 分类。预检全绿。; recoverable 分类收敛到 core-ports;旁路日志失败可降级但要诊断,主链路 provider 异常必须失败。冲突: 无。

## T-094 | 2026-05-15 | 模块组织与拆分规则文档化

- 摘要: 只改文档,补目录化、平铺、barrel、测试组织规则,让 B 开工和 C 审查有可判定依据。; 通过。工程规范集中细则,架构文档只补口径,WORKFLOW 只补职责点;无代码行为变化,预检全绿。; 规范源集中在 `ENGINEERING_PRINCIPLES.md`,避免三份文档重复维护;目录化采用软门槛。冲突: 无。

## T-095 | 2026-05-15 | runtime transport 的 mining 能力目录化

- 摘要: 将挖掘主入口、planner、executor 收入 `runtime/transport/mining/`,共享 block facts/tool policy 上提到 transport 支撑层。; 曾打回 1 次;修复非 mining 模块反向依赖 `mining/index` 和 public index 暴露 tool policy 的边界问题。typecheck、lint、runtime 定向测试、pre_review 全绿。; mining public surface 只保留 `executeMineflayerMine`,白盒测试可直测 planner/executor/facts;不改挖掘行为和 MC 事实来源。冲突: 无。

## T-096 | 2026-05-15 | runtime transport 的 terrain/navigation 能力目录化

- 摘要: 将 terrain route、navigation、action executor、foot-step、自放置记忆收进 `runtime/transport/terrain/`,由 `terrain/index` 提供受控入口。; 通过。新文件为旧 terrain 能力搬迁并调整相对 import,外部 goTo/collect/place/digBlock/mining 只经 terrain 入口使用能力,内部 router/action/self-memory 未被在线路径绕过。typecheck、lint、runtime 定向测试、pre_review 全绿。; terrain 可被 mining 使用,但不反向知道 mining 任务语义;白盒测试可直测内部 planner/executor。冲突: 无。
