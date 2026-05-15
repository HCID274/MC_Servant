# 项目进度记录

> Reviewer C 在审查通过后追加。一条一个任务。
> 历史批次摘要 (T-001 ~ T-040) 见 `PROGRESS_LEGACY.md`。

## 字段格式

```
## T-XXX | YYYY-MM-DD | 一句话功能描述

- 涉及模块: X, Y
- A 拆解依据: 用户需求 + 引用的架构条目
- C 审查结论: 通过 / 曾打回 N 次 (原因)
- 关键决策: 为什么选 X 不选 Y (从 B 交互记录第四段提炼)
- 架构冲突: 无 / [简述]
```

---

## 进行中 (旧系统遗留)

### T-047B | cutTree (砍树) 单技能验收 + 接入

**状态**: 旧 Manager 工作流下规划,未完成。新工作流启用后,可由 Planner A 重新评估或接续。

**目标**: 在线允许的 skill 集合从 `goTo + collect` 扩到 `goTo + collect + cutTree`;`equip` 与 `mine` 仍保持未启用。

**核心约束**:
- probe 先行: `ts-core/scripts/probes/cut-tree-probe.ts`,实服验证后再并入主程序
- 主程序必须通过 ResourceIndex 查询 / 刷新 (16→32→64),不得绕过缓存或临时全图扫描
- 不得硬编码 MC 树木事实(树种 / 原木 / 树叶 / 工具等级);事实源不能识别 `tree` 时返回 `unsupported_resource_key`
- 单技能门禁: `mine` 与 `equip` 仍返回 `skill_not_enabled`
- 触碰 LLM 链路 → 必须真实 LLM 验收

**后续 (T-047B 之后)**:
- T-048: equip 单技能验收 + 接入
- T-049: mine 单技能验收 + 接入
- T-050: 基础 skill 端到端 demo 收口

---

## 已完成 (新工作流下)

(从这里开始,Reviewer C 通过任务后追加)

## T-072/T-073 | 2026-05-07 | eval JSONL 契约与 LLM 阶段离线评测 runner

- 涉及模块: data contracts（数据契约） eval JSONL,diagnostics（诊断） eval-jsonl,conversation/llm（对话大语言模型） eval-runner,scripts/eval（评测脚本）,Docs/07_EVAL_SPEC.md（评测规格）
- A 拆解依据: 用户要求先定义轻量 eval runner（评测执行器） 的 case/run/attempt/metric JSONL 契约,再用固定样本真实调用 triage/plan/chat/report 并输出 A1/D1/D2/D3/E2 指标;边界明确不接 event_log（事件日志）,不改外部 API,不改 PostgreSQL schema,只落本地 JSONL;触碰 LLM（大语言模型） 必须真实 OpenAI-compatible API（OpenAI 兼容接口） 验收
- C 审查结论: 曾打回 1 次。首轮实现范围和架构边界正确,但真实 eval 日志里超时失败 attempt 在 diagnostics 存在且 usage input_tokens 为 0 时没有回退本地估算,导致 token 记录与 `07_EVAL_SPEC.md` 的"usage 缺失时使用本地近似估算"不一致;返修后成功/失败 attempt 统一通过 `selectInputTokens`（输入 token 选择器） 采信 `input_tokens > 0` 的 usage,否则回退本地估算,并补失败路径回归。当前 `git diff --check`（差异空白检查）通过,`pnpm vitest run src/__tests__/eval-runner-model.spec.ts` 4 passed,`pnpm typecheck`（类型检查）通过,`pnpm lint`（Biome）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,36 个 test file（测试文件）/432 passed（通过）/8 skipped（跳过）;真实 `pnpm eval:llm -- --run-id eval-t073-fix-zero-usage --out logs/eval/eval-t073-fix-zero-usage.jsonl` 产出 6 个 case、13 行 JSONL,A1/D1/D2/D3/E2 均产出,超时失败 attempt 已不再输出 `input_tokens:0`,密钥保持脱敏
- 关键决策: 选择把 A1/D1/D2/D3/E2 作为 metric id（指标编号） 而不是 case id（样本编号）,固定样本采用 `case_*` 命名;A2 因缺少早期 baseline 数据本阶段不输出;D3 通过 `case_triage_chat` 的 `token_saving_probe`（token 节省探针） 做离线路由节省估算;runner 只复用现有 LLM client（客户端） 和 sandbox static precheck（沙箱静态预检）,不执行 sandbox 代码,不进入 PG/API/event_log 链路
- 架构冲突: 无

## T-074R | 2026-05-07 | 生产指标事件契约与自动落盘

- 涉及模块: data contracts（数据契约） production-metrics,diagnostics（诊断） production-metrics,conversation/llm（对话大语言模型） diagnostics,ConversationWorker（对话工作线程）,BotWorker（机器人工作线程）生命周期动作,app entrypoint（应用入口）,Docs/07_EVAL_SPEC.md（评测与生产指标规格）
- A 拆解依据: 用户明确暂停 T-074/T-075 旧的主动 eval 进程自拉 BotActor/Mineflayer runtime 路线,要求改为"每次真实运行自动记录"的生产指标 JSONL 通道;边界限定 diagnostics、data contracts、conversation、workers、runtime 事件摘要,不接 PostgreSQL schema,不接 event_log,不改外部 API,先落本地 JSONL;必须记录 schema_version、event_id、event_type、message_id、task_id、bot_id、root_goal_id、recovery_chain_id、created_at、source、prompt_version、model、stage、ok、error_code、duration_ms、input_tokens、output_tokens
- C 审查结论: 曾打回 1 次。首轮实现已停止 `eval:execution`/`eval:recovery` 主路线并新增生产指标契约,但缺少正常 TS Core + MC 实服链路自动落盘证据;返修后用户用 `/api/message` 投递 `message_id=t074r-prod-mine-stone-1778146690`、内容"请挖 1 个石头",`logs/metrics/2026-05-07/production-metrics.jsonl` 产出 6 行真实闭环: triage LLM、plan LLM、`conversation.plan_accepted`、`task.started`、`task.failed`、report LLM。Reviewer 复核字段完整无缺失,终态为 `runtime_mine_failed` 但不是 actor readiness failure,符合"真实线上调用自动落盘"验收。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest 2 个文件 33 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /435 passed/8 skipped;真实 `pnpm eval:llm -- --run-id eval-t074r-review-live --out logs/eval/eval-t074r-review-live.jsonl` 已跑通并记录失败 attempt 的非零 input_tokens
- 关键决策: 选择把执行/恢复指标的主数据来源切到生产链路自动写入的 `logs/metrics/YYYY-MM-DD/production-metrics.jsonl`,而不是继续维护主动执行 eval CLI;旧 LLM 离线 runner 保留用于 triage/plan/chat/report 固定样本验证。Plan prompt 中清理 `stone -> cobblestone`、`iron_ore -> raw_iron` 掉落事实硬编码,让 mine/cutTree 等语义 API 只表达动作,掉落、工具和完成判断交给执行层与 Minecraft 事实源
- 架构冲突: 无

## T-075R | 2026-05-07 | LLM 与 Plan 输出生产指标自动记录

- 涉及模块: conversation/llm（对话大语言模型） client/parser/stage/types,plan parser（规划解析器） 门禁分类,sandbox static precheck（沙箱静态预检）只读复用,diagnostics（诊断） production metrics 与汇总,workers（工作线程） LLM diagnostic 到生产指标映射,Docs/07_EVAL_SPEC.md（评测与生产指标规格）
- A 拆解依据: 用户要求在 T-074R 的生产指标自动落盘基础上,每次 triage/chat/plan/report 调用后自动记录延迟、token、Plan 解析结果与门禁/静态预检失败原因;边界限定 conversation/llm、plan parser、sandbox static precheck、diagnostics,需真实 LLM 验收;输出语义化指标名 `plan_code_strict_parse_success_rate`、`plan_code_only_success_rate`、`plan_gate_failure_rate`、`plan_static_precheck_failure_rate`、`triage_average_latency_ms`、`plan_average_latency_ms`、`chat_average_latency_ms`、`report_average_latency_ms`、`llm_input_tokens_total`、`llm_output_tokens_total`
- C 审查结论: 通过。实现把 Plan parser 失败分为严格 JSON 解析失败、非唯一 `code` 字段失败与规划门禁失败,`executeStage` 统一把阶段 meta 提升为 `ConversationLlmDiagnosticRecord.plan_metric`,生产指标事件新增 `plan_parse_ok`、`plan_code_only_ok`、`plan_gate_failure_type`、`plan_static_precheck_failure_type`,汇总函数只消费生产 JSONL 契约行并产出 10 个指定指标名。Reviewer 复核 `logs/metrics/2026-05-07/production-metrics.jsonl` 中 `t075r-prod-plan-metrics-1778147681` 与 `t075r-prod-chat-metrics-1778147752` 的真实生产链路,覆盖 triage、plan、report、chat 的 `llm.stage`,Plan 行含 `plan_parse_ok:true`、`plan_code_only_ok:true` 且门禁/预检失败为 `null`;实际日志 16 行事件无缺字段,可汇总全部 10 个指标。`git diff --check` 通过,定向 Vitest 2 个文件 36 passed,`pnpm typecheck` 通过,`pnpm lint` 通过,`bash scripts/pre_review.sh` 全绿,36 个 test file /438 passed/8 skipped
- 关键决策: 选择在 LLM diagnostic 层记录 Plan 输出质量,再由 `workers/production-metrics` 映射到生产指标 JSONL,而不是让汇总逻辑反向解析 LLM 日志文本或耦合 ConversationWorker 内部状态;静态预检只复用既有 `checkSandboxSourceStaticPolicy` 作为只读分类,不改变生产执行门禁语义
- 架构冲突: 无

## T-076R | 2026-05-07 | 执行链路生产指标自动记录

- 涉及模块: workers（工作线程） BotWorker 生命周期到生产指标映射,diagnostics（诊断） production metrics 与执行汇总,data contracts（数据契约） production-metrics,task result summary（任务结果摘要）步骤数来源,Docs/07_EVAL_SPEC.md（评测与生产指标规格）
- A 拆解依据: 用户要求在 T-074R 的生产指标自动落盘基础上,每次真实 BotWorker 任务终态自动记录执行状态、耗时、步骤数、失败码、是否人工干预;边界限定 workers、sandbox、runtime、skills、diagnostics、task result summary,需实服验证;输出语义化指标名 `execution_task_run_count`、`execution_no_manual_completion_rate`、`execution_average_duration_minutes`、`execution_average_step_count`、`execution_failed_count`、`execution_interrupted_count`、`execution_failure_code_count_by_code`
- C 审查结论: 通过。实现扩展生产指标事件契约,新增 `terminal_status`、`step_count`、`is_manual_intervention`,BotWorker 生命周期事件从既有 `TaskHistoryStatus`、`total_steps`、`duration_ms`、`error_code`、`interrupt_source` 映射执行终态指标,汇总函数只消费 `source=bot_worker`、`stage=execution` 且 `terminal_status != null` 的生产 JSONL 行并产出 7 个指定指标。Reviewer 复核 `logs/metrics/2026-05-07/production-metrics.jsonl` 中 `t076r-prod-exec-metrics-1778149059` 的真实生产链路,包含 `task.started` 与 `task.completed`,终态行 `terminal_status:"completed"`、`step_count:2`、`is_manual_intervention:false`、`duration_ms:1022`;当天日志可汇总执行终态 2 条,`execution_task_run_count=2`、`execution_no_manual_completion_rate=1`、`execution_average_step_count=2`。`git diff --check` 通过,定向 Vitest 1 个文件 9 passed,`pnpm typecheck` 通过,`pnpm lint` 通过,`bash scripts/pre_review.sh` 全绿,36 个 test file /439 passed/8 skipped
- 关键决策: 选择在 `workers/production-metrics` 里把 BotWorker 生命周期动作映射为生产指标事件,而不是让 diagnostics 反向读取 runtime 或 sandbox 内部状态;步骤数直接来自执行结果摘要里的 `total_steps`,人工干预只按已有 control 中断源判定,不新增生产执行逻辑或 Mineflayer 事实规则
- 架构冲突: 无

## T-077R | 2026-05-07 | 失败恢复链路关联与自动统计

- 涉及模块: Failure Capsule（失败胶囊） 与 recent context（最近上下文）隐藏元数据,conversation worker（对话工作线程） continuation Plan（继续规划） 链路,BotWorker（机器人工作线程） terminal summary（终态摘要） 到生产指标透传,diagnostics（诊断） production metrics 汇总,data contracts（数据契约） production-metrics,Docs/07_EVAL_SPEC.md（评测与生产指标规格）
- A 拆解依据: 用户要求把失败任务、Failure Capsule、后续 continuation Plan、二次执行串成同一条恢复链,支持直接统计 `recoverable_failure_count`、`recoverable_replan_success_rate`、`average_replan_count_to_success`、`implementation_blocker_count`、`unknown_failure_count`;边界限定 Failure Capsule、recent context、conversation worker、BotWorker terminal summary、diagnostics,前置依赖 T-074R/T-075R/T-076R,且需真实 LLM 验收
- C 审查结论: 曾打回 1 次。首轮实现已能在一次失败后把 continuation Plan、二次 `task.started`、二次 `task.completed` 对齐到同一 `recovery_chain_id`,但 continuation 再次失败时 recent context sink 会重新生成链路并把 `replan_count` 重置为 0,导致 2 次及以上重规划无法计入同一恢复链;返修后 `BrainTaskEventWorkerTask` payload 透传 `recovery_chain_id`/`replan_count`,`recent-context-sink` 优先保留 payload 元数据,缺失时才按根失败生成新链并置 0,并补“continuation 失败后再次 continuation 不换链且计数 1→2”的回归。Reviewer 复核 `logs/metrics/2026-05-07/production-metrics.jsonl` 中 `t077r-root-1778150401` 真实链路: 根 `task.failed` 为 `recovery_class:"recoverable"`、`replan_count:0`,后续 `conversation.plan_accepted`、`task.started`、`task.completed` 使用同一 `recovery_chain_id` 且 `replan_count:1`;汇总输出 `recoverable_failure_count=1`、`recoverable_replan_success_rate=1`、`average_replan_count_to_success=1`、阻塞/未知计数为 0。`git diff --check` 通过,定向 Vitest `conversation-worker-runtime-model.spec.ts` 34 passed,`pnpm typecheck` 通过,`pnpm lint` 通过,`bash scripts/pre_review.sh` 全绿,36 个 test file /441 passed/8 skipped
- 关键决策: 选择把恢复链 ID 与重规划次数作为隐藏元数据沿既有 `ExecJob -> lifecycle event -> enqueue_brain -> recent context` 通道透传,而不是把链路状态写进 prompt 文本、PG schema、event_log 或额外生产门禁;Failure Capsule 渲染仍只暴露最小失败事实和 retry guard,生产指标汇总只消费 JSONL 契约事件
- 架构冲突: 无

## T-078R/T-079R | 2026-05-07 | 生产指标汇总脚本与固定样本 benchmark 降级

- 涉及模块: diagnostics（诊断） production metrics report（生产指标报告） 与汇总函数,scripts/metrics（指标脚本）,scripts/eval（固定样本 benchmark 脚本）,data contracts（数据契约） eval metric 名称,Docs/07_EVAL_SPEC.md（评测与生产指标规格）,package scripts（命令入口）
- A 拆解依据: 用户明确新主线为“生产指标自动落盘 + 汇总脚本”,要求 T-078R 读取生产指标 JSONL,按时间窗口、模型、prompt 版本、任务类型汇总所有语义化指标,输出控制台表格、汇总 JSON 和可贴进简历的中文摘要,支持 `--from`、`--to`、`--bot-id`、`--model`、`--prompt-version`、`--out`;T-079R 要求固定样本主动评测降级为可选 benchmark,不得再自己新建 Mineflayer runtime,执行类 benchmark 只能投递在线队列或在线 API,反事实 token 节省只放在 benchmark 中
- C 审查结论: 通过。实现新增 `createProductionMetricReport` 与 `pnpm metrics:summary`,默认读取 `logs/metrics/**/production-metrics.jsonl`,在总体、模型、prompt 版本、任务类型四类分组下复用 T-075R/T-076R/T-077R 的 LLM、执行、恢复语义化汇总函数,并输出表格、JSON 文件和中文摘要;固定样本 runner 改为 `pnpm benchmark:llm`,仍保留 `eval:llm` 兼容别名,但输出文案与 metric id 均改成 benchmark 语义名。Reviewer 复核 `pnpm metrics:summary -- --from 2026-05-07 --to 2026-05-07 --out logs/metrics-summary/review-t078r.json` 输出 `production_metric_events=0` 且 JSON schema 为 `ts-core.production-metric-report.v1`;真实 `pnpm benchmark:llm -- --run-id benchmark-review-t079r-live --out logs/eval/benchmark-review-t079r-live.jsonl` 产出 13 行、6 个 attempt、5 个 metric,无 `A1/D1/D2/D3/E2/B1/B2/B3/C1/C2` 旧编号,Plan 超时样本按失败 attempt 记录且 input_tokens 非 0。数据库清理复核显示运行态表 `chat_messages/event_log/task_history/task_events/bot_memory/memory_candidates/memory_audit/task_summaries/session_summaries` 均为 0;基础表当前仅 `bots=1`,不影响本任务生产指标新基线。`git diff --check` 通过,定向 Vitest 2 个文件 12 passed,`pnpm typecheck` 通过,`pnpm lint` 通过,`bash scripts/pre_review.sh` 全绿,37 个 test file /443 passed/8 skipped
- 关键决策: 选择让汇总脚本只消费生产 JSONL 契约事件并复用既有汇总函数,不反向解析日志文本、不接 PG schema、不接 event_log;固定样本 LLM runner 只保留为回归 benchmark 与反事实 `chat_route_plan_input_token_saved_ratio` 数据来源,不再作为简历主指标来源,也不恢复旧 `eval:execution`/`eval:recovery` in-process harness
- 架构冲突: 无

## T-071D | 2026-05-07 | terrain-router 水平挖穿成本与 A* 搜索诊断修复

- 涉及模块: runtime/transport（运行时传输层） terrain-router（地形路由）,runtime Mineflayer（Minecraft 协议客户端）回归测试
- A 拆解依据: 用户实服发现 `goTo`（移动） 在同水平障碍前没有走水平挖穿,而是 A* 搜索到 `expanded=14000/open=61696` 后失败;用户明确要求优先按根因降低挖掘代价并加诊断,不要先做搜索走廊剪枝或单纯调大展开预算
- C 审查结论: 通过。`digWalk`（水平挖通） 动作本身已存在,失败根因是 terrain change（地形改动）成本远高于 walk（行走）,导致 A* 在大量便宜绕路/垫高候选中耗尽 `maxExpanded`（最大展开数）;当前实现把 terrain change cost（地形改动成本）收敛为 `COST_TERRAIN_CHANGE_BASE=24` + `COST_TERRAIN_CHANGE_PER_BLOCK=6`,并在 `terrain_bfs_no_path`（地形 BFS 无路径） diagnostics（诊断）中输出 cost 配置。定向 Vitest（测试框架）2 个 terrain-router（地形路由）测试通过,`git diff --check`（差异空白检查）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,35 个 test file（测试文件）/428 passed（通过）/8 skipped（跳过）;B 已用实机坐标 `去坐标 -20 107 -214` 验证任务完成
- 关键决策: 选择降低水平挖穿进入 A* 搜索的相对成本,而不是扩大 `maxExpanded` 或先引入 corridor（搜索走廊）;同时保留 walk（行走）成本最低,并用"短距离可绕行时不挖墙"回归测试防止 bot 无脑破坏地形
- 架构冲突: 无

