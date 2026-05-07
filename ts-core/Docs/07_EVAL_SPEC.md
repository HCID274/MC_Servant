# 评测与生产指标契约规格

本文定义两类本地 JSONL 数据格式：离线 LLM eval runner 的评测结果，以及真实线上运行自动落盘的生产指标事件。当前阶段都只落本地文件，不接 `event_log`，不改 PostgreSQL schema，不改外部 HTTP API。

## 1. 存储边界

- LLM 离线评测输出：`logs/eval/YYYY-MM-DD/<run_id>.jsonl`
- LLM 样本输入：`scripts/eval/cases/llm-stage-cases.jsonl`
- 生产指标事件输出：`logs/metrics/YYYY-MM-DD/production-metrics.jsonl`
- `logs/eval` 不作为业务真理源，只用于固定样本离线评测、回放和汇总。
- `logs/metrics` 记录真实线上调用，由生产链路自动追加，不依赖主动 eval CLI。
- LLM API key、OpenAI key、连接串密码等敏感值必须脱敏后写入。

## 2. 离线 eval JSONL 行类型

所有行带 `schema_version:"ts-core.eval.v1"`。

| kind | 用途 |
|---|---|
| `case` | 固定评测样本 |
| `run` | 一次 runner 执行的开始/结束摘要 |
| `attempt` | 单个 LLM case 的调用结果 |
| `metric` | 从本次 run 的 attempts 汇总出的指标 |

## 3. LLM 离线评测指标

| id | 含义 | 分母 |
|---|---|---|
| A1 | Plan 阶段 `{code}` 严格解析成功率 | `stage=plan` attempts |
| D1 | Stage 1 Triage 平均延迟 | `stage=triage` attempts |
| D2 | Stage 2 Plan 平均延迟 | `stage=plan` attempts |
| D3 | 两阶段路由避免进入 Plan 的输入 token 节省比例估算 | 带 `token_saving_probe` 的 attempts |
| E2 | Plan 输出触发静态预检或规划门禁失败比例 | `stage=plan` attempts |

A2 代表早期 baseline Plan 解析成功率；当前没有可比历史数据输入，本阶段不定义、不输出。

## 4. 生产指标事件

所有生产指标事件带 `schema_version:"ts-core.metric.v1"`，每次真实线上运行自动追加到 `logs/metrics/YYYY-MM-DD/production-metrics.jsonl`。

字段基线：

| 字段 | 含义 |
|---|---|
| `event_id` | 单条生产指标事件 ID |
| `event_type` | `llm.stage`、`conversation.plan_accepted`、`conversation.plan_discarded`、`task.started`、`task.completed`、`task.failed`、`task.interrupted`、`task.discarded` |
| `message_id` | 主人消息 ID；没有时显式为 `null` |
| `task_id` | 执行任务 ID；没有时显式为 `null` |
| `bot_id` | 目标 Bot ID |
| `root_goal_id` | 根目标链路 ID；当前未建链路时为 `null` |
| `recovery_chain_id` | 恢复链路 ID；当前未建链路时为 `null` |
| `created_at` | 事件创建时间 |
| `source` | `conversation_llm`、`conversation_worker`、`bot_worker` |
| `prompt_version` | prompt 版本；当前未显式版本化时为 `null` |
| `model` | LLM 模型；非 LLM 事件为 `null` |
| `stage` | `triage`、`chat`、`plan`、`report`、`brain`、`execution`、`recovery` |
| `ok` | 本事件是否成功 |
| `error_code` | 失败码；成功或无失败码时为 `null` |
| `duration_ms` | 阶段或任务耗时；不可得时为 `null` |
| `input_tokens` | 输入 token；非 LLM 事件为 `null` |
| `output_tokens` | 输出 token；非 LLM 事件为 `null` |
| `plan_parse_ok` | Plan 严格 JSON 解析是否成功；非 Plan 事件为 `null` |
| `plan_code_only_ok` | Plan 输出是否为唯一 `code` 字段；非 Plan 事件为 `null` |
| `plan_gate_failure_type` | Plan parser 规划门禁失败类型；未失败或非 Plan 事件为 `null` |
| `plan_static_precheck_failure_type` | sandbox static precheck 失败类型；未失败或非 Plan 事件为 `null` |
| `terminal_status` | BotWorker 执行终态：`completed`、`failed`、`interrupted`、`discarded`；非执行终态为 `null` |
| `step_count` | BotWorker 执行终态步骤数；不可得或非执行终态为 `null` |
| `is_manual_intervention` | 是否人工干预；当前 `control` 中断为 `true`，其他执行终态为 `false`，非执行终态为 `null` |
| `recovery_class` | 失败恢复分类：`recoverable`、`implementation_blocker`、`unknown`；非失败恢复相关事件为 `null` |
| `replan_count` | 同一恢复链中已经历的重规划次数；失败根为 `0`，非恢复事件为 `null` |

生产指标派生口径：

