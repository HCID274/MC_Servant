# 评测契约规格

本文定义轻量 eval runner（评测执行器） 的本地 JSONL 数据格式。当前阶段只落本地文件，不接 `event_log`，不改 PostgreSQL schema，不改外部 HTTP API。

## 1. 存储边界

- 默认输出：`logs/eval/YYYY-MM-DD/<run_id>.jsonl`
- 样本输入：`scripts/eval/cases/*.jsonl`
- `logs/eval` 不作为业务真理源，只用于离线评测、回放和汇总。
- LLM API key、OpenAI key、连接串密码等敏感值必须脱敏后写入。

## 2. JSONL 行类型

所有行带 `schema_version:"ts-core.eval.v1"`。

| kind | 用途 |
|---|---|
| `case` | 固定评测样本 |
| `run` | 一次 runner 执行的开始/结束摘要 |
| `attempt` | 单个 case 的执行结果 |
| `metric` | 从本次 run 的 attempts 汇总出的指标 |

## 3. 指标编号

| id | 含义 | 分母 |
|---|---|---|
| A1 | Plan 阶段 `{code}` 严格解析成功率 | `stage=plan` attempts |
| D1 | Stage 1 Triage 平均延迟 | `stage=triage` attempts |
| D2 | Stage 2 Plan 平均延迟 | `stage=plan` attempts |
| D3 | 两阶段路由避免进入 Plan 的输入 token 节省比例估算 | 带 `token_saving_probe` 的 attempts |
| E2 | Plan 输出触发静态预检或规划门禁失败比例 | `stage=plan` attempts |

A2 代表早期 baseline Plan 解析成功率；当前没有可比历史数据输入，本阶段不定义、不输出。

## 4. 固定样本命名

当前基线样本：

- `case_triage_action`
- `case_triage_chat`
- `case_plan_cut_tree`
- `case_plan_mine_stone`
- `case_plan_place_or_goto_owner`
- `case_report_terminal_summary`

样本负责产生 attempt，A1/D1/D2/D3/E2 负责从一批 attempt 汇总统计；两者不得混用命名。

## 5. 运行命令

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

- `--cases <path>`：样本 JSONL，默认 `scripts/eval/cases/llm-stage-cases.jsonl`
- `--out <path>`：输出 JSONL，默认 `logs/eval/YYYY-MM-DD/<run_id>.jsonl`
- `--run-id <id>`：指定运行编号
- `--timeout-ms <ms>`：单次 LLM 请求超时

## 6. 当前限制

- token 统计优先使用 OpenAI-compatible API 返回的 usage；缺失时使用本地近似估算。
- 延迟统计优先使用 LLM diagnostics metrics；当前 Triage client 不返回 diagnostics，D1 使用 runner wall-clock 计时。
- D3 是离线估算，表示 chat 类样本不进入 Plan 时避免的固定 Plan prompt 输入 token。
- runner 不执行 sandbox 代码，只对 Plan 输出调用现有静态预检和规划门禁。