## T-071C | 2026-05-07 | terrain/mine BFS 净空语义与 digStepDown 执行契约收敛

- 涉及模块: runtime/transport（运行时传输层） terrain-router（地形路由）/mine-bfs（挖掘 BFS）/terrain-action-executor（地形动作执行器）/mine-action-executor（挖掘动作执行器）,runtime Mineflayer（Minecraft 协议客户端）回归测试
- A 拆解依据: 用户按第一性原理要求把 BFS 边定义为"bot 真实能执行的一步动作",平移只要求 2 格身体净空,阶梯/跳跃/垫高要求当前 foot 3 格与终点 foot 3 格净空;不得在动作分支里散写 `fy + 2`/`fy + 3`,mine-bfs（挖掘 BFS） 与 terrain-router（地形路由）必须保持同一动作语义,并保留"每次挖掘必须验证方块变化后才继续"的实服修正
- C 审查结论: 曾打回 1 次。首轮返修已把 `BODY_CLEARANCE=2` 与 `JUMP_CLEARANCE=3` 抽成 helper（辅助函数）,修正 walk/digWalk/drop1/jumpUp/digStepDown/digStepUp/placeUp1（行走/挖通/下落/跳上/阶梯下挖/阶梯上挖/垫高） 净空语义,但 `mine-action-executor`（挖掘动作执行器） 的 `digStepDown`（阶梯下挖）仍按 `jump:false` 执行,与 planner（规划器） 和 terrain executor（地形执行器） 的"跳跃阶梯"语义不一致;返修后 `mine-action-executor` 同步为 `jump:true`,并补最小回归断言 jump 控制按下与释放。当前 `pnpm typecheck`（类型检查）通过,`git diff --check`（差异空白检查）通过,定向 Vitest（测试框架）`mine-action digStepDown` 1 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,35 个 test file（测试文件）/426 passed（通过）/8 skipped（跳过）
- 关键决策: 选择把净空规则抽成 `clearancePositions`/`hasClearance`/`collectClearanceDigs`（净空位置/净空判断/净空挖掘收集）,而不是继续在每个动作里复制坐标偏移;选择让 `placeUp1`（垫高一格）携带 `digs`（预清理方块）并在 executor（执行器） 里先挖再垫,不新增并行动作类型;选择同步 mine 与 terrain 两套 planner/executor（规划器/执行器） 契约,避免"测试绿但实服假动作"再次出现
- 架构冲突: 无

## T-071B | 2026-05-07 | ReportLLM（汇报大语言模型）终态润色与 terrain goTo/mine（地形移动/挖掘）实服返修

- 涉及模块: workers（工作线程） TaskResultReporter（任务结果汇报器）/TaskResultSummary（任务结果摘要）,conversation/llm（对话大语言模型） report stage（汇报阶段）/prompt（提示词）/diagnostics（诊断）,app entrypoint（应用入口）,runtime/transport（运行时传输层） mine（挖掘）/goTo（移动）/terrain router（地形路由）/terrain action executor（地形动作执行器）/mine fact reader（挖掘事实读取器）,相关回归测试
- A 拆解依据: 用户要求 T-071 在任务完成、失败或中断后由 ReportLLM（汇报大语言模型）在不篡改 result_summary（结果摘要）事实的前提下润色终态汇报,LLM（大语言模型）不可用或事实校验失败时回退确定性模板;后续实服连续打回暴露 mine（挖掘）石头路径、goTo（移动）从矿坑返回、Mineflayer（Minecraft 客户端库） 垫高 timing（时机）不稳定等 runtime/transport（运行时传输层）问题,用户明确要求先修底层移动/挖掘能力并实机验证
- C 审查结论: 曾打回 1 次。首轮 ReportLLM（汇报大语言模型）实现本身具备模板先行、短文本事实校验、report 阶段 diagnostics（诊断）与 fallback（回退）,但 runtime（运行时）返修里新增的 `mine-bfs`（挖掘 BFS）/`terrain-router`（地形路由）/executor（执行器） 直接散落 `air/lava/bedrock`（空气/岩浆/基岩） 等 MC（Minecraft）方块事实判断,属于"测试绿、工程规范红";返修后方块事实收敛到 `MineBlockFactReader`（挖掘方块事实读取器）,`mine-bfs`/`terrain-router`/`mine-action-executor`/`terrain-action-executor` 只消费 `isAirBlock`/`isHazardBlock`/`isSupportBlock`/`isDiggableBlock`（空气/危险/支撑/可挖判断）抽象。当前 `git diff --check`（差异空白检查）通过,定向 Vitest（测试框架）2 个文件 68 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,35 个 test file（测试文件）/414 passed（通过）/8 skipped（跳过）;B 已补真实本地 OpenAI compatible API（OpenAI 兼容接口） report（汇报）成功/超时回退验证,并实机验证 `[svs]挖1个石头` 与垫高 timing（时机）队列
- 关键决策: 选择"确定性模板 -> ReportLLM 润色 -> required_facts（必保事实）校验 -> 回退模板"而不是让 LLM（大语言模型）直接生成终态事实;选择用自研 terrain router（地形路由）接管 goTo（移动）中的 walk/drop1/jumpUp/placeUp1/digWalk/digStep（行走/一格下落/跳上一格/垫高/挖通/阶梯挖）动作,不再依赖 mineflayer-pathfinder（Minecraft 寻路库）的一格塔;选择把方块事实集中在 `mine-block-facts.ts`（挖掘方块事实适配器）而不是在多个 planner/executor（规划器/执行器）里复制判断
- 架构冲突: 无

## T-080 | 2026-05-07 | mine/goTo 脚位移动内核收敛与挖矿掉落恢复

- 涉及模块: runtime/transport（运行时传输层） foot-step/mine-action-executor/terrain-action-executor/mine-bfs/mine,skills（技能层） mine,app bootstrap（应用装配）,conversation triage（对话分诊） prompt 与确定性归一化,workers（工作线程） ConversationWorker runtime,相关回归测试
- A 拆解依据: 用户实服发现 `[svs]去挖10个石头,然后回来` 连续暴露 not_equipped 误失败、mine 旧移动底盘跑飞、下挖脚位水平到位但 Y 未落下、180 度折返矿道、固定 8 次挖掘上限导致 7/10 停止、掉落物偏到矿洞另一侧后 `await mine(...)` 没有按背包 diff 继续完成等问题;用户明确要求按第一性原理查决定性证据,修复要优雅、符合 SOLID/DRY,不能把 MC 事实硬编码回代码或 prompt,并保留 `mine`/`goTo` 两个对外高内聚接口、只合并底层重复地形执行能力
- C 审查结论: 通过。实现删除 skill 层 `stone -> pickaxe` 工具硬编码,工具准备回到 runtime `mine-tool-policy` 基于 Mineflayer registry/minecraft-data 的事实策略;新增 `foot-step.ts` 作为共享脚位移动原语,`mine-action-executor`、`terrain-action-executor` 与 mine legacy 队列移动都改为脉冲移动、越界保护、Y 匹配后才允许判定抵达,并保留 digStepDown 的 jump 语义;`mine-bfs` 禁止连续 180 度反向扩展且 state key 纳入方向;动态 mine 最大尝试数随请求数量增长;`skills/mine.ts` 在 `drop_not_obtained` 且 runtime 提供 `expected_drop_name/current_position` 时调用既有 collect,再按真实背包增量计算剩余数量续挖。Reviewer 复核没有新增 PG schema/event_log/API 变更,没有在 prompt 或 skill 写死掉落事实;`git diff --check` 通过,定向 Vitest 4 个文件 141 passed,`pnpm typecheck` 通过,`pnpm lint` 通过,`bash scripts/pre_review.sh` 全绿,37 个 test file /450 passed/8 skipped。真实生产日志 `e3c2fe58-2caf-49c7-bb29-0276bf9169c1` 显示 triage 只输出 action,Plan 解析通过,`task.completed` 且 `step_count=4`,report 事实为 `cobblestone x10` 并返回主人,耗时约 34s
- 关键决策: 选择保留 `goTo(...)` 与 `mine(...)` 两个业务接口,避免把调用方暴露给复杂地形动作细节;只把两者共同的“走到目标 foot block”执行内核抽为 `stepToFoot`,让 DRY 发生在同一变化原因的底层移动能力上。选择让 mine skill 编排 `mine -> collect -> 剩余数量续挖`,但掉落名和位置只从 runtime 结构化错误读取,不在 skill 层维护 Minecraft 掉落百科;背包容量满或 collect 无增量仍按结构化失败暴露给恢复链路
- 架构冲突: 无

## T-070B | 2026-05-06 | runGoal（目标运行）/until（完成条件）/report（汇报）任务生命周期闭环

- 涉及模块: sandbox（沙箱） execution（执行器）/contracts（契约）,core-ports/skills（技能端口）,workers（工作线程） TaskResultSummary（任务结果摘要）/TaskResultReporter（任务结果汇报器）,conversation/llm（对话大语言模型） plan prompt（规划提示词）/parser（解析器）/stage（阶段执行器）/client（客户端）,runtime/transport（运行时传输层） movement policy（移动策略）/goTo（移动）/collect（捡拾）/dig-block（按坐标挖掘）/mine queue（挖掘队列）,相关回归测试
- A 拆解依据: 用户要求建立 `reply -> runGoal -> ensure/until -> report`（开场回复到目标运行到确保/完成条件到终态汇报）生命周期,每个 TS（TypeScript）任务必须有开场回复、目标执行、真实完成条件、终态汇报和结构化结果摘要;边界限定 sandbox（沙箱）执行生命周期、BotWorker（机器人工作线程）任务终态、TaskResultReporter（任务结果汇报器）、SkillResultSummary（技能结果摘要）、GoalResult（目标结果）、until（完成条件）判断与 inventory（背包）事实,不得绕过 TaskResultReporter（任务结果汇报器）
- C 审查结论: 曾多次实服打回后通过。首轮 T-070（任务编号） 已收敛到 `runGoal`（目标运行）/`report(task)`（任务汇报） 形态,但多任务把 `cutTree`（砍树）错误包进 `ensure`（确保） 后触发 `unsupported_capability`（不支持能力）;返修后 Plan prompt（规划提示词） 明确 `cutTree`（砍树） 直调并检查 `ok`（成功标志）,`mine stone`（挖石头） 仍走 `ensure(async () => mine(...), until.gained(...))`（确保挖掘直到获得）。后续实服暴露 mineflayer-pathfinder（Minecraft 寻路库） 一格塔垫高不稳定、Plan search（规划检索）多轮拖死、mine（挖掘）方块边界起点误判等问题;当前实现用统一 movement policy（移动策略） 禁用 `allow1by1towers`（一格塔） 并给 goTo/collect（移动/捡拾） 高成本挖填,Plan search（规划检索） 由 prompt（提示词）约束语义且代码层最多执行一次,search（检索） 空 assistant（助手文本） 时无工具重试, mine queue（挖掘队列） 从当前坐标附近和相邻高度筛选可站立起点并记录 diagnostics（诊断）。用户已实服确认多任务与边界站位挖石头通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,定向 Vitest（测试框架）4 个文件 148 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,34 个 test file（测试文件）/407 passed（通过）/8 skipped（跳过）;B 已补真实 OpenAI compatible API（OpenAI 兼容接口）验证,多动作指令生成 `reply`（回复）+`runGoal`（目标运行）+`cutTree`（砍树）+`ensure(mine stone)`（确保挖石头）+`goTo(owner.position)`（回主人位置）+`report(task)`（任务汇报）
- 关键决策: 选择把终态事实写成 `GoalResult`（目标结果） 并由 TaskResultSummary/TaskResultReporter（任务结果摘要/任务结果汇报器）统一消费,而不是让沙箱代码直接拼最终聊天;选择禁止 mineflayer-pathfinder（Minecraft 寻路库） 不稳定的一格塔跳垫并提高挖填成本,而不是 patch（补丁修改） 第三方库源码;选择修 mine queue（挖掘队列） 起点离散化,而不是放宽 StairBFS（阶梯广度优先搜索） 安全规则
- 架构冲突: 无

## T-069B | 2026-05-06 | 通用 ensure（确保）依赖解析器与事实端口收敛

- 涉及模块: core-ports/skills（技能端口契约）,skills/toolchain-ensure（工具链确保解析器）,sandbox（沙箱） execution（执行器）/contracts（契约）/facade（门面）,runtime（运行时） BotActor（机器人执行代理）/transport（传输层） facts（事实端口）,app bootstrap（应用装配）,conversation/llm（对话大语言模型） plan prompt（规划提示词）/triage prompt（分诊提示词）,相关回归测试
- A 拆解依据: 用户要求把暴露给 LLM（大语言模型）的具体 ensure（确保）函数组替换为唯一 `ensure(action, condition)`（确保动作与条件）,由系统根据 `not_equipped`（未装备）/`missing_materials`（缺材料）/`missing_crafting_table`（缺工作台）等结构化失败码和 Minecraft（我的世界）事实源补局部前置;边界限定 toolchain ensure（工具链确保）、core-ports（核心端口）、sandbox（沙箱）、BotActor（机器人执行代理）、craft/place/equip/mine/cutTree（合成/放置/装备/挖掘/砍树）组合与测试,不得新增 `demoMineIron()`（演示挖铁） 或在 ensure（确保）本体写死配方、掉落、工具等级
- C 审查结论: 曾打回 1 次 (首次返修虽然测试全绿,但 `toolchain-ensure.ts`（工具链确保解析器） 内仍硬编码 `iron_ore -> stone_pickaxe`（铁矿到石镐）、`stone -> wooden_pickaxe`（石头到木镐）、`cobblestone`（圆石）来源与可合成白名单,属于"测试绿、架构红");二次返修后通过。当前 `ensure`（确保语义）只消费 `ToolchainEnsureFacts`（确保事实端口）返回的装备需求、物料来源、合成可用性与工作台事实,事实实现由 runtime transport（运行时传输层）从 bot registry（机器人注册表）/recipe（配方）/drops（掉落）/harvestTools（采掘工具）读取;旧具体 ensure（确保）函数不再暴露给 Plan prompt（规划提示词）或 sandbox bot facade（沙箱机器人门面）。用户实服确认 `[svs]回来` 分诊返修通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,定向 Vitest（测试框架）6 个文件 136 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,34 个 test file（测试文件）/400 passed（通过）/8 skipped（跳过）;B 已补真实 OpenAI compatible API（OpenAI 兼容接口）验证,"挖5个石头"生成 `ensure(async () => mine("stone", 5), until.gained("cobblestone", 5))` 且无手写 pickaxe（镐）链
- 关键决策: 选择"ensure（确保）只编排、事实端口负责读 Minecraft（我的世界）事实",而不是把木头到工具到矿物的链路藏成 demo（演示）函数或写在 ensure（确保）内部;Plan prompt（规划提示词）用 `ensure(async () => mine(...), until.gained(...))` 表达目标动作与完成条件,依赖补齐由结构化失败触发。分诊问题按用户边界只改 triage prompt（分诊提示词）,不扩展 chat（闲聊）输出防线
- 架构冲突: 无

## T-067 | 2026-05-06 | Plan（规划）输出契约收敛为唯一 code（代码）任务

- 涉及模块: conversation/llm（对话大语言模型） plan prompt（规划提示词）/parser（解析器）/client（客户端）,ConversationWorker（对话工作线程）,ExecJob（执行任务）契约,runtime（运行时） BotActor（机器人执行代理）/scaffold（脚手架）,sandbox（沙箱）请求契约,data（数据层） task_history（任务历史）/task_card（任务卡）,diagnostics（诊断）摘要,相关回归测试
- A 拆解依据: 用户要求把 Plan（规划）在线输出统一为 `{ "code": "..." }`,删除旧 `skill_call`（技能直调）/`sandbox_code`（沙箱代码）双路径,简单任务和复杂任务都进入同一套 TS（TypeScript）代码生命周期;边界限定 conversation/llm（对话大语言模型）、Plan parser（规划解析器）、ConversationWorker（对话工作线程）、ExecJob（执行任务）契约、runtime scaffold（运行时脚手架）、事件、recent context（最近上下文）、diagnostics（诊断）与测试,不删除底层 skill（技能）模块
- C 审查结论: 曾打回 1 次 (首轮只把 Plan（规划）解析为 `code`（代码）,但内部 `ExecJob`（执行任务）仍保留 `SkillCallJob | SandboxCodeJob`（技能调用任务或沙箱代码任务）双类型语义);返修后通过。在线 Plan（规划）只解析 `{code}`（代码对象）,拒绝 `type`/`skill`/`params`/`skill_call`/`sandbox_code` 等旧字段;ConversationWorker（对话工作线程）投递 `type: "code"`（代码类型）,runtime（运行时）/task_history（任务历史）/task_card（任务卡）/event（事件）/summary（摘要）均写 code（代码）语义。`git diff --check`（差异空白检查） 通过,`pnpm typecheck`（类型检查） 通过,`pnpm test`（测试命令） 34 个 test file（测试文件）通过,395 个 test（测试）通过,8 个 skipped（跳过）,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;旧任务类型写入搜索无命中。B 已补真实 OpenAI compatible API（OpenAI 兼容接口） 验证,"砍 12 个木头"、"挖 5 个石头"、"挖铁矿" 均返回 `code`（代码）+ diagnostics（诊断）
- 关键决策: 选择真正把执行层任务类型收敛为 `ExecutionTaskKind.Code`（代码任务类型）,而不是保留"外部 code（代码）、内部 sandbox_code（沙箱代码）"的过渡命名;底层 skill（技能）执行能力保留为 TS（TypeScript）代码内 `api.bot.*`（机器人应用接口）能力复用,旧字段只留在 Plan（规划）拒绝清单和负向测试中
- 架构冲突: 无

## T-068B | 2026-05-06 | Semantic API（语义接口）注入与 cutTree（砍树）执行桥接返修