| 指标名 | 含义 | 来源 |
|---|---|---|
| `plan_code_strict_parse_success_rate` | Plan `{code}` 严格解析成功率 | `stage=plan` 的 `llm.stage.plan_parse_ok` |
| `plan_code_only_success_rate` | Plan 只输出 `code` 字段的成功率 | `stage=plan` 的 `llm.stage.plan_code_only_ok` |
| `plan_gate_failure_rate` | Plan 输出触发规划门禁失败的比例 | `stage=plan` 的 `llm.stage.plan_gate_failure_type` |
| `plan_static_precheck_failure_rate` | Plan 输出触发静态预检失败的比例 | `stage=plan` 的 `llm.stage.plan_static_precheck_failure_type` |
| `triage_average_latency_ms` | Triage 平均延迟，单位毫秒 | `stage=triage` 的 `llm.stage.duration_ms` |
| `plan_average_latency_ms` | Plan 平均延迟，单位毫秒 | `stage=plan` 的 `llm.stage.duration_ms` |
| `chat_average_latency_ms` | Chat 平均延迟，单位毫秒 | `stage=chat` 的 `llm.stage.duration_ms` |
| `report_average_latency_ms` | Report 平均延迟，单位毫秒 | `stage=report` 的 `llm.stage.duration_ms` |
| `llm_input_tokens_total` | LLM 输入 token 总数 | 所有 `llm.stage.input_tokens` |
| `llm_output_tokens_total` | LLM 输出 token 总数 | 所有 `llm.stage.output_tokens` |
| `execution_task_run_count` | 进入终态的真实任务数量 | `source=bot_worker` 且 `terminal_status != null` |
| `execution_no_manual_completion_rate` | 端到端无人工干预完成率 | `terminal_status=completed && is_manual_intervention != true` / 全部可统计终态任务 |
| `execution_average_duration_minutes` | 单次平均耗时，单位分钟 | 终态任务事件的 `duration_ms / 60000` |
| `execution_average_step_count` | 单次平均步骤数 | 终态任务事件的 `step_count` |
| `execution_failed_count` | 失败终态数量 | `terminal_status=failed` |
| `execution_interrupted_count` | 中断终态数量 | `terminal_status=interrupted` |
| `execution_failure_code_count_by_code` | 失败码计数分布 | `terminal_status=failed` 的 `error_code`，缺失归为 `unknown` |
| `recoverable_failure_count` | 可恢复失败根数量 | `terminal_status=failed && recovery_class=recoverable && replan_count=0` |
| `recoverable_replan_success_rate` | 可恢复失败后自动重规划并最终完成的比例 | 同一 `recovery_chain_id` 下出现恢复执行完成 / 可恢复失败根数量 |
| `average_replan_count_to_success` | 成功恢复任务平均重规划次数 | 只统计最终恢复成功链路的完成事件 `replan_count` |
| `implementation_blocker_count` | 实现阻塞失败根数量 | `terminal_status=failed && recovery_class=implementation_blocker && replan_count=0` |
| `unknown_failure_count` | 未知失败根数量 | `terminal_status=failed && recovery_class=unknown && replan_count=0` |

T-074R 先定义事件契约与自动落盘；B/C 类指标后续从 `logs/metrics` 归档统计，不再把主动 eval CLI 作为主数据来源。

## 5. 固定 LLM 样本命名

当前基线样本：

- `case_triage_action`
- `case_triage_chat`
- `case_plan_cut_tree`
- `case_plan_mine_stone`
- `case_plan_place_or_goto_owner`
- `case_report_terminal_summary`

样本负责产生 attempt，A1/D1/D2/D3/E2 负责从一批 attempt 汇总统计；两者不得混用命名。

## 6. 运行命令

默认网关：

```bash
cd ts-core
pnpm eval:llm
```

显式配置：

```bash
cd ts-core
pnpm eval:llm -- --base-url http://127.0.0.1:8045/v1 --api-key sk-local-dev --model bl-auto
```

可选参数：

- `--cases <path>`：样本 JSONL；LLM 默认读取 `llm-stage-cases.jsonl`
- `--out <path>`：输出 JSONL，默认 `logs/eval/YYYY-MM-DD/<run_id>.jsonl`
- `--run-id <id>`：指定运行编号
- `--timeout-ms <ms>`：单次 LLM 请求超时

执行链路和失败恢复不再提供主方案 CLI。真实验收路径是启动正常 TS Core app，让生产 ConversationWorker/BotWorker/LLM 链路自然运行，然后检查 `logs/metrics/YYYY-MM-DD/production-metrics.jsonl`。

## 7. 当前限制

- token 统计优先使用 OpenAI-compatible API 返回的 usage；缺失时使用本地近似估算。
- 延迟统计优先使用 LLM diagnostics metrics；当前 Triage client 不返回 diagnostics，D1 使用 runner wall-clock 计时。
- D3 是离线估算，表示 chat 类样本不进入 Plan 时避免的固定 Plan prompt 输入 token。
- LLM runner 不执行 sandbox 代码，只对 Plan 输出调用现有静态预检和规划门禁。
- 旧的 `eval:execution` / `eval:recovery` in-process harness 已停用，不能作为 T-074R/T-075R 主验收证据。
- 生产指标当前不接 PostgreSQL schema，不接 `event_log`，不改外部 API。