- 涉及模块: sandbox（沙箱） execution（执行器）/contracts（契约）,core-ports/sandbox（沙箱端口）,runtime（运行时） BotActor（机器人执行代理）/transport（传输层） digBlockAt（按坐标挖掘）,BotWorker（机器人工作线程）,app entrypoint（应用入口）,conversation/llm（对话大语言模型） plan prompt（规划提示词）/parser（解析器）/skill plan table（技能规划表）,相关回归测试
- A 拆解依据: 用户要求让 Plan（规划）生成的 TS（TypeScript）代码直接调用 `reply/runGoal/ensure/until/mine/cutTree/craft/place/equip/collect/goTo/report/search/owner` 等 Semantic API（语义接口）,由执行器映射到底层 Facade API（门面接口） 与 BotActor（机器人执行代理） 单写者入口;边界限定 sandbox（沙箱）执行器、Facade API（门面接口）适配层、BotActor（机器人执行代理）调用入口、ConversationWorker（对话工作线程）任务投递、search（检索）桥接、owner（主人）只读注入与测试,不得暴露 Mineflayer（Minecraft 客户端库）对象或手写 `world_key`（世界键）。后续用户明确 T-069（任务编号）承接通用 `ensure(action, condition)`（确保语义）依赖解析器,T-070（任务编号）承接 `reply -> runGoal -> ensure/until -> report`（任务生命周期）严格闭环
- C 审查结论: 通过。Plan prompt（规划提示词） 已从 `api.bot.*`（底层机器人接口）教学改为顶层 Semantic API（语义接口）教学,真实 LLM（大语言模型）验证 "砍 12 个木头"、"挖 5 个石头"、"挖铁矿" 均返回 `{code, diagnostics}` 且 `hasApiBot:false`、`hasSemantic:true`;sandbox（沙箱）注入顶层函数、owner（主人） deep freeze（深冻结）只读上下文与 search（检索）只读桥;BotActor（机器人执行代理）仍是唯一写入口。cutTree（砍树）实服返修后,`digBlockAt`（按坐标挖掘）删除按出发高度分流,统一高成本靠近目标两格内并禁用 `allow1by1towers`（一格塔）,用户已在 MC（Minecraft）实服确认 `[svs]砍5个木头` 成功。`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,定向 Vitest（测试框架）3 个文件 112 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本）全绿,34 个 test file（测试文件）/399 passed（通过）/8 skipped（跳过）
- 关键决策: 选择"顶层 Semantic API（语义接口）映射到既有 Facade API（门面接口）"而不是新增物理动作实现;保留 sandbox（沙箱）内部 `api.*`（旧接口）别名只作历史代码兼容,不再向 Plan prompt（规划提示词）暴露。砍树路径选择"统一高成本靠近 + 禁止一格塔",不再按 Bot（机器人）出发高度判断是否垫高,因为出发高度不能代表树根挖掘策略
- 架构冲突: 当前 `ensure(target)`（目标式确保）/轻量 `runGoal`（目标运行）/自由文本 `report`（汇报）为 T-068B 过渡形态;用户已明确由 T-069（通用 ensure 依赖解析器）与 T-070（任务生命周期闭环）收敛到文档中的严格 `ensure(action, condition)` 与 `runGoal/until/report` 语义,本任务不按最终形态打回

## T-070 | 2026-05-06 | SkillResultSummary（技能结果摘要）世界键全链路补齐

- 涉及模块: core-ports/skills（技能端口契约）,runtime/transport（运行时传输层） goTo/collect/equip（移动/捡拾/装备）适配器,TaskResultSummary（任务结果摘要）,TaskResultReporter（任务结果汇报器）消费测试,sandbox（沙箱）摘要解析测试,相关 runtime（运行时）回归测试
- A 拆解依据: 用户要求补齐 goTo（移动）、collect（捡拾）、equip（装备） 等早期正式 skill（技能） 成功结果里的 `world_key`（世界键）,与 mine（挖掘）/cutTree（砍树） 保持统一摘要契约;边界限定 core-ports（核心端口）、runtime/transport（运行时传输层）、skills（技能）、BotWorker（机器人工作线程）、reporter（汇报器）、sandbox（沙箱） 与测试,不改 LLM（大语言模型） prompt（提示词）,不得在业务层或 reporter（汇报器） 拼接/猜测世界名
- C 审查结论: 通过。改动沿"结果契约扩展 → runtime transport（运行时传输层）入口透传 → TaskResultSummary（任务结果摘要）消费"收口,未在 skill（技能）层、summary（摘要）层或 reporter（汇报器）层新增世界解析;`git diff --check`（差异空白检查） 通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,34 个 test file（测试文件）/403 个 test（测试）通过;B 已补 server-bridge（服务端桥接） smoke（冒烟）验证,"到我这来"完成汇报显示 `multiworld:resource`（资源世界键） 而非 `unknown`（未知）
- 关键决策: 选择复用 runtime transport（运行时传输层）已有 `createMineflayerWorldKey`（Mineflayer 世界键创建器） 与 `getCurrentWorldKey`（获取当前世界键）语义,让 goTo/collect/equip（移动/捡拾/装备） 与 mine/craft/place（挖掘/合成/放置） 同源透传世界键;TaskResultReporter（任务结果汇报器） 只消费统一摘要并保留异常兜底,不承担修补或猜测职责,避免掩盖上游漏传
- 架构冲突: 无

## T-069 | 2026-05-06 | Failure Capsule（失败胶囊）运行链路与失败后继续规划

- 涉及模块: core-ports/task-result（任务结果端口）,conversation/recent-context（最近上下文）,conversation/llm plan prompt（规划提示词）,ConversationWorker（对话工作线程）,BotWorker action sink（机器人工作线程动作汇点）,TaskResultSummary（任务结果摘要）,相关回归测试
- A 拆解依据: 用户要求把 T-068（Failure Capsule 文档契约）落到运行链路,让 skill_call（技能调用） 与 sandbox_code（沙箱代码） 失败后由执行终态生成短 Failure Capsule（失败胶囊）,完整详情保留 diagnostics（诊断）/ JSONL（结构化日志）,用户说 continuation（继续任务） 时让 Plan（规划）换策略且不得原样重复 retry_guard（重复保护）;边界限定 BotWorker/BotActor（机器人工作线程/机器人执行代理） recent_events（最近事件）投影、TaskResultSummary（任务结果摘要）、ConversationWorker（对话工作线程）、recent context（最近上下文）、Plan prompt（规划提示词） 与 diagnostics（诊断）,不新增 ContextGate LLM（上下文门控大语言模型）,不恢复 T-067（性能探针）
- C 审查结论: 曾打回 1 次 (`latestFailureCapsuleOnly`（仅渲染失败胶囊） 被错误地按"存在 Failure Capsule（失败胶囊）"启用,会让失败后全新任务也丢失完整 sandbox TS（沙箱 TypeScript） recent context（最近上下文）);返修后通过。`git diff --check`（差异空白检查） 通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,34 个 test file（测试文件）/401 个 test（测试）通过;B 已补真实 OpenAI compatible API（OpenAI 兼容接口） 验证,上一轮 `mine("iron_ore",1)`（挖铁矿） 失败后"继续,想办法"会改试 `deepslate_iron_ore`（深层铁矿） 而非原样重复
- 关键决策: 选择由 TaskResultSummary（任务结果摘要） 确定性生成 Failure Capsule（失败胶囊）,再经 recent context（最近上下文）渲染给 Plan（规划）,而不是让 ConversationWorker（对话工作线程）解析错误字符串或让 LLM（大语言模型）总结失败;实现阻塞失败直接模板汇报,可恢复失败才允许 LLM（大语言模型）升级为 sandbox_code（沙箱代码）换策略
- 架构冲突: 无

## T-068 | 2026-05-05 | Failure Capsule（失败胶囊）文档契约对齐

- 涉及模块: Docs/02_RUNTIME_SPEC.md（运行时规格）,Docs/03_SANDBOX_SPEC.md（沙箱规格）,Docs/04_CONVERSATION_SPEC.md（对话规格）,Docs/05_DATA_SPEC.md（数据规格）,Docs/06_AGENTIC_MINE_IRON_SPEC.md（智能挖铁规格）
- A 拆解依据: 用户要求把失败后继续任务改成短 Failure Capsule（失败胶囊）进入 Plan prompt（规划提示词）,完整失败详情进入 diagnostics（诊断）/ JSONL（结构化日志）,并明确 ConversationWorker（对话工作线程）只合并渲染、不制造执行事实;边界限定只改文档契约,不写实现代码,不改 PROGRESS（进度文档）
- C 审查结论: 曾打回 1 次 (Failure Capsule（失败胶囊） 与 existing recent context（已有最近上下文） 关于 sandbox TS（沙箱 TypeScript） 是否注入 prompt（提示词）存在文档冲突);返修后通过。普通非失败轮仍按 recent context（最近上下文）注入 sandbox TS（沙箱 TypeScript）,失败 continuation（继续任务） 场景只注入短 Failure Capsule（失败胶囊）,不注入失败轮完整 last_ts_code（上一段 TypeScript 代码）、完整报错或完整执行结果详情;`git diff --check`（差异空白检查） 通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,34 个 test file（测试文件）/394 个 test（测试）通过;B 已补真实 LLM API（大语言模型接口）验证
- 关键决策: 选择"失败场景例外"而不是删除全部 sandbox TS（沙箱 TypeScript） 注入,避免误伤普通 recent context（最近上下文） 的可读执行链路,同时让失败继续任务只携带短胶囊以控制 token（词元）膨胀;完整失败详情保留在 diagnostics（诊断）/ JSONL（结构化日志） 供开发者排错
- 架构冲突: 无

## T-066 | 2026-05-05 | Plan Prompt v2（规划提示词第二版）与 sandbox_code（沙箱代码）闭环门禁

- 涉及模块: conversation/llm（对话大语言模型） plan prompt（规划提示词）/parser（解析器）,conversation planning tests（规划测试）,app entrypoint（应用入口）异步 brain queue（大脑队列）测试等待点,Docs/04_CONVERSATION_SPEC.md（对话规格文档）
- A 拆解依据: 用户要求重构 Plan Prompt v2（规划提示词第二版）,用规则与短正例/反例约束 LLM（大语言模型）组合 `ensure`（确保）/`craft`（合成）/`place`（放置）/`equip`（装备）/`mine`（挖掘） 等原子能力,禁止 `demoMineIron()`（演示挖铁）隐藏脚本,要求 sandbox_code（沙箱代码）检查 `ToolchainResult`（工具链结果）并最终 `api.chat.report()`（汇报）;边界限定 conversation/llm prompts（对话大语言模型提示词）、skill plan table（技能规划表）、parser（解析器）与 prompt tests（提示词测试）,不新增 demo（演示）脚本,不改技能执行语义
- C 审查结论: 通过;改动未进入 runtime（运行时）/skills（技能）/BotActor（机器人执行代理）执行语义,也未新增 plugin（服务端模组）或 ResourceService（资源服务）改动;prompt（提示词）没有写死配方、掉落、工具等级或路线规划,只约束 LLM（大语言模型）不得猜 MC（Minecraft,我的世界）事实、不得手写 `world_key`（世界键）、不得输出坐标/矿簇/阶梯路线;parser（解析器）仅做最低契约门禁,拒绝明确的 `demoMineIron`（演示挖铁）和缺失 `api.chat.report`（汇报调用）的 sandbox_code（沙箱代码）;`git diff --check`（差异空白检查）、`pnpm typecheck`（类型检查）、`pnpm lint`（代码检查）均通过,相关 Vitest（测试框架） 实际跑 34 个 test file（测试文件）/394 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;真实本地 OpenAI compatible API（OpenAI 兼容接口） 验证中,“砍 12 块木头”输出 `skill_call cutTree({count:12})`,“做一把石镐”输出包含 `ensureStonePickaxeEquipped()`（确保石镐装备）与 `api.chat.report()`（汇报）的 sandbox_code（沙箱代码）,“去挖铁”输出 `ensureStonePickaxeEquipped()`（确保石镐装备）+ `mine("iron_ore",1)`（挖铁矿）+ `mine("deepslate_iron_ore",1)`（挖深层铁矿）兜底且无 `demoMineIron()`（演示挖铁）/`oak_planks`（橡木木板）
- 关键决策: 选择 prompt（提示词）规则 + 短正反例 + parser（解析器）最低门禁的组合,而不是新增硬编码 demo（演示）函数或把 MC（Minecraft,我的世界）事实塞进提示词;单步任务仍优先走 `skill_call`（技能调用）,多步工具链才走 `sandbox_code`（沙箱代码）,并把失败检查与最终汇报作为规划契约,保证后续 TaskResultReporter（任务结果汇报器）与 sandbox（沙箱）失败上下文能闭环
- 架构冲突: 无

## T-OPS-001 | 2026-05-01 | Docker（容器引擎）一键启停与开发模式入口

- 涉及模块: 根目录 Compose（编排）与启停脚本,ts-core（TS 单核心） Dockerfile（镜像构建文件）/ README（说明文档）,旧 Python（旧后端）入口
- A 拆解依据: 用户要求保留三端全 Docker（容器）验收模式,新增 PostgreSQL（数据库）+ Redis（缓存）开发模式;边界限定不动 MC（我的世界）服务端、不触 LLM（大语言模型）链路
- C 审查结论: 通过
- 关键决策: 复用同一份 Compose（编排）与 ts-core/.env（环境变量文件）,用 dev-infra.sh 只拉起 infra（基础设施）并移除 Docker（容器）app（应用）,避免第二份配置漂移
- 架构冲突: 无

## T-NET-001 | 2026-05-01 | 受击 knockback（击退）物理反馈诊断与最小修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,network probe（网络探针）脚本,运行时回归测试
- A 拆解依据: 用户要求诊断并修复 bot（机器人）受击后缺失原版等价 knockback（击退）位移;边界限定可动 Mineflayer（Minecraft 协议客户端）适配层/网络入口/物理桥接,不动 skill（技能）/LLM（大语言模型）/BotActor（机器人执行代理）推理/JAR 插件/server-bridge（服务端桥接）协议,且禁止 fork（分叉）或 monkey-patch（运行时改写） Mineflayer（Minecraft 协议客户端）本体
- C 审查结论: 通过
- 关键决策: 在 Mineflayer（Minecraft 协议客户端）适配层兼容 1.20.3+ `entity_velocity`（实体速度）包的 `velocity: {x,y,z}` 结构,按协议速度单位转换后写回目标实体 velocity（速度）,不修改 Mineflayer（Minecraft 协议客户端）本体也不扩大到服务端协议
- 架构冲突: 无

## T-NET-003 | 2026-05-01 | multiworld（多世界）方块事实可信修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,block fact probe（方块事实探针）,collect（捡拾）实服回归辅助修复,运行时回归测试
- A 拆解依据: 用户要求修复 `multiworld:resource`（资源世界）下方块事实失真;边界允许 adapter（适配层）/observation（观测层）/transport（传输层）方块路径/server-bridge（服务端桥接）/JAR（Java 插件）,禁止触 LLM（大语言模型）/prompt（提示词）/BotActor（机器人执行代理）/skill（技能）规划层/Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (代码量与 10 bot（机器人）并发验收约束不满足);用户本轮明确放宽代码量与并发验收,按功能与架构边界改判通过
- 关键决策: 先用 probe（探针）按 H1（假设一）→ H3（假设三）→ H2（假设二）定位根因,确认 H3（假设三）为 Mineflayer（Minecraft 协议客户端） blocks plugin（方块插件）在 dimension switch（维度切换）后 worldName（世界名）恢复失败;修复选择 adapter（适配层）兼容补丁,不进入 JAR（Java 插件）权威 block change（方块变更）推送路径
- 架构冲突: 无

## T-CTX-RES-0 | 2026-05-02 | ResourceService（世界感知资源服务）接口落地与存量补丁收编

- 涉及模块: world-model（世界模型）接口契约与缓存结构,runtime/transport（运行时传输层）世界解析端口与 WorldReader（世界读取器）,app（应用装配）注入路径,conversation-worker（对话工作器）资源摘要消费,运行时与 world-model（世界模型）回归测试
- A 拆解依据: 用户要求把 ResourceIndex（资源索引）升格为 ResourceService（世界感知资源服务）,公共 API（接口）保持 `query(resource_key)` / `refresh(resource_key, radius)` 扁平形态,内部按 `(world_key, resource_key)`（世界键、资源键）二元组路由;边界限定不改 skill（技能）接口、LLM（大语言模型）协议、observation（观测）数据契约或 Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (缺少跨维度实服回归记录);用户补充确认已在 Nether（下界）与 multiworld（多世界）切换中实测有效,改判通过
- 关键决策: 世界解析唯一实现保留在 transport（传输层）并沿用 `bot.game.dimension`（机器人当前维度）语义;ResourceService（世界感知资源服务）内部持有 `(world_key, resource_key)`（世界键、资源键）缓存桶,业务层只消费扁平 API（接口）;单点方块读取另收敛到极薄 WorldReader（世界读取器）,不把 `blockAt`（方块读取）混入资源聚合服务。未来新功能不得自行处理 `world_key`（世界键）,必须通过 ResourceService（世界感知资源服务）或 transport（传输层）既有端口消费
- 架构冲突: 无

## T-CTX-001 | 2026-05-02 | Planner（规划器） prompt（提示词）注入真实 Bot（机器人）/世界/主人/背包快照

- 涉及模块: conversation/llm（对话大语言模型） prompt（提示词）模板与 planner snapshot context（规划器快照上下文）,app（应用装配）在线 planner（规划器）注入,observation（观测）快照字段,runtime/transport（运行时传输层）只读采样端口/WorldReader（世界读取器）/world-state-reset（世界状态重置）,回归测试
- A 拆解依据: 用户要求用真实 observation（观测）快照替换 `createOnlinePlannerSnapshotContext`（在线规划快照上下文）占位 stub（占位实现）,只落 §7.1 的 `[Bot]`/`[世界]`/`[主人]`/`[装备]`/`[背包]`/`[附近方块]`/`[附近生物]`/`[时间]` 八行,不含 `[背包变化]` 与 `[资源簇]`;边界限定不改 skill（技能）接口、sandbox（沙箱）、LLM（大语言模型）协议结构或 ConversationWorker（对话工作线程）路由,`world_key`（世界键）来源必须走 transport（传输层）端口
- C 审查结论: 曾打回 1 次 (实服切换 world（世界） 后 Mineflayer（Minecraft 协议客户端）实体/玩家/pathfinder（寻路器）状态未刷新);B（实现代理）补充 world-state-reset（世界状态重置）后通过
- 关键决策: planner（规划器）上下文在 app（应用装配）根实时采样,不改 worker（工作线程）路由;`bot.world_key`（机器人世界键）由 transport（传输层）统一读取,observation（观测）只消费字段;主人名取最近 server-bridge（服务端桥接）玩家消息,HTTP（超文本传输协议）直入或无玩家名时按 §7.3 降级为 `[主人] 离线`;世界切换残留通过 transport（传输层）清理 Mineflayer（Minecraft 协议客户端）内部 pathfinder（寻路器）目标、控制状态与旧实体索引,不改 prompt（提示词）或 skill（技能）
- 架构冲突: 无

## T-LLM-THINK-OFF | 2026-05-03 | LLM（大语言模型） thinking（思考）模式默认关闭

- 涉及模块: conversation/llm（对话大语言模型）配置与 HTTP（超文本传输协议）请求适配,app（应用装配）环境变量装配,`.env.example`（环境变量示例）,LLM（大语言模型）运行时与 app（应用）回归测试
- A 拆解依据: 用户要求关闭 MiMo（小米大模型） thinking（思考）模式,通过统一 LLM（大语言模型）配置表达默认关闭,业务层不直接散落供应商私有参数;边界限定在 LLM（大语言模型）配置/HTTP（超文本传输协议）适配与装配层,不改 prompt（提示词）、skill（技能）、runtime（运行时）或 worker（工作线程）
- C 审查结论: 曾打回 1 次 (非 MiMo（小米大模型） `force_thinking_models`（强制思考模型）命中且 `reasoning_effort=none`（推理强度为无）时会静默不发有效开启字段);B（实现代理）改为配置阶段显式拒绝坏组合并补齐非 MiMo（小米大模型）回归测试后通过
- 关键决策: 业务配置统一使用 `LLM_ENABLE_THINKING=false`（关闭思考）、`LLM_REASONING_EFFORT=none`（无推理强度）与 `LLM_FORCE_THINKING_MODELS`（强制思考模型清单）;HTTP（超文本传输协议）适配层只对 MiMo（小米大模型）下沉 `chat_template_kwargs.enable_thinking=false`（聊天模板参数关闭思考）,非 MiMo（小米大模型）仅在 force（强制）且 effort（强度）非 `none`（无）时发送 `reasoning_effort`（推理强度）,避免配置声称开启但请求体无效
- 架构冲突: 无

## T-CTX-CHAT-1 | 2026-05-03 | Chat（闲聊）路径快照模板与 Stage 2-Chat（第二阶段闲聊）回归

- 涉及模块: conversation/llm（对话大语言模型） prompt（提示词）模板与 snapshot context（快照上下文）渲染,ConversationWorker（对话工作线程） chat（闲聊）/triage（分诊）路由处理,app（应用装配）在线 observation（观测）注入,diagnostics（诊断）本地 JSONL（结构化日志）
- A 拆解依据: 用户要求 Chat（闲聊）路径按 §7.1.2 注入 `[Bot]`/`[世界]`/`[主人]`/`[背包]`/`[背包变化]`/`[最近上下文]`/`[时间]` 子集,只落模板与渲染槽位,`world_key`（世界键）走 transport（传输层）既有端口,不新增 recent_events（最近事件）/对话轮队列/inventory diff cache（背包差异缓存）;后续用户明确要求修正 triage（分诊）直出 reply（回复）导致 Chat（闲聊）阶段不执行的问题,并把每次回复与上下文落本地日志
- C 审查结论: 通过
- 关键决策: Chat（闲聊）快照顺序按 §7.1.2 而不是任务文字列表,空 `[背包变化]` 与 `[最近上下文]` 按规则省略;triage（分诊）保留兼容 `reply.content`（回复正文）字段但运行时统一忽略正文并进入 Stage 2-Chat（第二阶段闲聊）,防止旧模型输出绕过 Chat（闲聊） prompt（提示词）;本地日志通过 worker（工作线程）可选 sink（汇点）旁路写入,失败不阻断实服回复
- 架构冲突: 无

## T-CTX-DLG-1 | 2026-05-03 | [最近上下文] 双 owner（所有者）时间线全链路

- 涉及模块: conversation/llm（对话大语言模型） Chat（闲聊）/Plan（规划）/Modify（修改） prompt（提示词）渲染,conversation（对话） recent context（最近上下文） store（存储）,ConversationWorker（对话工作线程）共享上下文构建与 BotWorker（机器人工作线程） action sink（动作汇点）,BotActor（机器人执行代理） recent_events（最近事件）投影,skills（技能）/sandbox（沙盒） deterministic formatter（确定性格式化器）,diagnostics（诊断）本地 JSONL（结构化日志）
- A 拆解依据: 用户要求按 §7.6 落地双 owner（所有者）时间线,ConversationWorker（对话工作线程）写主人原文 / Bot reply（机器人回复）原文 / sandbox TS（沙盒 TypeScript）原文 / sandbox error.message（沙盒错误消息）,BotActor（机器人执行代理）写 skill（技能）/sandbox（沙盒）执行结果单行;Chat（闲聊）/Plan（规划）/Modify（修改）三路消费同一时间线;不改 LLM protocol（大语言模型协议）结构、不改 observation（观测）数据契约、不进入 §8 异步通路
- C 审查结论: 曾打回 1 次 (BotActor（机器人执行代理）直接 import（导入） skills（技能）/sandbox（沙盒） formatter（格式化器）,app（应用）解析 recent context（最近上下文）业务 payload（载荷）);B（实现代理）改为 RuntimeRecentEventFormatter（运行时最近事件格式化器）端口注入,并把 sandbox finalize（沙盒终态）消费收敛到 conversation-worker（对话工作线程） sink（汇点） 后通过
- 关键决策: recent context（最近上下文）使用进程内 round store（轮次存储）按 message_id（消息标识）聚合,10 整轮 LRU（最近最少使用）淘汰,渲染从旧到新且当前 user message（用户消息）不重复注入;超长 sandbox TS（沙盒 TypeScript）只截断代码块并保留同轮报错 / 执行结果;泛指捡拾 prompt（提示词）明确走无 itemName（物品名）的 collect（捡拾）,避免把 item/unknown（未知物）误当目标名
- 架构冲突: 无

## T-CTX-002 | 2026-05-03 | inventory diff cache（背包差异缓存）三路共享

- 涉及模块: conversation（对话） inventory diff cache（背包差异缓存）,conversation/llm（对话大语言模型） Chat（闲聊）/Plan（规划）/Modify（修改） prompt（提示词）渲染,ConversationWorker（对话工作线程） shared context（共享上下文）构建层,app（应用） environment snapshot provider（环境快照提供器）装配,runtime/transport（运行时传输） collect（捡拾）半径执行修复
- A 拆解依据: 用户要求按 §7.5 落地 bot_id（机器人标识）维度进程内 baseline（基线）缓存,Chat（闲聊）/Plan（规划）/Modify（修改） 三路在 prompt（提示词）构建时取当前 inventory（背包） 与 baseline（基线）计算 `[背包变化]`,prompt（提示词）渲染后、路径返回前立即推进 baseline（基线）;Cancel（取消）/Triage（分诊）不读写;不改 observation（观测）数据契约、不改 LLM protocol（大语言模型协议）、不动 Mineflayer（Minecraft 协议客户端）本体
- C 审查结论: 通过;B（实现代理）交互中曾因实服 collect（捡拾）未执行有效动作返修,后续按用户补充边界把 collect（捡拾）默认半径调为 32、最大 64,并把 32 未命中后扩到 64 的搜索收敛在 runtime transport（运行时传输）执行层
- 关键决策: inventory diff（背包差异）不放 observation（观测）事件时钟,而由 ConversationWorker（对话工作线程）共享上下文在 LLM（大语言模型）路径出口推进 baseline（基线）;`[背包变化]` 只渲染单 delta（增量）文本如 `oak_log+5, cobblestone-2`;泛指捡拾默认以主人坐标为 center（圆心）,执行层负责扩半径,避免让 LLM（大语言模型）编排二次 collect（捡拾）
- 架构冲突: 无

## T-CONV-001 | 2026-05-03 | Triage（分诊）净化与 composite schema（复合结构）收敛

- 涉及模块: conversation（对话） triage（分诊）/contracts（契约）/parsers（解析器）,conversation/llm（对话大语言模型） client（客户端）与 triage prompt（分诊提示词）,ConversationWorker（对话工作线程） composite dispatch（复合派发）,diagnostics（诊断） LLM JSONL（大语言模型结构化日志）本地落盘,app（应用）在线 LLM（大语言模型）装配
- A 拆解依据: 用户要求 Stage 1-Triage（第一阶段分诊）只做路由,统一为唯一 composite schema（复合结构）,删除旧 `{intent, priority, reason}` 单层兼容与 `reply.content`（回复正文）,LLM（大语言模型）解析失败必须写 diagnostics JSONL（诊断结构化日志）,不再静默回退为 `{reply:{}}`;覆盖 A1/A2/A5 且需真实 LLM（大语言模型）验证
- C 审查结论: 曾打回 1 次 (解析失败 diagnostics（诊断）只在内存回调与测试数组中存在,没有由在线主程写入本地 `logs/llm/...jsonl`);B（实现代理）补充 `createLocalLlmDiagnosticLogSink`（本地大语言模型诊断日志汇点）并由 app（应用）在线入口按 `record.log_ref`（记录日志引用）落盘后通过
- 关键决策: 选择严格拒绝旧 schema（结构）与 `reply.content`（回复正文）,由 `ConversationLlmTriageError`（对话大语言模型分诊错误）携带 diagnostics（诊断）向上暴露;本地日志按 diagnostics（诊断）层校验后的 `log_ref`（日志引用）写 `record.lines`（记录行）,不在 app（应用）散落路径拼接,并复用统一脱敏 helper（辅助函数）
- 架构冲突: 无

## T-CONV-002 | 2026-05-03 | 删除 Modify（修改）路径并将修改语义降级为 cancel（取消）+ task（任务）

- 涉及模块: conversation（对话） contracts（契约）/triage prompt（分诊提示词）/route factory（路由工厂）,ConversationWorker（对话工作线程） composite dispatch（复合派发）与 plan-exec handler（规划执行处理器）,Docs（文档） 01_ARCHITECTURE（架构）/04_CONVERSATION_SPEC（对话规范）,BotActor（机器人执行代理） interrupt（中断）,runtime/transport（运行时传输） Mineflayer（Minecraft 协议客户端）动作停止端口
- A 拆解依据: 用户要求删除 `modify_interrupt_then_plan`（修改后中断再规划）专属路由,修改诉求统一由 composite triage（复合分诊） 的 `cancel + action(task)`（取消加任务动作）承载;ConversationWorker（对话工作线程） 不再有 modify（修改） handler（处理器）或 plan prompt（规划提示词）注入分支;文档同步删除 modify（修改）独立语义,且需实服验证先取消再下新任务
- C 审查结论: 通过;用户实服曾打回 1 次 (喊停/取消后 Bot（机器人）状态变为空闲但 Mineflayer pathfinder（寻路器）仍继续移动);B（实现代理）新增 `stopCurrentAction()`（停止当前动作） transport port（传输端口）并由 BotActor（机器人执行代理） interrupt（中断）时调用,用户确认手测通过
- 关键决策: ConversationWorker（对话工作线程） 按 cancel（取消）→reply（回复）→action（动作） 顺序串联 composite（复合）片段,不新增 modify（修改）专用 handler（处理器）;停止物理动作收敛在 runtime transport（运行时传输）端口内调用 pathfinder（寻路器）停止与控制键清理,不让 ConversationWorker（对话工作线程）直接接触 Mineflayer（Minecraft 协议客户端）实现
- 架构冲突: 无

## T-CONV-003 | 2026-05-03 | control fast-path（控制快路径）入口接入与取消词去重

- 涉及模块: interfaces（接口） control fast-path（控制快路径）匹配,app/bootstrap（应用装配） HTTP（超文本传输协议）消息入口,app/entrypoint（应用入口） server-bridge（服务端桥接）消息入口,BotActor（机器人执行代理） interrupt（中断）端口,ConversationWorker（对话工作线程） triage（分诊）创建器
- A 拆解依据: 用户要求按 01_ARCHITECTURE.md §3.2/§3.3/§4.2 把“停 / 别动 / 取消”等精确 control（控制）词前移到 API gateway（接口网关）/消息接入层,命中后不入 `msg:{botId}` 队列,直接调用 BotActor.interrupt（机器人执行代理中断）并广播模板回复返回 202;同时删除 ConversationWorker（对话工作线程） triage（分诊）创建器里的重复取消词数组
- C 审查结论: 通过
- 关键决策: control（控制）词只在 interfaces（接口）边界做精确匹配,HTTP（超文本传输协议）与 server-bridge（服务端桥接）入口共享同一 matcher（匹配器）;命中后只走 BotActor（机器人执行代理）中断、模板 reply（回复）与 realtime/replay（实时/补拉）事件,不再让 triage（分诊）兜底短路或生成回复
- 架构冲突: 无

## T-CONV-004 | 2026-05-03 | intent_epoch（意图纪元）Redis INCR（缓存自增命令）单调源接入

- 涉及模块: db（数据库/缓存） Redis（缓存） key（键）与 IntentEpochStore（意图纪元存储）端口,app/bootstrap（应用装配） HTTP（超文本传输协议）消息入口,app/entrypoint（应用入口） server-bridge（服务端桥接）入队,BotWorker（机器人工作线程） epoch（纪元）校验,BotActor（机器人执行代理） interrupt（中断）信号,status（状态）投影
- A 拆解依据: 用户要求 `intent_epoch`（意图纪元）以 `Redis INCR bot:{botId}:intent_epoch`（缓存自增键）作为唯一单调源,贯穿消息接入层取号、ConversationMessageContext（对话消息上下文）装配、BotWorker（机器人工作线程）过期任务丢弃与 BotActor（机器人执行代理）中断信号;覆盖 01_ARCHITECTURE.md §9.2 中的 epoch（纪元）闸门
- C 审查结论: 通过
- 关键决策: 真实路径默认由 Redis INCR（缓存自增命令）取号、Redis GET（缓存读取命令）读当前 epoch（纪元）,测试路径通过同一 IntentEpochStore（意图纪元存储）端口注入内存实现;BotWorker（机器人工作线程）改为异步读取当前 epoch（纪元）,使 `job.intent_epoch < currentEpoch`（任务纪元小于当前纪元）丢弃闸门接上真实单调源
- 架构冲突: 无

## T-BRAIN-001 | 2026-05-03 | PG schema（PostgreSQL 数据库模式）与 Drizzle（数据库 ORM）模型落地

- 涉及模块: data（数据） schema（模式）与 table contracts（表契约）,db migrations（数据库迁移）,PostgreSQL（关系型数据库） extension（扩展）依赖,数据模型与迁移运行测试
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §2.3 落地 `task_events` / `bot_rolling_summary` / `bot_memory` / `memory_candidates` / `memory_audit` 五张 Brain（长期记忆）表,包含索引、约束、复合主键、`tsvector`（全文检索向量）生成列、`pg_trgm`（三元组索引扩展） GIN（倒排索引）和 HNSW（近邻搜索）向量索引;边界限定为 schema（模式）与 migration（迁移）,不触 LLM（大语言模型）或运行时业务链路
- C 审查结论: 曾打回 1 次 (`0000` 初始 migration（迁移）只创建五张新表但外键引用旧九表,空库不可重放);B（实现代理）补齐完整初始 migration（迁移）后通过
- 关键决策: 选择把仓库首个 `0000` migration（迁移）做成空库可重放的完整当前 schema（模式）,而不是伪装成五表增量;高级索引用原始 SQL（结构化查询语言）落在 migration（迁移）中,Drizzle（数据库 ORM）模型只声明可类型化结构,避免把 ORM（对象关系映射）不完整支持包装成业务抽象
- 架构冲突: 无

## T-BRAIN-002 | 2026-05-03 | BotWorker（机器人工作线程）任务卡入队与 BrainWorker（大脑工作线程）写入 B 层

- 涉及模块: workers/bot-worker（机器人工作线程）,workers/brain-worker（大脑工作线程）,workers/embedding-client（向量客户端）,app/main（主入口）,app/entrypoint（应用入口）,db/task-events（任务事件持久化）,data/contracts/task-event（任务事件契约）
- A 拆解依据: 用户要求 BotWorker（机器人工作线程）在 success（成功）/failed（失败）/interrupted（中断）终态推送带 task_card（任务卡）的 brain（大脑）队列任务,由 BrainWorker（大脑工作线程）集中调用 embedding API（向量接口）并一次写入 PostgreSQL（关系型数据库） `task_events`（任务事件）;符合 01_ARCHITECTURE.md §3 三队列职责与 05_DATA_SPEC.md §7 BrainWorker（大脑工作线程）数据写入流
- C 审查结论: 曾打回 2 次 (首次真实 embedding API（向量接口）未跑通且任务卡无法落库;二次返修只验证 probe（探测脚本）未接通 main（主入口）环境装配);B（实现代理）补齐主程 `EMBEDDING_*`（向量配置）装配并完成真实主程链路验证后通过
- 关键决策: 选择独立 embedding endpoint（向量端点）配置,不复用 LLM（大语言模型） base_url（基础地址）硬拼路径;BotWorker（机器人工作线程）只产任务卡,BrainWorker（大脑工作线程）独占 embedding（向量嵌入）与落库,app（应用）只做依赖装配
- 架构冲突: 无

## T-BRAIN-003 | 2026-05-03 | A.5 滚动摘要维护与触发式 takeaway（要点）

- 涉及模块: workers/brain-worker（大脑工作线程）,workers/brain-llm（大脑大语言模型客户端）,db/brain-memory（大脑记忆数据库端口）,diagnostics/task-log-reader（任务日志读取器）,app/entrypoint（应用入口）,conversation-worker（对话工作线程）主人消息 activity heartbeat（活跃心跳）
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §7-②/③ 落地 failed takeaway（失败要点）、session silence takeaway（会话静默要点）与 A.5 bot_rolling_summary（滚动摘要）追加/重压;BrainWorker（大脑工作线程）独占 B 层/A.5 写入,app（应用）只做依赖装配,ConversationWorker（对话工作线程）仅提供静默检测所需的主人消息心跳
- C 审查结论: 通过
- 关键决策: 选择注入式 LLM（大语言模型）端口、PostgreSQL（关系型数据库）端口与 JSONL（结构化日志）前 50 行读取器,不让 app（应用）解释 takeaway（要点）业务;失败 takeaway（要点）在 task_events（任务事件）插入后 update（更新）,滚动摘要超过 2000 字才触发同模型重压到 1000 字内,会话静默以主人消息心跳、brain queue（大脑队列）idle（空闲）与 BotActor（机器人执行代理）活跃任务三条件共同判定
- 架构冲突: 无

## T-BRAIN-004 | 2026-05-03 | Rubric（评分规则）候选识别与 bot_memory（长期记忆）自动提拔

- 涉及模块: workers/brain-worker（大脑工作线程）,workers/brain-llm（大脑大语言模型客户端）,workers/brain-memory-safety（长期记忆安全扫描）,workers/contracts（工作线程契约）,workers/bot-worker（机器人工作线程）,workers/conversation-worker（对话工作线程）,db/brain-memory（大脑记忆数据库端口）,data/contracts/bot-memory（长期记忆数据契约）,data/contracts/task-event（任务事件契约）,app/entrypoint（应用入口）
- A 拆解依据: 用户要求按 05_DATA_SPEC.md §7-④/⑤ 落地 C 层 memory_candidates（记忆候选）识别、confidence（置信度）阈值自动提拔到 bot_memory（长期记忆）、容量超限二次 LLM（大语言模型）决策、prompt injection（提示注入）/credential（凭证）安全降级与 memory_audit（记忆审计）;BrainWorker（大脑工作线程）是 C 层唯一业务写入者,app（应用）只做端口装配;返修要求“这里 / 基地”类指示语必须绑定主人发话时 snapshot（快照）坐标而非 BrainWorker（大脑工作线程）消费时 live snapshot（实时快照）
- C 审查结论: 曾打回 1 次 (首次补“这里是家”时只在 BrainWorker（大脑工作线程）测试里硬编码坐标,且生产实现由 BrainWorker（大脑工作线程）延迟读取 live snapshot（实时快照）,异步消费后可能记录主人移动后的错误坐标);B（实现代理）改为在 message ingress（消息接入）/ConversationWorker（对话工作线程） prompt snapshot（提示词快照）捕获 owner_position_at_message（发话时主人坐标）,并经 BotWorkerTask（执行任务）与 BrainTaskCard（任务卡）结构化透传后通过
- 关键决策: 选择 BrainWorker（大脑工作线程）统一编排 rubric（评分规则）识别、候选落库、提拔、容量决策和审计,PostgreSQL（关系型数据库）只通过 db/brain-memory（大脑记忆数据库端口）写入;安全扫描命中时保留 pending（待审核）候选但禁止自动提拔,容量超限交给同一 Brain LLM（大脑大语言模型）端口做 merge（合并）/replace（替换）/delete（删除）决策;“这里 / 这边 / 基地”坐标选择结构化字段透传,不选 live provider（实时提供器）,避免异步延迟污染长期记忆语义
- 架构冲突: 无

## T-BRAIN-005 | 2026-05-04 | ConversationWorker（对话工作线程）注入 Brain（大脑）上下文与 search（检索）工具

- 涉及模块: workers/conversation-worker（对话工作线程）,workers/brain-worker（大脑工作线程）,workers/bot-worker（机器人工作线程）,conversation/llm（对话大语言模型）,conversation/brain-context（大脑上下文）,db/brain-search（大脑检索数据库端口）,db/task-history（任务历史数据库端口）,diagnostics/brain-log（大脑诊断日志）,app/entrypoint（应用入口）
- A 拆解依据: 用户要求按 04_CONVERSATION_SPEC.md §9 / §10.2 / §12 与 05_DATA_SPEC.md §3 落地 A 层/A.5/C 层上下文注入,Stage 2-Chat（第二阶段闲聊）与 Stage 2-Plan（第二阶段规划）暴露 search()（检索工具）并支持最多 3 轮 tool calling（工具调用）,Stage 1-Triage（第一阶段分诊）不暴露工具;返修要求 Brain fact（大脑事实）只能旁路、task_history（任务历史）先于 task_events（任务事件）建立父子链路、LLM JSONL（大语言模型结构化日志）必须保留最终 assistant（助手）输出
- C 审查结论: 曾打回 3 次 (地点记忆闭环缺测试且误用 Plan（规划）特殊分支;task_events（任务事件）外键父表 task_history（任务历史）缺失;Brain fact（大脑事实）入队和诊断失败仍可能阻断 Chat（闲聊）/Plan（规划）主路径);B（实现代理）补齐三 worker（工作线程）集成测试、task_history（任务历史）生命周期 sink（汇点）、Brain fact（大脑事实）best-effort（尽力而为）旁路与双失败测试后通过
- 关键决策: 选择由 ConversationWorker（对话工作线程）通过注入端口消费 Brain（大脑）上下文和 search()（检索工具）,不直读数据库;选择 BotWorker（机器人工作线程）维护 task_history（任务历史）生命周期、BrainWorker（大脑工作线程）写 task_events（任务事件）与记忆层,app（应用）只做装配;Brain fact（大脑事实）失败只落 runtime event（运行时事件）和诊断,不传播到主路径
- 架构冲突: 无

## T-CONV-005 | 2026-05-04 | Composite Triage（复合分诊）空路由片段从 reply（回复）改名为 chat（闲聊）

- 涉及模块: conversation/contracts（对话契约）,conversation/triage（分诊领域模型）,conversation/llm/prompts/triage（分诊提示词）,conversation/llm/parsers（大语言模型解析器）,workers/conversation-worker/runtime（对话工作线程运行时）,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户确认 Stage 1-Triage（第一阶段分诊）中 `reply:{}` 命名容易与已删除的 `reply.content`（回复正文）混淆;要求改为 `chat:{}` 表示进入 Stage 2-Chat（第二阶段闲聊）,Triage（分诊）仍只做路由,严禁恢复回复正文,旧 `reply:{}` 不兼容
- C 审查结论: 通过
- 关键决策: 选择硬拒绝旧 `reply` 字段而不是保留兼容双轨,让 schema（结构）漂移进入 diagnostics（诊断）并暴露;内部派发顺序同步改为 cancel（取消）→chat（闲聊）→action（动作）,真实 LLM（大语言模型）回归确认纯闲聊返回 `{"chat":{}}`
- 架构冲突: 无

## T-052A | 2026-05-04 | BFS（广度优先搜索）资源簇提取与缓存更新

- 涉及模块: world-model（世界模型）资源簇契约与查询实现,ResourceService（资源服务）缓存,app（应用装配）在线 blockUpdate（方块更新）接线,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求把 ResourceService（资源服务）/world-model（世界模型）资源簇生成从距离聚类改为按具体 blockName（方块名）分组的 BFS（广度优先搜索）连通聚类,树木和矿石统一支持 26 邻域,并在挖掘后的方块变化中按现有 world_key（世界键）隔离更新或删除缓存簇;边界限定不进入 plugin（服务端模组）、正式 cutTree（砍树）/mine（挖矿）技能或 LLM（大语言模型）链路
- C 审查结论: 曾打回 1 次 (首次实现缺少生产 blockUpdate（方块更新）到 ResourceService（资源服务）的自动接线,且混入 plugin（服务端模组）/probe（探针）/WORKFLOW（工作流）越界 diff（差异）);B（实现代理）补齐 app（应用装配）事件接线并移出越界改动后通过
- 关键决策: BFS（广度优先搜索）与断裂重切分保持在 world-model（世界模型）纯函数和 ResourceService（资源服务）内部,生产更新由 app（应用装配）把 Mineflayer（Minecraft 协议客户端） blockUpdate（方块更新）事件转成 ResourceCacheBlockChange（资源缓存方块变化）后调用公共接口;world_key（世界键）仍只通过 transport（传输层）端口读取,不在业务层解析维度或拼接世界名
- 架构冲突: 无

## T-052B | 2026-05-04 | 树木资源簇分类与 cutTree（砍树）目标选择

- 涉及模块: core-ports/runtime（运行时核心端口）资源刷新契约,runtime/transport（运行时传输层）资源键解析与只读候选事实,world-model（世界模型）ResourceService（资源服务）树木分类/选择实现,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求在 world-model（世界模型）/ResourceService（资源服务） 中把当前 world_key（世界键）隔离后的原木资源簇分类为可用于 cutTree（砍树） 的 accepted/rejected（接受/拒绝）结构,并按距离优先累计满足 requiredLogCount（所需原木数量）;边界允许 runtime/transport（运行时传输层）只读可达性/候选点能力和设计文档,不进入 plugin（服务端模组）、LLM（大语言模型）或正式 skill（技能）
- C 审查结论: 曾打回 4 次 (首次缺少不可达/不可挖判定且在 world-model（世界模型）按方块名后缀猜原木;二次 `tree` 公共资源键未映射到 Mineflayer（Minecraft 协议客户端）/minecraft-data（Minecraft 数据库） logs tag（原木标签）事实;三次把 Mineflayer `canDigBlock`（能否挖方块）当前 5.1 格距离限制混入 `is_diggable`（可挖）资源事实;其间均未追加进度);B（实现代理）补齐 runtime（运行时） semantic_roles（语义角色）/is_diggable（可挖）/is_reachable（可达）事实、`tree`→`logs` 内部解析别名和 8 格外回归测试后通过
- 关键决策: 保持 TS Core（TypeScript 核心）公共资源键为 `tree`,由 runtime/transport（运行时传输层）内部解析到 Minecraft（我的世界）原木 tag（标签）事实并返回 `resource_keys=["tree"]`;world-model（世界模型）只消费 `cut_tree_log`（砍树原木）语义角色、可挖事实和可达候选事实,不再按方块名猜测;`is_diggable`（可挖）只表达方块事实,不混入当前执行距离
- 架构冲突: 无

## T-052C | 2026-05-04 | plugin（服务端模组）树木/矿石相连连锁掉落

- 涉及模块: plugin（服务端模组） Fabric（模组加载器）入口 `MCServantMod`,chainbreak（连锁破坏） handler（处理器）,服务端日志 diagnostics（诊断）
- A 拆解依据: 用户要求 plugin（服务端模组）在真实方块破坏事件中把一次挖树木/矿石扩展为同类相连资源连锁破坏并生成正常掉落物;边界限定 plugin（服务端模组）与 diagnostics（诊断）,不进入 ResourceService（资源服务）、cutTree（砍树）正式 skill（技能）接入或 LLM（大语言模型）;用户交互中追加普通玩家也应触发,因此触发范围从 bot（机器人）扩展为所有 ServerPlayerEntity（服务端玩家实体）
- C 审查结论: 通过;B（实现代理）交互中曾处理 bot（机器人）名称过滤、旧 jar（归档包）部署和树叶不自然凋零疑问,最终实现走 `PlayerBlockBreakEvents.AFTER`（破坏后事件）与 `ServerPlayerInteractionManager.tryBreakBlock`（服务端玩家破坏入口）,并由用户实服确认连锁掉落后树叶可按 vanilla（原版）机制自然凋零
- 关键决策: 树木/矿石识别消费服务端 registry/tag（注册表/标签）事实,不判断自然树或用户需求数量;连锁破坏逐块调用玩家破坏入口而不是手动 drop（掉落）+ setBlockState（设置方块状态）,保留掉落、工具耐久、邻居更新、统计与 Fabric（模组框架） break hook（破坏钩子）等原版副作用;用 ThreadLocal（线程局部变量）递归保护避免 handler（处理器）再次触发自身,并记录 destroyed（破坏数）、scanned（扫描数）、truncated（截断）和 failure reasons（失败原因）
- 架构冲突: 无

## T-053 | 2026-05-04 | cutTree（砍树）技能接入资源簇执行链

- 涉及模块: skills（技能） `cutTree`（砍树）执行器,sandbox（沙箱）/BotActor（机器人执行代理）技能入口,runtime/transport（运行时传输层）按坐标挖掘与 Mineflayer（Minecraft 协议客户端）资源事实兜底,ResourceService（资源服务）树木簇选择,collect（捡拾）复用,conversation/llm（对话大语言模型） prompt（提示词）与技能计划表,diagnostics（诊断）recent event（近期事件）,Docs/04_CONVERSATION_SPEC.md（对话规格文档）
- A 拆解依据: 用户要求“砍 N 块木头”只由 LLM（大语言模型）输出高层 `cutTree(count)` skill call（技能调用）,执行层按当前 `world_key`（世界键）消费 T-052B（任务）树木簇推荐目标,挖一个原木触发 T-052C（任务） plugin（服务端模组）连锁掉落,collect（捡拾）后以真实 inventory diff（背包增量）判断是否继续;边界允许 skills（技能）、sandbox（沙箱）、runtime/transport（运行时传输层）、BotActor（机器人执行代理）、ResourceService（资源服务）、collect（捡拾）、conversation/llm（对话大语言模型）与 diagnostics（诊断）,明确不启用 mine（挖矿）或 equip（装备）
- C 审查结论: 通过;B（实现代理）曾因“砍 5 块木头无反应”返修真实链路,补齐 `tree` 资源事实兜底、triage（分诊） prompt（提示词）动作指向、GoalNear（近距离目标）加载与 Vec3（三维向量）坐标对象;用户追加禁止 regex（正则表达式）语义捕获后,B（实现代理）撤掉新增 regex（正则表达式）兜底并用 prompt（提示词）约束;C（审查代理）确认当前 diff（差异）未启用 mine（挖矿）/equip（装备）、未进入 plugin（服务端模组）,`bash scripts/pre_review.sh` 全绿
- 关键决策: 选择在 `cutTree`（砍树）确定性执行器中循环消费 ResourceService（资源服务）当前世界树木簇,优先单个足量近簇、否则累计多个小簇;每轮只挖推荐原木并复用 collect（捡拾）,以背包真实增量而非簇预估数量作为完成标准;LLM（大语言模型）只负责输出 `cutTree({count})`,不输出坐标、簇、循环或挖掘目标;资源事实兜底仍放 runtime/transport（运行时传输层）并消费 Mineflayer（Minecraft 协议客户端）/minecraft-data（Minecraft 数据库）事实,不在 world-model（世界模型）按方块名猜测
- 架构冲突: 无

## T-053-DBG | 2026-05-04 | cutTree（砍树）长程任务目标选择与捡拾修复

- 涉及模块: world-model（世界模型）树木簇推荐目标,skills（技能） `cutTree`（砍树）执行器,collect（捡拾）公共参数契约,runtime/transport（运行时传输层）collect（捡拾）适配,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户实服发现长程 `cutTree`（砍树）中推荐目标可能选到高处原木导致 pathfinder（寻路器）贴近树冠超时,且砍完一簇后的 collect（捡拾）失败会被吞掉后继续下一棵;用户明确要求默认选最低原木,砍完等待 0.5 秒后以树簇中心半径 8 捡拾全部掉落物,collect（捡拾）默认仍为 32 但显式调用可小于 32
- C 审查结论: 曾打回 1 次 (首次返修仍吞掉 collect（捡拾）异常,且公共 `collect`（捡拾）参数校验仍拒绝 `radius: 8`);B（实现代理）移除吞错逻辑、区分规划建议最小半径 32 与显式调用最小半径 1,并补齐失败回归测试后通过
- 关键决策: 树木簇推荐目标改为最低合法原木,避免 `GoalNear`（近距离目标）要求 Bot（机器人）靠近高处树冠;`cutTree`（砍树）每轮挖掘后强制调用无 `itemName`（物品名）过滤的 collect（捡拾）,以树簇中心和半径 8 清扫范围内全部掉落物,collect（捡拾）失败直接让任务失败并暴露原始错误
- 架构冲突: 无

## T-055 | 2026-05-04 | 最小 CraftService（合成服务）与 Mineflayer（Minecraft 客户端库）合成适配

- 涉及模块: domain（领域） CraftService（合成服务）,core-ports（核心端口）工具链失败码,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）合成适配,运行时与技能契约测试
- A 拆解依据: 用户要求实现 Phase 1（第一阶段）最小合成能力,支持 planks（木板）、stick/sticks（木棍）、crafting_table（工作台）、wooden_pickaxe（木镐）、stone_pickaxe（石镐）;配方、材料数量、是否需要工作台必须来自 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）/runtime（运行时）校验;边界限定 Domain（领域服务）、Runtime（运行时）、Skills（技能基础能力）、Inventory（背包状态）,不做通用 RecipeService（配方服务）、不做熔炼、不碰 LLM（大语言模型） prompt（提示词）
- C 审查结论: 通过
- 关键决策: CraftService（合成服务）只做 allowlist（白名单）目标边界与 `sticks`（木棍复数）别名归一化,不写材料数量或配方形状;实际 recipe（配方）选择、材料检查、crafting table（工作台）需求判断和 craft（合成）执行下沉到 runtime/transport（运行时传输层）消费 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）事实;planks（木板）泛化目标通过注册表事实候选收敛,拿不到事实时结构化失败
- 架构冲突: 无

## T-056 | 2026-05-04 | 最小 PlacementService（放置服务）与 crafting table（工作台）放置执行链

- 涉及模块: domain（领域） PlacementService（放置服务）,core-ports（核心端口）工具链能力契约,sandbox（沙箱） Facade API（门面接口） 与失败冒泡,BotActor（机器人执行代理）单写者接线,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）放置/合成/工作台缓存适配,conversation/llm（对话大语言模型）规划提示词,相关测试
- A 拆解依据: 用户要求实现只服务工具链的 crafting table（工作台）放置能力,能在附近选择有支撑、目标空间为空、Bot（机器人）可接近且可点击的位置放置,成功后缓存工作台位置并供后续 craft（合成）复用;不得扩展为通用 placeBlock（放方块）建筑系统;实服返修追加要求背包无工作台时先合成,缺 planks（木板）但有原木时按运行时配方尝试合成木板,失败必须结构化冒泡
- C 审查结论: 通过;曾打回 1 次 (`lookAt`（看向目标） 与 pathfinder goals（寻路目标） 真实库类型契约未收口,仍可能重复 `point.minus is not a function` 与 `GoalNear`（近距离目标）导出形态问题);B（实现代理）将 `lookAt`（看向目标）端口改为 `Vec3`（三维向量） 实例,并新增集中 `pathfinder-goals`（寻路目标解析器）后通过
- 关键决策: `place`（放置） 作为 sandbox（沙箱）工具链能力暴露,不升级为正式 skill（技能）且只允许 `crafting_table`（工作台）;真实 Mineflayer（Minecraft 客户端库）动作仍经 BotActor（机器人执行代理）串行进入 runtime/transport（运行时传输层）;放置前复用 T-055（任务） craft（合成）适配,候选位置最多尝试 3 个并把失败 attempts（尝试记录）结构化透传;Mineflayer（Minecraft 客户端库）真实对象类型与 pathfinder（寻路器）导出解析收敛到 runtime/transport（运行时传输层）契约和 helper（辅助函数）
- 架构冲突: 无

## T-057 | 2026-05-04 | 最小 equip（装备）技能启用与主手切换

- 涉及模块: core-ports（核心端口）技能契约,runtime/transport（运行时传输层） Mineflayer（Minecraft 客户端库）装备适配,BotActor（机器人执行代理）与 BotWorker（机器人工作线程）单写技能入口,conversation/llm（对话大语言模型）规划门禁与提示词,plugin（服务端模组） `/svs`（服务端桥接命令）成功回显,相关测试
- A 拆解依据: 用户要求实现最小 equip（装备）能力,至少支持 wooden_pickaxe（木镐）和 stone_pickaxe（石镐）,检查当前手持物、背包目标物并调用 runtime（运行时）装备;不得做 armor（护甲）、武器策略或自动最佳工具选择;返修中用户明确指出“装备就是拿在手上”且需要支持装备 bread（面包）到主手,并要求 `/svs`（服务端桥接命令）游戏内回显玩家原始输入而非固定“已转发”
- C 审查结论: 通过;`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,33 个 test file（测试文件）/340 个 test（测试）通过;`plugin`（服务端模组） `./gradlew build` 通过;用户已实服确认 bread（面包）可装备到主手
- 关键决策: `equip`（装备） 语义收敛为“把背包目标物品拿到主手”,`destination`（目标槽位） 只开放 `hand`（主手）,不扩展护甲/武器/最佳工具系统;执行层先比较 `heldItem`（当前手持物） 返回 `already_equipped`（已装备）,再从 inventory（背包） 查找目标物并调用 Mineflayer `equip`（装备）,失败以 `missing_item`（缺目标物品） 或 `runtime_equip_failed`（运行时装备失败） 结构化冒泡;`/svs`（服务端桥接命令） 只改成功回显文本,不改变 player_message（玩家消息）协议帧或 TS Core（TypeScript 单核心）入口
- 架构冲突: 无

## T-058 | 2026-05-04 | StairBFSPlanner（阶梯广度优先规划器）采矿核心

- 涉及模块: domain（领域） StairBFSPlanner（阶梯广度优先规划器）/WorldScanner（世界扫描器）/SafetyChecker（安全检查器）/OreHandler（矿石处理器）契约,domain（领域）导出边界,领域模型测试
- A 拆解依据: 用户要求实现采矿规划核心,以“玩家脚下位置”为 BFS（广度优先搜索）节点,状态包含 pos（位置）、dir（方向）、mode down/up（下降/上升模式）、usedFill（已用填充数）,先不填方块规划、失败后才允许低价值方块补路;边界限定 WorldScanner（世界扫描器）、SafetyChecker（安全检查器）、StairBFSPlanner（阶梯规划器）、OreHandler（矿石处理器）与 Executor（执行器）规划部分,明确不接 LLM（大语言模型）、不把 stone（石头）加入资源簇、不做大型洞穴探索或火把系统
- C 审查结论: 通过;`bash scripts/pre_review.sh`（评审前预检脚本） 全绿,34 个 test file（测试文件）/347 个 test（测试）通过;`git diff --check`（差异空白检查）通过
- 关键决策: 规划器保持纯 domain（领域）核心,只消费 scanner（扫描器）预分类 block role（方块角色）,不在业务逻辑中硬编码 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库）事实;默认第一阶段只找无填充安全路线,调用方给出 fill budget（填充预算）后才运行第二阶段;step（步骤）输出只包含 nextFoot（下一脚部空间）/nextHead（下一头部空间）挖掘与 nextFloor（下一地板）填充计划,执行动作留给后续任务
- 架构冲突: 无

## T-059 | 2026-05-05 | mine（挖掘）技能接入 StairBFSPlanner（阶梯广度优先规划器）

- 涉及模块: skills（技能） mine（挖掘）执行器,ResourceService（资源服务）矿石候选,runtime/transport（运行时传输层） mine（挖掘）适配与队列构建,domain（领域） StairBFSPlanner（阶梯广度优先规划器）安全规则,core-ports（核心端口）技能契约,BotActor（机器人执行代理）/sandbox（沙箱）入口,conversation/llm（对话大语言模型） mine（挖掘）门禁,相关测试
- A 拆解依据: 用户要求 mine（挖掘） 能用 T-058（任务） StairBFSPlanner（阶梯规划器）安全采集 stone（石头）和 ore（矿石）;stone（石头）不进 ResourceService（资源服务）资源簇,从 bot（机器人）当前位置先规划完整阶梯 dig queue（挖掘队列）再执行到底;ore（矿石）必须消费 ResourceService（资源服务）按具体 blockName（方块名）给出的目标候选;执行前检查工具,执行后用 inventory diff（背包增量）判断掉落,世界定位只走既有 worldKey（世界键）接口;不碰 plugin（服务端模组）
- C 审查结论: 曾打回 2 次 (首次实现让 ore（矿石）在 runtime（运行时）重新 findBlocks（查找方块）、自行读取 bot.game.dimension（机器人维度）、硬编码掉落/工具事实且 mine.ts（挖掘文件）过大;二次审查发现 stone（石头）仍偏向短段重规划/边挖边看,unknown block（未知方块）邻近风险被乐观放行,已有洞复用未按总 walking distance（行走距离）丢弃);B（实现代理）拆分事实/工具/队列模块,改为完整预规划队列、矿石相邻站位、unknown（未知）保守拒绝、反向下降硬拒绝与已有洞 32 步总距离限制后通过
- 关键决策: 普通资源采集以 StairBFSPlanner（阶梯广度优先规划器）从当前脚位生成完整 dig queue（挖掘队列）,不先全局扫描最近 stone（石头）,也不在执行阶段按掉落结果二次重规划;矿石路径保留 ResourceService（资源服务）作为候选真源,runtime（运行时）只规划到安全相邻 standingPos（站位）再挖目标方块;MC（Minecraft,我的世界）掉落、工具与方块角色事实由 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库） registry（注册表）读取;已有 air（空气）阶梯靠低挖掘代价自然胜出,但不引入 tunnel memory（隧道记忆）
- 架构冲突: 无;LLM（大语言模型）失败 retry（重试）闭环已标记为需 Planner A（规划代理）确认/另拆的范围项,不作为本条 runtime（运行时） mine（挖掘）验收条件

## T-060 | 2026-05-05 | Toolchain ensure（工具链确保）函数组

- 涉及模块: skills（技能） toolchain-ensure（工具链确保）编排器,core-ports（核心端口）工具链能力契约,sandbox（沙箱） Facade API（门面接口） 与执行器,BotActor（机器人执行代理）工具链分发,runtime/transport（运行时传输层）背包语义计数,app（应用装配）生产注入,conversation/llm（对话大语言模型） planner prompt（规划提示词）,Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求实现可复用 ensure（确保）函数组 `ensureLogs(count)`（确保原木）、`ensureCraftingTablePlaced()`（确保工作台已放置）、`ensureWoodenPickaxeEquipped()`（确保木镐已装备）、`ensureCobblestone(count)`（确保圆石）、`ensureStonePickaxeEquipped()`（确保石镐已装备）,只能组合 cutTree（砍树）/collect（捡拾）/craft（合成）/place（放置）/equip（装备）/mine（挖掘）等底层通用能力,不得新增 `demoMineIron()`（演示挖铁） 或绕过 BotActor（机器人执行代理）直接操作 runtime（运行时）
- C 审查结论: 曾打回 1 次 (首次实现把 `ensureCobblestone(count)`（确保圆石） 的目标总数语义与缺口数量混用,导致已有 2 个 cobblestone（圆石）且缺 1 个时不挖 stone（石头）;真实 app（应用）装配未注入 runtime（运行时）语义原木计数,背包已有原木仍触发 cutTree（砍树）;ensure（确保）结果丢弃底层 world_key（世界键）);B（实现代理）补齐目标总数转换、`countInventoryItemsBySemanticRole("cut_tree_log")`（按砍树原木语义角色统计背包）与 ToolchainActionSummary（动作摘要）世界键透传后通过
- 关键决策: ensure（确保） 层保持高层编排,不写配方/掉落/工具等级等 MC（Minecraft,我的世界）事实;缺料恢复先把 runtime craft（运行时合成）返回的 missing（缺口）换算为 ensure（确保）目标总数,再调用普通能力补齐;原木识别下沉到 runtime/transport（运行时传输层）基于 Mineflayer（Minecraft 客户端库）/minecraft-data（Minecraft 数据库） registry（注册表）与 `cut_tree_log`（砍树原木）语义角色统计,不在 ensure（确保）里按名称后缀猜测;planner prompt（规划提示词）只暴露可读的 `api.bot.ensureStonePickaxeEquipped()`（确保石镐已装备）等通用函数,不隐藏整条挖铁 demo（演示）链
- 架构冲突: 无

## T-061 | 2026-05-05 | sandbox TS（沙箱 TypeScript）可编程 API（接口）与失败上下文

- 涉及模块: core-ports（核心端口）工具链能力契约,sandbox（沙箱） contracts（契约）/Facade API（门面接口）/execution（执行器）,BotActor（机器人执行代理）工具链分发与 FacadeCallError（门面调用错误）包装,Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求暴露 sandbox TS（沙箱 TypeScript） 可编程 API（接口）,补齐 `placeCraftingTable()`（放置工作台） 受控入口,并让 craft（合成）/place（放置）/equip（装备）/mine（挖掘）/ensure*（确保函数） 失败时保留 `failure_stage`（失败阶段）、`current_position`（当前位置）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要） 与 `target_progress`（目标进度） 等结构化上下文;边界限定 sandbox（沙箱）、skills（技能注册/契约）、runtime（运行时）、diagnostics（诊断） 与 BotActor（机器人执行代理）,不改 Plan LLM（规划大语言模型） prompt（提示词）,不做自动挖铁
- C 审查结论: 通过;`git diff --check`（差异空白检查）通过,定向 Vitest（测试框架） 命令实际跑全量 34 个 test file（测试文件）/377 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;未发现 Plan LLM（规划大语言模型）源码改动、plugin（服务端模组）越界或 `demoMineIron()`（演示挖铁）隐藏链路
- 关键决策: `placeCraftingTable()`（放置工作台） 只作为 `place({blockName:"crafting_table"})`（放置工作台参数）的零参数别名,不封装合成/装备/挖矿等额外链路;失败上下文在 BotActor（机器人执行代理）统一读取 observation（观测）快照并注入 FacadeCallError.details（门面调用错误细节）,保证 skill（技能）路径和 toolchain（工具链）路径诊断形态一致,同时不让 sandbox（沙箱） 直接读取 runtime（运行时）内部状态
- 架构冲突: 无

## T-062 | 2026-05-05 | TaskResultReporter（任务结果汇报器）终态主动汇报

- 涉及模块: core-ports（核心端口）任务结果摘要契约,BotWorker（机器人工作线程）终态动作与中断识别,TaskResultReporter（任务结果汇报器）模板渲染,app（应用装配）双端同步接线,realtime（实时推送）/game chat（游戏聊天）输出,task history（任务历史）任务卡,result summary（结果摘要）,runtime/transport（运行时传输层） collect（捡拾）返修,skills（技能） cutTree（砍树）捡拾中心与等待策略,Docs/02_RUNTIME_SPEC.md（运行时规格文档）/Docs/03_SANDBOX_SPEC.md（沙箱规格文档）/Docs/04_CONVERSATION_SPEC.md（对话规格文档）,相关测试
- A 拆解依据: 用户要求每个任务 completed（完成）/failed（失败）/interrupted（中断）后由确定性 TaskResultReporter（任务结果汇报器）主动同步游戏聊天与网页端,成功汇报任务类型、完成数量、关键背包增量、耗时和世界摘要,失败汇报失败码、阶段、可恢复性与下一步建议,中断不得误报成功;边界限定 BotWorker（机器人工作线程）、任务生命周期事件、realtime（实时推送）、game chat（游戏聊天输出）、task history（任务历史）、diagnostics（诊断） 与 core-ports（核心端口）摘要契约,明确不改 Plan prompt（规划提示词）、不让 BotActor（机器人执行代理）决定文案、不用 LLM（大语言模型）总结
- C 审查结论: 曾打回 1 次 (sandbox（沙箱） 前置步骤成功、后续步骤失败时,result summary（结果摘要） 会误取最后成功 step（步骤） 导致用户看到错误操作名;Docs/04_CONVERSATION_SPEC.md（对话规格文档） 仍写旧的 0.5 秒与树簇中心 collect（捡拾）语义);B（实现代理）改为失败/中断摘要优先取失败 step（步骤） action（动作）/FacadeCallError.method（门面调用错误方法）/failure_stage（失败阶段）,并同步文档到 1 秒等待、最低原木中心、半径 8 与 3 格高度带后通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,`pnpm test -- app-entrypoint-model.spec.ts`（入口模型测试）实际跑全量 34 个 test file（测试文件）/384 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿
- 关键决策: TaskResultReporter（任务结果汇报器）只消费 BotWorker（机器人工作线程）产出的终态任务卡,在 app（应用装配）层统一调用 `broadcastReply`（广播回复） 与 realtime（实时推送） `chat.reply`,不把汇报决策塞进 BotActor（机器人执行代理）;result summary（结果摘要）作为跨 game chat（游戏聊天）/web UI（网页界面）/task history（任务历史）的轻量事实契约,skill_call（技能调用）和 sandbox_code（沙箱代码）共用模板;collect（捡拾）返修保留严格“同高度带内可见掉落物清空”语义,但忽略树冠高处滞留掉落物并把拾取靠近范围收紧到 0.75,避免部分捡拾误报完成或被树叶滞留物拖死
- 架构冲突: 无

## T-063 | 2026-05-05 | SkillResultSummary（技能结果摘要）统一契约

- 涉及模块: core-ports（核心端口） SkillResultSummary（技能结果摘要）/TaskResultSummary（任务结果摘要）契约,BotWorker（机器人工作线程）终态摘要生成,TaskResultReporter（任务结果汇报器）消费路径,sandbox（沙箱）成功/失败摘要转换,Docs/02_RUNTIME_SPEC.md（运行时规格文档）/Docs/03_SANDBOX_SPEC.md（沙箱规格文档）,app entrypoint（应用入口）回归测试
- A 拆解依据: 用户要求统一 cutTree（砍树）/mine（挖掘）/collect（捡拾）/craft（合成）/place（放置）/equip（装备）/ensure（确保） 的结果摘要,成功摘要统一包含 `skill_name`（技能名）、`status`（状态）、`target`（目标）、`completed_count`（完成数量）、`inventory_delta`（背包增量）、`world_key`（世界键）、`duration_ms`（耗时） 与 diagnostics（诊断）,失败摘要统一包含 `failure_code`（失败码）、`failure_stage`（失败阶段）、`recoverable`（是否可恢复）、`current_position`（当前位置）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要） 与 `target_progress`（目标进度）;边界限定 core-ports（核心端口）、skills（技能）、sandbox（沙箱）、BotWorker（机器人工作线程） 与 diagnostics（诊断）,不碰 LLM（大语言模型） prompt（提示词）,不改变执行语义
- C 审查结论: 曾打回 1 次 (直接 skill_call（技能调用） 失败路径仍从普通 Error（错误对象）生成不完整 failure（失败摘要）,例如 `mine(stone,5)` 未装备时 `failure_stage`（失败阶段） 变成 `executeSkill`（执行技能）、`recoverable`（可恢复性） 为 null 且缺 `target_progress`（目标进度）/上下文);B（实现代理）补齐 job（任务）参数到失败摘要的转换,无 runtime observation（运行时观测）时显式填 null 上下文,并让 recoverable（可恢复性） 基于最终 failure code（失败码）推断后通过;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,`pnpm test -- app-entrypoint-model.spec.ts`（入口模型测试）实际跑全量 34 个 test file（测试文件）/387 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;审查时用 `pnpm tsx`（TypeScript 执行器） 直接复现 `not_equipped:stone:main_hand_empty` 摘要,确认 failure（失败摘要） 已包含 `mine` 阶段、`recoverable:true`、目标进度与 null 上下文
- 关键决策: 保留历史 `operation`（操作名） 兼容字段,但新消费方统一优先读 `skill_name`（技能名） 与 `failure`（失败摘要）,避免 TaskResultReporter（任务结果汇报器）继续按各 skill（技能）私有字段猜测;world_key（世界键） 只透传上游 currentWorld（当前世界）/ResourceService（资源服务）/runtime transport（运行时传输层） 结果,不在摘要层重新解析维度;直接 skill_call（技能调用） 失败没有 observation（观测） 时用显式 null 表达“未知”,保证契约形态稳定,把真实快照注入留给已有 sandbox（沙箱） FacadeCallError（门面调用错误）路径
- 架构冲突: 无

## T-064 | 2026-05-05 | LLM（大语言模型）调用分段 metrics（指标）诊断

- 涉及模块: conversation/llm（对话大语言模型） client（客户端）/stage（阶段执行器）/diagnostics（诊断）,diagnostics（诊断） contracts（契约）/JSONL（结构化日志）工厂,BrainWorker（大脑工作线程） LLM（大语言模型）调用,ConversationWorker（对话工作线程） LLM（大语言模型）事件,app entrypoint（应用入口） `/api/status`（状态接口）摘要装配,Docs/04_CONVERSATION_SPEC.md（对话规格文档）/Docs/05_DATA_SPEC.md（数据规格文档）,相关测试
- A 拆解依据: 用户要求记录每次 LLM（大语言模型）调用完整分段性能指标,包括 `queue_wait_ms`（队列等待）、`prompt_build_ms`（提示词构建）、`request_total_ms`（请求总耗时）、`response_parse_ms`（响应解析）、`tool_round_count`/`tool_round_ms`（工具轮次/耗时）、`diagnostics_write_ms`（诊断写入）、tokens（令牌） 与非流式 `ttft_ms:null`（首字延迟不可得）;边界限定 conversation/llm（对话大语言模型）、diagnostics（诊断）、conversation-worker（对话工作线程）、BrainWorker（大脑工作线程） 与 app diagnostics（应用诊断）,不得阻塞 BotWorker（机器人工作线程） 或暴露 prompt（提示词）全文
- C 审查结论: 通过;改动未进入 BotWorker（机器人工作线程）物理动作链路,BrainWorker（大脑工作线程）复用 `executeStage`（阶段执行器） 统一产出 `brain` 阶段诊断,`/api/status`（状态接口） 只暴露 `LlmDiagnosticSummary`（LLM 诊断摘要）中的 metrics（指标）与 `log_ref`（日志引用）,未暴露 prompt（提示词）全文或密钥;`git diff --check`（差异空白检查）通过,定向 Vitest（测试框架） 命令实际跑全量 34 个 test file（测试文件）/389 个 test（测试）通过,`bash scripts/pre_review.sh`（评审前预检脚本） 全绿;审查时额外用 `pnpm tsx`（TypeScript 执行器） 构造 0 值 metrics（指标）通过 `createLlmLogLine`（LLM 日志行工厂） 与 `createLlmDiagnosticSummary`（LLM 诊断摘要工厂） 校验,确认非负耗时和 `ttft_ms:null` 形态可落库/出状态;真实本地 OpenAI compatible API（OpenAI 兼容接口） 调用返回 `T064 review metrics ok喵~`,并产出 `request_total_ms=5539`、`input_tokens=134`、`output_tokens=168`、`ttft_ms=null`
- 关键决策: 用统一 `LlmCallMetrics`（LLM 调用指标） 契约挂在诊断记录和 JSONL meta（元信息） 上,而不是在 triage（分诊）/chat（闲聊）/plan（规划）/brain（大脑） 各自维护私有字段;非 streaming（非流式）链路明确 `ttft_ms:null` 且带 `ttft_unavailable:"non_streaming"`（首字延迟不可得原因）,不以总耗时伪造首字延迟;`diagnostics_write_ms`（诊断写入耗时） 在 app（应用装配）本地日志写入后回填到摘要和 JSONL meta（元信息）,同时保持完整 transcript（原始对话记录） 只写入脱敏后的 llm JSONL（LLM 结构化日志）,状态接口只读摘要
- 架构冲突: 无

## T-081R | 2026-05-11 | ensure 默认验收后的 runtime/transport 实服返修

- 涉及模块: conversation/llm（对话大语言模型） Plan prompt（规划提示词）,sandbox（沙箱） ensure/until（确保/完成条件）执行语义,skills（技能） mine/cutTree（挖掘/砍树）,runtime/transport（运行时传输层） terrain-router/terrain-navigation/foot-step/mine/place/collect/dig-block/progress-watchdog（地形路由/导航/脚位移动/挖掘/放置/捡拾/按坐标挖掘/进展看门狗）,BotActor（机器人执行代理）中断控制,相关回归测试
- A 拆解依据: 用户要求 T-081 把 `ensure(action, condition)` 升级为真实条件检查器,Plan 默认对资源/装备/放置类目标使用 ensure + until 做最终验收,并在后续实服中连续发现 cutTree 旧寻路、资源可达预筛、Mineflayer pathfinder（Minecraft 寻路库）遗留、collect（捡拾）停住、terrain-router（地形路由）预算与权重、取消不生效、垫高薄方块/自放置脚手架、普通 place（放置工作台）站进目标格与放置超时等问题;边界限定 conversation/llm、sandbox、skills、runtime/transport、core-ports 与 diagnostics/test,不改 PG schema（数据库结构）、外部 API、event_log（事件日志）,不把 MC（Minecraft）事实硬编码进 prompt 或业务代码
- C 审查结论: 曾打回 1 次。首轮返修总体方向符合架构,但普通 `place("crafting_table")`（放置工作台） 在 approach（接近）期间可能被垫高/挖掘改掉主手后仍直接 `placeBlock`（放方块）,`waitForPromiseOrCondition`（等待 promise 或条件） 在 dig/place（挖掘/放置）底层 promise 未结束时不能优先响应取消;同时 Reviewer 曾误把 cutTree（砍树）整簇删除和 collect（捡拾）高度 3 作为问题,用户确认原木连锁掉落要求删除整簇、collect 高度口径就是 3 后撤回这两项。返修后普通 place 每次 `placeBlock` 前重新 resolve/equip（解析/装备） crafting table,watchdog 等待接入 `throwIfAborted`,mine/terrain dig 等路径透传取消,collect 源码与测试保持 3 格高度口径。当前 `git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest 3 个文件 148 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /468 passed/7 skipped;未发现单写者、聊天驱动、双端同步或本地执行闭环被破坏
- 关键决策: 选择保留 `mine`/`goTo`/`cutTree`/`collect`/`place` 等对外高内聚能力接口,在 runtime/transport 内统一自研 terrain navigation（地形导航）与 foot-step（脚位移动）底层,删除旧 mine-queue/StairBFS/pathfinder goal（旧挖掘队列/阶梯 BFS/寻路目标）主路径;取消能力通过 `SkillExecutionControl`（技能执行控制） 标准化到 skill/transport 契约并由 BotActor 的 AbortController（中止控制器） 触发;自放置脚手架只用进程内内存记录,不落库、不跨进程恢复;普通 place 拆分 target（放置目标格） 与 approachFoot（站位格）,并通过真实方块复查处理 Mineflayer blockUpdate（方块更新）超时
- 架构冲突: 无

## T-065 | 2026-05-05 | AsyncDiagnosticSink（异步诊断汇点）旁路写入

- 涉及模块: diagnostics（诊断） AsyncDiagnosticSink（异步诊断汇点）/contracts（契约）/JSONL（结构化日志）摘要工厂,app entrypoint（应用入口）在线 LLM（大语言模型）诊断装配,conversation/llm（对话大语言模型） 与 BrainWorker（大脑工作线程） LLM（大语言模型）诊断回调路径,`/api/status`（状态接口） LLM（大语言模型）摘要,Docs/04_CONVERSATION_SPEC.md（对话规格文档）/Docs/05_DATA_SPEC.md（数据规格文档）,相关测试
- A 拆解依据: 用户要求让 LLM diagnostics（大语言模型诊断） 与本地 JSONL（结构化日志）写入不阻塞对话主路径;边界限定 diagnostics（诊断）、conversation/llm（对话大语言模型）、BrainWorker（大脑工作线程）诊断与 app bootstrap（应用装配）,不得改技能执行逻辑或 prompt（提示词）;执行要求包括 bounded async sink（有界异步汇点）、主路径只投递不等待、队列上限与 dropped_count（丢弃数）、写入错误轻量计数、关闭 flush（刷盘）、状态摘要同步更新
- C 审查结论: 通过;改动未进入 BotActor（机器人执行代理）/BotWorker（机器人工作线程）物理动作与技能执行链路,也未改 prompt（提示词）;`createAsyncDiagnosticSink`（创建异步诊断汇点） 有队列上限、后台串行 drain（排空）、drop priority（丢弃优先级）、`dropped_count`（丢弃数）、`error_count`（错误数） 与 `flush()`（刷盘）;online runtime（在线运行时）同步更新 `LlmDiagnosticSummary`（LLM 诊断摘要） 后只 enqueue（投递）本地 JSONL（结构化日志）,状态接口用 live stats（实时统计）覆盖旧摘要中的 `diagnostic_sink`（诊断汇点）;`git diff --check`（差异空白检查）通过,`pnpm typecheck`（类型检查）通过,定向 Vitest（测试框架） 首次触发既有 mine（挖掘）慢测超时,单测复跑通过,`bash scripts/pre_review.sh`（评审前预检脚本） 最终全绿,34 个 test file（测试文件）/393 个 test（测试）通过;审查时真实本地 OpenAI compatible API（OpenAI 兼容接口） 调用返回 `T065 async diagnostics ok 喵~`,flush（刷盘）前 `diagnostic_sink.queued=1`,flush 后 `queued=0` 且 JSONL（结构化日志）落盘、密钥脱敏、metrics（指标）存在
- 关键决策: 把本地 JSONL（结构化日志）落盘从 LLM（大语言模型） stage（阶段执行器）主路径移到 app（应用装配）创建的共享 AsyncDiagnosticSink（异步诊断汇点）,conversation（对话） 与 brain（大脑） 复用同一有界旁路;队列满时通过 `getDropPriority`（丢弃优先级函数）优先保留失败诊断,成功类 brain（大脑）记录低于 chat/plan（闲聊/规划）记录;写入失败只累计错误数并保留状态可观测,不向 Chat（闲聊）/Plan（规划）/BrainWorker（大脑工作线程）冒泡;T-064（任务）中的 `diagnostics_write_ms`（诊断写入耗时） 在异步落盘语义下保持 `null`,用 `diagnostic_sink`（诊断汇点）统计表达后台写入状态,避免为非阻塞写入伪造同步耗时
- 架构冲突: 无

## T-082 | 2026-05-15 | 沙箱执行链路内部组件拆分

- 涉及模块: sandbox（沙箱） execution/bootstrap/host-call/result-factory/resource-limits/execution-control/errors/validators,core-ports（核心端口） sandbox 契约,diagnostics（诊断） sandbox JSONL,domain（领域）不变量
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,把沙箱执行从大而全模块拆成执行器、API 注入、结果规范化、生命周期汇总等职责清晰的内部组件;边界限定 sandbox、core-ports、domain、diagnostics,不得顺手改 Prompt 语义,不得恢复旧 SkillCall / sandbox_code 双路径;若确需保留旧语义只能隔离为 legacy/replay-only 并交用户评估
- C 审查结论: 通过。实现把 `src/sandbox/execution.ts` 收敛为 isolated-vm 执行编排入口,资源限制与静态预检移入 `resource-limits.ts`,沙箱语义 API 注入移入 `bootstrap.ts`,Host Call / Facade 分发与步骤记录移入 `host-call.ts`,请求/步骤/终态结果工厂移入 `result-factory.ts`,abort/deadline/active call 管理移入 `execution-control.ts`,错误归一与契约校验分别移入 `errors.ts` 和 `validators.ts`。Reviewer 复核在线执行入口仍只接受 `ExecutionTaskKind.Code`,`createSandboxExecutionRequest` 固定写入 code 任务,`rg` 未发现在线 `SkillCallJob` / `SandboxCodeJob` / `ExecutionTaskKind.Skill` 写入路径;`skill_call` / `sandbox_code` 仅保留在 Plan parser/prompt 禁止项、历史进度与负向测试中。当前 `git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `sandbox-diagnostics-model.spec.ts` + `runtime-actor-model.spec.ts` 为 54 passed / 7 skipped,`bash scripts/pre_review.sh` 全绿,36 个 test file /471 passed/7 skipped
- 关键决策: 选择在 `sandbox` 包内做内部职责拆分,保持对外 `executeSandboxCodeRequest` / `executeCodeRequest` 兼容导出,而不是同时重命名外部调用面或修改 Prompt;Host Call 仍只通过 `SandboxFacadeExecutionAdapter` 端口触达 BotActor/skill/toolchain,不让 sandbox 直接依赖 runtime 或 app;失败、中断、超时和 FacadeCallError 的结构化物化继续由统一工厂与校验器守门
- 架构冲突: 无

## T-083 | 2026-05-15 | 在线沙箱旧 API 执行面清理

- 涉及模块: sandbox（沙箱） bootstrap/执行入口,conversation parser（对话规划解析器）与规划测试,core-ports（核心端口） code job 契约,workers/app/runtime 相关测试夹具
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,让在线沙箱执行面只暴露 `reply` / `runGoal` / `ensure` / `until` / `mine` / `cutTree` / `craft` / `place` / `equip` / `collect` / `report` 等语义函数;旧 `api.bot` / `api.chat` / `api.task` / `api.owner` 不得继续作为在线可见面或测试主路径,若必须存在只能隔离为 legacy/replay-only 并交用户评估;边界限定 sandbox、conversation parser、conversation tests、core-ports,不改 BotActor 单写者
- C 审查结论: 通过。实现从 `src/sandbox/bootstrap.ts` 删除 `globalThis.api` 注入,在线沙箱只把顶层语义函数与只读 `owner` 注入全局;`__sandboxHostCall` / `__sandboxHostRead` 仍在 bootstrap 闭包内保存引用并立即从 `globalThis` 删除,不暴露给代码。`parseConversationCodePlan` 继续要求唯一 `code` 字段,并新增 `api.bot` / `api.chat` 规划门禁;测试 helper 与 app/conversation/runtime/sandbox 主路径 fixture 均改为 `reply(...)`、`mine(...)`、`cutTree(...)`、`place("crafting_table")` 等语义函数。Reviewer 复核 `rg` 结果: `src` 非测试里无 `globalThis.api`、无在线 `api.bot` / `api.chat` 调用,旧字符串仅保留在 prompt 禁止项、parser 错误文案、负向测试、历史文档和内部 facade 协议中。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `sandbox-diagnostics-model.spec.ts` + `conversation-llm-planning-model.spec.ts` + `runtime-actor-model.spec.ts` 为 84 passed / 7 skipped,`bash scripts/pre_review.sh` 全绿,36 个 test file /473 passed/7 skipped
- 关键决策: 选择直接删除在线可见 `api` 兼容别名,而不是继续保留旧接口作为过渡层;内部 Host Call 仍使用 `bot.mine` / `chat.say` 等 method name 作为 sandbox 到 `SandboxFacadeExecutionAdapter` 的私有分发协议,因为它不属于 LLM 可写 API 面,也不绕过 BotActor 单写者;`placeCraftingTable()` 不再作为沙箱顶层或旧 API 教学入口,主路径统一表达为 `place("crafting_table")`
- 架构冲突: 无

## T-084 | 2026-05-15 | runtime transport 运行时端口边界拆分

- 涉及模块: core-ports（核心端口） runtime 契约,runtime/transport（运行时传输层）类型与世界键读取,app/bootstrap（应用装配） runtime-core,world-model（世界模型） ResourceService 契约,skills（技能） cutTree 坐标挖掘端口,相关 runtime/observation 回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,把运行时传输层拆成世界状态读取、动作执行、事件诊断、世界标签读取等明确边界;所有世界、维度、world_key 只能走既有世界标签接口、ResourceService 或 transport 端口,业务层不得自行拼接世界名,动作执行和只读状态查询必须分清;边界限定 runtime/transport、world-model、ResourceService、diagnostics、core-ports,前置依赖 T-082
- C 审查结论: 通过。实现把跨模块共享运行时端口上提到 `src/core-ports/runtime.ts`,新增 `RuntimeWorldIdentityPort`、`RuntimeWorldResourceRefreshPort`、`RuntimeWorldStateReadPort`、`RuntimeWorldFactPort`、`RuntimeEventDiagnosticsPort`、`RuntimeActionExecutionPort` 等接口;`MineflayerRuntimeTransport` 作为 runtime 内部完整实现同时实现这些窄端口。`createAppRuntimeCoreResources` 按端口显式注入 `ResourceService`、mine/cutTree skill 与 toolchain ensure,`cutTree` 的坐标挖掘依赖改为 `RuntimeBlockDigActionPort`,`world-model` 的 ResourceService 端口改为继承核心端口。Reviewer 复核 `rg` 结果: `skills` / `world-model` 未直接 import `runtime/transport` 实现,非测试业务层没有自行读取 `bot.game.dimension`;transport 内部 `terrain-self-placed-memory` 与 `world-state-reset` 统一复用 `readMineflayerWorldKey`,避免世界键 fallback 分叉。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `observation-world-model.spec.ts` + `runtime-mineflayer-model.spec.ts` 为 119 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /474 passed/7 skipped
- 关键决策: 选择在 `core-ports/runtime.ts` 定义多个小端口,由 app 组合根把同一个真实 transport 按只读状态、世界身份、资源刷新、事实读取和动作执行切片注入,而不是继续把完整 `MineflayerRuntimeTransport` 传给 skill/world-model;BotActor 仍作为单写者持有可执行动作能力,app 组合根仍可持有完整 transport 用于生命周期、状态快照和装配,这不构成业务层绕过端口;世界键读取在 transport 内部集中为 `readMineflayerWorldKey`,不在业务模块拼接维度字符串
- 架构冲突: 无

## T-085 | 2026-05-15 | 统一动作完成语义与条件检查器

- 涉及模块: sandbox（沙箱） bootstrap 语义动作注入,core-ports（核心端口） skills/task-result 契约,workers（工作线程） task-result-summary（任务结果摘要）,sandbox diagnostics（沙箱诊断）回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,实现统一动作结果规范化与 until 条件检查,让“成功”表示真实状态满足目标而不是动作没抛错;边界限定 sandbox、skills、runtime、domain、core-ports、task summary,验收要求单动作强语义,`until.gained(...)` 看执行前后背包差量,`until.has(...)` 看当前总量,`until.gainedDropOf(...)` 由运行时事实解析掉落关系,不得让 LLM 背 MC 掉落知识;前置依赖 T-082、T-084
- C 审查结论: 通过。实现把直接语义动作的完成证明规范化集中在 `src/sandbox/bootstrap.ts` 的沙箱语义函数边界: ensure 外部的 `mine`/`cutTree`/`craft`/`place`/`goTo`/`equip` 成功结果缺少可审计完成证明时转为 `unknown_completion`,数量低于请求时转为 `condition_not_met`;ensure 内部仍跳过直接动作规范化,以 baseline/current 条件检查作为最终裁决,避免破坏恢复闭环。`src/core-ports/skills.ts` 增加 `unknown_completion` 失败码,`src/core-ports/task-result.ts` 增加对应 Failure Capsule hint,`src/workers/task-result-summary.ts` 不再把 toolchain `ok:true` 但缺 `completed_count` 的结果默认当完成。Reviewer 复核 `rg` 结果: 未恢复在线 `api.bot`/`api.chat` 或旧 `SkillCallJob`/`SandboxCodeJob` 执行路径,MC 掉落事实仍由既有 ensure/facts 端口解析。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `sandbox-diagnostics-model.spec.ts` 为 39 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /477 passed/7 skipped
- 关键决策: 选择在沙箱语义 API 边界统一规范化直接动作结果,而不是让 task summary 事后猜测成功含义或让各 skill 重复生成失败包装;直接动作必须携带完成证明,ensure 任务仍以真实状态条件检查和恢复后复查为最高裁决。`unknown_completion` 用于表达“动作声称成功但没有证明”,防止任务总结继续把缺字段的 `ok:true` 当作完成;掉落关系、tag 统计和背包快照检查继续走 runtime/minecraft-data 事实端口与既有 ensure 条件检查器
- 架构冲突: 无

## T-086 | 2026-05-15 | 任务汇报输入收敛

- 涉及模块: workers（工作线程） task-report-facts/task-result-reporter,conversation/llm（对话大语言模型） report client/types,diagnostics（诊断） report LLM meta,app/report 相关回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,让最终用户汇报只消费统一任务摘要,不再由 skill 或 sandbox 各自拼机械文本;边界限定 conversation report、task summary、sandbox result、diagnostics,前置依赖 T-085;触碰 ReportLLM 与在线汇报链路,需实服验证。验收要求 ReportLLM 只能润色结构化事实不能发明结果,日志保留原始摘要和润色输出,任务完成后主动告知是否完成、获得了什么,失败则告知失败在哪里
- C 审查结论: 通过。实现新增 `src/workers/task-report-facts.ts`,把 `BrainTaskCard` / `TaskResultSummary` 投影为窄 `TaskReportFacts`,集中生成 `deterministic_report`、`fact_summary`、`required_facts` 与 `raw_summary_digest`;`src/workers/task-result-reporter.ts` 删除散落的成功/失败解释逻辑,只消费该投影并把窄事实传给 ReportLLM;`src/conversation/llm/client.ts` 在 report 阶段 diagnostics 记录 `raw_summary_digest`、`report_facts_json`、`deterministic_template`、`llm_polished_output`、`final_selected_output` 与 `fallback_reason`,且 `parseConversationReport` 继续用 `required_facts` 拦截丢事实或把失败说成成功的输出。Reviewer 复核 `rg` 结果: 未恢复在线 `api.bot`/`api.chat` 或旧 `SkillCallJob`/`SandboxCodeJob` 执行路径,`report_facts_json` 不包含 exec job 或 TS 源码。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `report-llm-model.spec.ts` + `app-entrypoint-model.spec.ts` 为 34 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /478 passed/7 skipped。真实线上任务 `30b77ea4-6b9f-4880-a375-8bc406df0f08` 由用户实服触发,内容“给我挖6个石头,然后回到我这来”,生产指标显示 triage/plan ok、`task.completed`、`step_count=5`、`duration_ms=56588`,随后 report LLM ok,`input_tokens=437`、`output_tokens=34`;对应 `logs/llm/2026-05-15/report-30b77ea4-6b9f-4880-a375-8bc406df0f08:task_result.jsonl` 同时保留确定性模板、窄事实 JSON、LLM 润色输出和最终选择输出,最终输出逐字保留 `完成`、`cobblestone x6`、`57s`、`世界 multiworld:resource`
- 关键决策: 选择把“事实投影 + 确定性模板 + 必须保留事实片段”集中在 workers 的 task-report-facts,让 ReportLLM 只做短句润色,而不是让各 skill/sandbox 或 reporter 分支各自拼用户话术;确定性模板是可靠兜底,LLM 输出只有在逐字保留 required facts 时才会成为 final selected output,否则自动回退模板并记录原因。raw summary 只作为 diagnostics digest 和 fact summary 来源,不把完整任务卡、执行代码、exec job 或内部状态暴露给汇报模型
- 架构冲突: 无

## T-087 | 2026-05-15 | Plan Prompt 收窄与正例重写

- 涉及模块: conversation/llm（对话大语言模型） Plan prompt（规划提示词）与 skill plan table（技能规划表）,conversation Plan parser（规划解析器）回归,Docs/04_CONVERSATION_SPEC.md（对话规格文档）,sandbox（沙箱） runGoal/ensure 完成证明聚合,相关规划与沙箱诊断测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,把 Plan Prompt 收敛成硬约束、语义 API、少量正确 TS 正例,不再堆业务规则和 MC（Minecraft）事实;边界限定 conversation/llm、prompt templates、plan parser、eval/diagnostics,前置依赖 T-083/T-085/T-086;触碰 LLM Prompt 与 Plan 链路,需真实 OpenAI compatible API（OpenAI 兼容接口）验收。验收要求硬约束重复强调只输出 `{"code":"..."}`,示例使用 reply → runGoal → ensure/until → report,不出现旧 `skill_call`、自然语言解释、`api.bot`、`api.chat`,不写死配方、掉落、工具等级、世界名
- C 审查结论: 曾打回 1 次。首轮 Prompt 收窄方向正确,`src/conversation/llm/prompts/plan.ts` 删除 collect 半径业务规则、具体方块枚举、掉落/工具链百科与旧接口字面量,`src/conversation/llm/skill-plan-table.ts` 把 `mine` 参数从固定方块枚举收窄为 `blockName:string`,文档同步到 Plan Prompt v4,规划测试覆盖 ensure/until 正例和旧接口负向门禁;但实服任务 `8e49468e-e7a3-4498-829c-b33d9d216a32` 暴露 `ensure(cutTree(5), until.gainedTag("logs", 5)); goTo(owner)` 完成后汇报 `logs x1` 的摘要污染。Reviewer 定位到 `src/sandbox/bootstrap.ts` 的 `runGoal` 成功聚合用原始 cutTree 动作摘要和后续 goTo 稀释了 ensure 的最终 `condition_evaluation`,导致 `requested_count:5/completed_count:1` 仍作为 completed 进入 report facts;返修后 runGoal 记录 ensure 成功的条件验收结果,汇总时用它替换 ensure 内部原始动作摘要,goTo 只保留在 `action_results` 步骤事实中,不再稀释资源完成证明。Reviewer 复核 `rg` 结果: Plan Prompt 本体不含 `skill_call` / `sandbox_code` / `api.bot` / `api.chat` / `cobblestone` / `raw_iron`,旧接口只保留在 parser/沙箱负向测试和禁止文案中;未新增 MC 事实硬编码或世界键拼接。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `conversation-llm-planning-model.spec.ts` 为 29 passed,`sandbox-diagnostics-model.spec.ts` 为 40 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /479 passed/7 skipped。真实 `pnpm benchmark:llm -- --run-id t087-review-live --out logs/eval/t087-review-live.jsonl` 走默认本地网关 `http://127.0.0.1:8045/v1` / `bl-auto`,3 个 Plan 样本严格解析与 code-only 均通过,`plan_code_strict_parse_success_rate=1`,无规划门禁/静态预检失败;用户实服触发的 `8e49468e-e7a3-4498-829c-b33d9d216a32` 也显示新 Prompt 生成严格 JSON、`ensure + cutTree + until.gainedTag("logs",5) + goTo(owner) + report(task)`,且 Plan 行 `plan_parse_ok:true`、`plan_code_only_ok:true`
- 关键决策: 选择让 Plan Prompt 只教“唯一 JSON code 载荷、语义 API、runGoal/ensure/until/report 代码形状、search 边界和少量正反例”,不再把资源映射、collect 搜索半径扩展、工具链、配方、掉落或世界键规则灌进 Prompt;旧 `skill_call` / `sandbox_code` / `api.bot` / `api.chat` 继续由 parser 和沙箱负向门禁兜底,不作为在线执行面。对 `logs x1` 返修选择修 sandbox 的完成证明来源,而不是在 `task-result-summary` 或 Reporter 下游加兜底,避免把错误藏进汇报层
- 架构冲突: 无

## T-088 | 2026-05-15 | 拆分 skill 公共契约并严格化结果工厂

- 涉及模块: core-ports（核心端口） skill-catalog/skill-results/skill-toolchain/skill-adapters 契约拆分,workers（工作线程） task-result-summary 兼容摘要读取,sandbox diagnostics（沙箱诊断）与 skill 契约测试,运行时技能测试适配
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,并明确不得用多层兜底掩盖错误;T-088 目标是把过胖 `core-ports/skills.ts` 拆成技能目录/参数、执行结果、工具链 ensure、执行适配器等窄契约,同时移除会伪造成功的默认值。边界限定 core-ports、skills、sandbox、runtime actor、测试;前置依赖 T-085/T-087;兜底约束为缺完成证明必须失败或显式 `unknown_completion`,不能默认补成成功,provider 异常和兼容路径命中也不能静默吞掉
- C 审查结论: 曾打回 1 次。首轮拆分方向符合架构,`src/core-ports/skills.ts` 已收敛为 re-export barrel（兼容导出入口）,新增 `skill-catalog.ts`、`skill-results.ts`、`skill-toolchain.ts`、`skill-adapters.ts`,且 core-ports 仍只依赖类型与纯校验,没有反向 import runtime/skills/sandbox 实现;但 `createMineSkillExecutionResult` 仍允许 `collected_item_name:null` 在有数量字段时成功,`src/workers/task-result-summary.ts` 的 `readSandboxSkillResult` 兼容路径也会把缺 proof 的 `skill:"mine"` 包装成默认 completed summary。返修后 `mine` 成功结果强制要求非空 `collected_item_name`,缺失/`null`/空白字符串均抛 `SkillCompletionProofError` 且错误码为 `unknown_completion`;summary 兼容路径对 `mine` 强制要求 `collected_item_name`、`collected_count`、`mined_count`,缺任一字段返回 failed summary / `unknown_completion`,并保留 `collect()` 模糊目标语义: `item_name:null` 合法,但必须有真实 `collected:[...]` 背包 diff,缺数组不得包装成 completed。Reviewer 复核未新增 MC 掉落、配方、工具等级硬编码,`collected_item_name` 只作为运行时事实层传回的完成证明字段使用,不由 summary 猜测。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `skills-model.spec.ts` + `sandbox-diagnostics-model.spec.ts` 为 56 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /481 passed/7 skipped
- 关键决策: 选择把公共 skill 契约按变化原因拆成四个窄文件,保留 `skills.ts` 作为兼容 barrel,而不是让一个 god file 同时承载目录、参数校验、执行结果、toolchain ensure 与适配器端口;结果工厂从“缺字段时补默认成功”改为“资源强语义动作必须携带真实完成证明”,其中 `mine` 必须带运行时解析出的真实入包物名和数量,`cutTree` 必须带原木获得数量与显式完成状态,`collect` 可模糊目标但必须带真实收集差量。兼容 summary 路径只做历史结果读取,命中缺 proof 时结构化失败,不再作为下游兜底伪造成功
- 架构冲突: 无

## T-089 | 2026-05-15 | 收敛 Craft / Placement 职责并保留工具链自动恢复

- 涉及模块: runtime/transport（运行时传输层） placement/craft 交互边界,skills（技能层） toolchain-ensure（工具链确保）,core-ports（核心端口） skill-toolchain/task-result 失败码,workers（工作线程） task-report-facts（汇报事实）,runtime/skills 回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,并明确允许 fallback 但必须有业务理由、结构化诊断和测试证明不伪造成功。T-089 目标是拆清 Craft / Placement / Toolchain 职责: CraftService 只负责合成和材料/工作台需求判断,PlacementService 只负责放置工作台并返回位置或失败原因,Toolchain / Ensure 负责根据缺工具、缺工作台、缺材料等结构化失败串联恢复链,恢复后回到原任务继续执行;不得硬编码 MC 配方、材料、工作台需求,不得把 `missing_materials`、`no_placeable_position`、`crafting_table_required`、`craft_failed` 等错误包装成泛化失败或完成
- C 审查结论: 通过。实现从 `src/runtime/transport/placement.ts` 删除 `executeMineflayerCraft` 依赖和 `ensureCraftingTableItem` 递归合成逻辑,裸 `place("crafting_table")` 在背包没有工作台物品时返回 `missing_crafting_table_item`,不再偷偷合成木板/工作台;`src/skills/toolchain-ensure.ts` 新增 `ensureCraftingTablePlaced`,在 Toolchain 层处理 `missing_crafting_table` / `missing_crafting_table_item`: 背包无工作台时先调用 craft,再调用 place,再回到原合成/装备/挖掘目标。`crafting_table_required`、`craft_failed`、`missing_crafting_table_item` 等错误码进入核心契约、Failure Capsule 分类和 report facts 建议,底层失败详情通过 actions 和 error.details 保留。Reviewer 复核未新增 MC 配方/掉落/工具等级硬编码,Phase 1 craft allowlist 仍只限制可合成目标,配方与工作台需求继续来自 Mineflayer/minecraft-data。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `skills-model.spec.ts` + `runtime-mineflayer-model.spec.ts` 为 119 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /482 passed/7 skipped
- 关键决策: 选择让 Placement 只检查并放置已有工作台物品,把“没有工作台物品时是否先合成、合成失败是否继续恢复”统一收敛到 ToolchainEnsure,而不是在放置层保留递归合成兜底。Craft 仍可在合成域内根据真实 recipe 递归补齐中间合成物,但不负责找位置或放置工作台;Toolchain 负责跨能力编排,并在缺材料时返回原始 `missing_materials` 供上层恢复或汇报,不伪造完成。普通 place 与自动恢复链都通过相同 `place("crafting_table")` 端口执行,保证 DRY 和单写者边界不分叉
- 架构冲突: 无

## T-090 | 2026-05-15 | Conversation 规划执行处理器拆分

- 涉及模块: workers（工作线程） conversation-worker plan-exec 规划执行处理,conversation context（对话上下文） provider 降级诊断,diagnostics（诊断） conversation reply log 与 production metrics,tasking（任务） ExecJob 构造与 BotWorkerTask 入队,conversation-worker 回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,并明确不得用多层兜底掩盖错误。T-090 目标是把当前过胖的规划执行处理器拆成上下文读取、continuation 判定、LLM 规划、ExecJob 构造、入队、指标/日志几个小组件;边界限定 conversation worker、conversation context、diagnostics、production metrics、tasking;provider 可降级但必须记录诊断,LLM/规划失败不能伪装成普通无上下文成功;触碰规划链路需真实 LLM 验收
- C 审查结论: 通过。实现把 `src/workers/conversation-worker/handlers/plan-exec.ts` 收敛为 135 行编排入口,新增 `plan-exec/context.ts`、`continuation.ts`、`planner.ts`、`job.ts`、`dispatch.ts`、`metrics.ts`、`types.ts` 等内部组件。`context.ts` 只负责读取 recent/memory/brain/resource/environment snapshot 上下文并把 provider 异常转成 `conversation.context_provider_failed` 结构化事件;`planner.ts` 只封装 LLM planner 调用并区分 `planner_failed` / `skill_not_enabled`;`continuation.ts` 只处理 continuation、recovery_chain 与 retry_guard;`job.ts` 与 `dispatch.ts` 分别负责 ExecJob/BotWorkerTask 构造和 interrupt/recent context/入队/brain fact;`metrics.ts` 保留 plan accepted/discarded 生产指标旁路写入。Reviewer 复核 provider 失败不再无痕 `catch { return undefined }`,规划失败仍广播模板回复、追加 recent context、写 conversation reply log、推 `task.discarded` 事件并落 `conversation.plan_discarded` 指标;成功路径只构造 code ExecJob 并入队 BotWorker,未恢复旧 SkillCall/sandbox_code 双路径,未暴露 `api.bot`/`api.chat`,未触碰 Mineflayer 真实对象或 world_key。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `conversation-worker-runtime-model.spec.ts` 为 36 passed,真实 `pnpm eval:llm -- --run-id eval-t090-review --out logs/eval/eval-t090-review.jsonl` 通过本地 OpenAI-compatible 网关,6 个样本全部 passed,Plan 3/3 严格解析与 code-only 通过,`bash scripts/pre_review.sh` 全绿,36 个 test file /483 passed/7 skipped
- 关键决策: 选择按变化原因拆出 plan-exec 内部组件,而不是继续在一个 handler 里维护上下文读取、恢复判断、LLM 调用、入队和指标。上下文 provider 降级被视为可恢复的输入缺失,但必须以结构化事件记录 provider 名称和错误摘要;LLM planner 缺失或失败、skill 未启用、implementation blocker 与 retry_guard 重复仍作为规划丢弃处理,不会被伪装成“无上下文但规划成功”。production metrics 与 conversation reply log 仍是旁路诊断,写入失败不影响真实回复/入队,但主规划与入队依赖缺失继续抛错,防止关键执行链被静默吞掉
- 架构冲突: 无

## T-091 | 2026-05-15 | runtime / sandbox 兼容出口收敛

- 涉及模块: runtime（运行时） public index 与 transport test-only 出口,sandbox（沙箱） bootstrap/host-call/contracts/resource-limits/legacy facade,core-ports（核心端口） sandbox 与 legacy skill-call,skills（技能） legacy execution,app bootstrap（应用装配） scaffold 诊断契约,相关 sandbox/runtime/app/skills 回归测试
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,并明确不得用多层兜底掩盖错误。T-091 目标是隔离或清理跨层兼容入口,避免新代码继续通过宽 barrel export、旧 Facade 契约、旧 SkillCall 结构穿透边界;抽象边界限定 runtime transport、sandbox、core-ports、skills、测试;前置依赖 T-083/T-084/T-088;兜底约束为 legacy 只能命名为 legacy/replay/test-only,不能作为在线路径备用方案
- C 审查结论: 曾打回 1 次。首轮实现已把旧 Facade 移到 `sandbox/legacy`、旧 SkillCall 移到 `core-ports/legacy` 与 `skills/legacy`,并收窄 `runtime/index.ts`、`sandbox/index.ts`、`skills/index.ts`,但 Reviewer 实测发现 bootstrap 顶层 `const __sandboxTryCall` / `__sandboxCall` / `__sandboxRead` 在同一 isolate 后续用户脚本仍可直接访问,导致 `await __sandboxTryCall("bot.placeCraftingTable", [{}])` 能绕过语义 API 调到 host bridge;同时 `placeCraftingTable` 仍在在线 sandbox action/capability 中,普通 `runtime/transport.ts` 仍作为未命名 legacy 的宽导出。返修后 `bootstrap.ts` 把 host bridge helper 包进 IIFE 闭包,`resource-limits.ts` 增加 `sandbox_internal_bridge` 静态禁用项,Reviewer 复测直接写 `await __sandboxTryCall("bot.place", [{ blockName: "crafting_table" }])` 返回 `StaticCheckError` 且 hostBridge 调用数为 0;在线 `SANDBOX_BOT_METHOD_NAMES`、`ToolchainCapabilityName`、`host-call.ts`、`runtime/actor.ts` 均移除 `placeCraftingTable`,主路径只保留 `place("crafting_table")`;普通 `runtime/transport.ts` 与 `runtime/transport/index.ts` 删除,测试宽导出改为 `runtime/transport/test-only.ts`。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `sandbox-diagnostics-model.spec.ts`、`runtime-mineflayer-model.spec.ts`、`app-entrypoint-model.spec.ts`、`app-smoke-model.spec.ts`、`runtime-skill-execution-model.spec.ts`、`skills-model.spec.ts` 为 213 passed,`bash scripts/pre_review.sh` 全绿,36 个 test file /484 passed/7 skipped。Reviewer 静态复核 `src` 非测试在线路径无 `ExecutionTaskKind.SkillCall`、无 `SkillCallJob`/`SandboxCodeJob`、无普通 `runtime/transport` 宽入口引用、无在线 `api.bot`/`api.chat`/`placeCraftingTable` 执行面;旧 Facade 与旧单技能调用只在 `legacy` 目录、scaffold 迁移诊断或负向测试中显式出现
- 关键决策: 选择把旧 Facade 契约和旧单技能调用结构改成显式 `legacy` 命名空间,并把 runtime transport 宽导出改成 `test-only` 入口,而不是继续从根入口或普通模块路径自然暴露;内部 host bridge 仍作为沙箱语义函数到 BotActor 单写者的私有闭包协议存在,但不再能被 Plan TS 直接引用或通过 `__sandbox*` 符号绕过语义 API。`placeCraftingTable` 保留为 PlacementService/transport 内部实现细节,不再是 sandbox action/capability;放置工作台的在线表达统一为 `place("crafting_table")`
- 架构冲突: 无

## T-092 | 2026-05-15 | 测试主路径迁移与 legacy fixture 隔离

- 涉及模块: src/__tests__ 测试夹具与 scaffold 守门,runtime actor / BotWorker 测试,sandbox diagnostics 测试,skills 与 legacy skill execution 测试,test-skill-proofs 测试专用完成证明工厂
- A 拆解依据: 用户要求默认按“唯一 TS 代码规划 + 沙箱语义函数 + BotActor 单写者”收敛,并明确不得用多层兜底掩盖错误。T-092 目标是把测试默认正确路径改成纯 TS 语义 API、真实完成证明、结构化失败;旧接口只保留负向测试或明确 legacy 测试。边界限定测试、sandbox、conversation、runtime actor、skills;前置依赖 T-088/T-091;兜底约束为测试不得通过宽松 mock 和默认成功掩盖缺字段,mock 必须给出真实完成字段或显式失败
- C 审查结论: 通过。实现把旧 `LegacySkillCall` 构造测试拆到 `skills-legacy-model.spec.ts`,旧 `executeSkillInvocation` 执行入口测试拆到 `runtime-skill-legacy-execution-model.spec.ts`,普通 `runtime-skill-execution-model.spec.ts` 改为直接测试新主路径 skill executor。新增 `test-skill-proofs.ts`,测试专用 mine 成功工厂要求调用方显式传入 `collectedItemName`、`collectedCount`、`minedCount`,不再根据 `params.blockName` 猜掉落物;collect 测试工厂也要求显式 `collected:[...]`。`bot-worker-runtime-model.spec.ts` 的 `createCompletedCodeResult` 不再默认 `{ ok:true }`,调用点必须给出 goTo/equip/toolchain 的结构化结果。`scaffold.spec.ts` 增加静态守门: 除 `skills-legacy-model.spec.ts`、`runtime-skill-legacy-execution-model.spec.ts`、`sandbox-diagnostics-model.spec.ts` 和自身迁移/负向测试外,测试文件不得自然 import `../skills/legacy`、`../core-ports/legacy`、`../sandbox/legacy` 或出现 `createLegacySkillCall` / `executeSkillInvocation`;旧 `api.bot` / `api.chat` 也只能出现在 LLM prompt 防回归或负向测试中。Reviewer 静态复核 `src/__tests__` 中旧 SkillCall/legacy executor 只在 legacy 命名测试里出现,普通资源类 mock 未发现 `collected_item_name: params.blockName` 或 `result ?? { ok:true }` 伪成功路径;`scripts/probes/brain-task-event-probe.ts` 仍有历史 `ExecutionTaskKind.SkillCall` 探针输入,但它不在 T-092 抽象边界和在线/测试主路径内,不作为本任务阻塞项。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `runtime-skill-execution-model.spec.ts`、`runtime-skill-legacy-execution-model.spec.ts`、`skills-model.spec.ts`、`skills-legacy-model.spec.ts`、`bot-worker-runtime-model.spec.ts`、`runtime-actor-model.spec.ts`、`sandbox-diagnostics-model.spec.ts`、`scaffold.spec.ts` 为 112 passed / 7 skipped,`bash scripts/pre_review.sh` 全绿,38 个 test file /487 passed/7 skipped
- 关键决策: 选择把旧调用形态从普通测试文件移到显式 `legacy/test-only` 测试,并增加 scaffold 静态守门,让测试体系成为新语义 API 和严格完成证明的约束来源;测试 helper 只负责减少样板,不再替调用方猜 Minecraft 掉落事实或补默认成功。旧 Facade 契约测试保留在 `sandbox-diagnostics-model.spec.ts` 作为 legacy/test-only 与负向门禁验证,不是在线主路径夹具
- 架构冲突: 无

## T-093 | 2026-05-15 | 错误与 fallback 策略收口

- 涉及模块: core-ports（核心端口） task-result 失败分类,workers（工作线程） conversation-worker / task-result-summary / task-report-facts / task-result-reporter,diagnostics（诊断） async-sink / task-log-reader,runtime（运行时） actor / transport mine/runtime,sandbox（沙箱） errors,相关 conversation/report/runtime/sandbox 回归测试
- A 拆解依据: 用户要求不得用多层兜底掩盖错误,允许 fallback 但必须有明确业务理由、结构化诊断和测试证明不会伪造成功。T-093 目标是专项清理多层 fallback、空 catch、默认 unknown 成功、重复 recoverable 推断,把错误归属固定到单一层;抽象边界限定 conversation、workers、sandbox、runtime、diagnostics;前置依赖 T-090/T-091/T-092;兜底约束为允许降级必须说明原因,不可降级错误必须暴露为结构化失败,旁路日志失败可以不阻塞主流程但要有最小可观测记录
- C 审查结论: 曾打回 1 次。首轮实现已把 `recoverable` 口径收敛到 `src/core-ports/task-result.ts`,新增 `resolveFailureRecoverable`,并让 `task-result-summary`、`task-report-facts` 复用统一分类;conversation 的 triage/chat/plan provider 异常会推 `conversation.context_provider_failed`,生产指标、conversation reply log、ReportLLM fallback、异步诊断 sink 与任务日志 excerpt 失败都保留 `console.warn` 最小可观测记录,不再空 catch。但 Reviewer 发现 `src/runtime/transport/mine.ts` 的 `scanNearbyTargets` 仍会在 `findBlocks` 缺失或抛错时返回空数组,上层把 provider 异常伪装成 `unsafe_path:no_visible_target`;同时 `createSandboxTerminalResultSummary` 对 terminal sandbox failure 缺显式 `recoverable` 时仍返回 `null`,没有接上统一分类。返修后 `findBlocks` 缺失或抛错直接抛 `runtime_adapter_error:scan_nearby_targets:*`,details 携带 `failure_stage`、`provider`、`block_name`、`requested_count`、`reason` 与 `cause_summary`,不再走空候选路径;terminal sandbox failure 保留显式 `recoverable`,缺失时统一调用 `resolveFailureRecoverable(failureCode)`。Reviewer 静态复核 `src` 目标范围无生产空 `catch {}`,剩余空 catch 只在沙箱负向测试中用于验证只读对象不可变;`findBlocks_unavailable` / `findBlocks_failed` 均有结构化错误和回归覆盖。`git diff --check` 通过,`pnpm typecheck` 通过,`pnpm lint` 通过,定向 Vitest `runtime-mineflayer-model.spec.ts`、`sandbox-diagnostics-model.spec.ts`、`conversation-worker-runtime-model.spec.ts`、`report-llm-model.spec.ts` 为 189 passed,`bash scripts/pre_review.sh` 全绿,38 个 test file /491 passed/7 skipped
- 关键决策: 选择把失败恢复性分类收敛到 core-ports 的单一函数,让 summary 与 report facts 只消费统一口径,不在多层重复猜测。上下文 provider 降级被视为可运行的输入缺失,但必须进入 `conversation.context_provider_failed`;生产指标、reply log、ReportLLM 和诊断 sink 是旁路能力,失败不阻断主流程但必须写最小诊断。runtime `findBlocks` 属于 mine 主链路世界查询 provider,不是旁路能力,因此异常不能降级成“附近没目标”,必须暴露为结构化 runtime adapter 失败
- 架构冲突: 无
