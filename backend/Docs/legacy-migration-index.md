# Legacy Migration Index

> 归档说明：本文件保留在 `backend/Docs/` 作为历史副本；后续 TS Core 迁移导航以根级 `docs/legacy-*.md` 为主入口。

## 目标

- 为同级目录新建的 `ts-core` 提供旧代码迁移索引入口。
- 只整理对 TS Core 重构真正有价值的旧实现，不做全项目百科全书。
- 旧项目保留为参考库，不再作为继续演化的主代码基线。

## 标签定义

### Priority

- `P0`: Phase 1 开工前必须整理清楚。
- `P1`: 对应模块实现前应整理。
- `P2`: 可延后参考。
- `DROP`: 明确不迁，只保留反例或背景。

### Migration Fit

- `direct_port`: 思路和结构可以直接迁。
- `rewrite_with_reference`: 只能参考旧实现，需要按 TS Core 重写。
- `idea_only`: 只保留概念和经验。
- `drop`: 明确不迁。

### Reuse Type

- `algorithm`
- `flow`
- `data_structure`
- `config`
- `diagnostics`
- `idea_only`

### Phase

- `phase1`
- `phase2`
- `drop`

## 统一条目模板

```md
## <entry-title>

- legacy_path: `<old/path>`
- symbols: `<all relevant symbols>`
- migration_symbols: `<symbols actually in scope for current phase>`
- responsibility: `<一句话职责>`
- migration_fit: `direct_port | rewrite_with_reference | idea_only | drop`
- reuse_type: `algorithm | flow | data_structure | config | diagnostics | idea_only`
- ts_target: `<new ts target>`
- priority: `P0 | P1 | P2 | DROP`
- phase: `phase1 | phase2 | drop`
- depends_on: `<ts module or prerequisite>`
- do_not_copy: `<明确禁止照搬点>`
- notes: `<补充说明>`
```

## Phase 1 范围

### 必做

- 单语言 TS bot actor 内核。
- `runtime` 基础骨架：bot lifecycle、task queue、command dispatch。
- Phase 1 技能：`goTo`、`equip`、`collect`、`mine`、`cutTree`。
- 只读 `observation`：snapshot、normalize、summary input。
- `world-model` 基础层：resource profile、resource query、cluster 选择、轻量 cache。
- `diagnostics`：run event、step summary、LLM transcript 本地可读日志。
- execution critical section / observation gate 的架构边界。
- P0 迁移索引文档。

### 明确不做

- 不修旧 Python 系统。
- 不复刻 Python -> JS bridge 双核心结构。
- 不把旧系统的逐块事务化 `mine()` 搬到 TS。
- 不做 `craft`、`place`、`plugin`、`UI`、`websocket` 扩展。
- 不做旧式 detached summary 调度。
- 不做复杂 replan / recovery 总线。

### Phase 2 再考虑

- `craft`、`place`、`drop`。
- 更复杂的 inventory workflow。
- 增量 world-model 与高级失效策略。
- 完整 recovery / retry / replan。
- plugin / UI / 外围接入。

## Topic Map

- `docs/legacy-runtime-index.md` -> `src/runtime/*`
- `docs/legacy-skills-index.md` -> `src/skills/*`, `src/domain/*`
- `docs/legacy-observation-index.md` -> `src/observation/*`
- `docs/legacy-world-model-index.md` -> `src/world-model/*`
- `docs/legacy-trace-index.md` -> `src/diagnostics/*`
- `docs/legacy-bridge-pitfalls.md` -> `src/runtime/*` 设计约束与反例库
- `docs/legacy-data-index.md` -> `src/data/*`

## Do Not Copy List

- 逐块事务化的 `mine` 执行链。
- `snapshot` 内部触发 refresh / live query。
- `summary` 通过后台 detached task 干扰主执行。
- Python `run_in_executor(None, ...)` 包装状态型 bot 动作。
- sleep-based state sync 和 inventory 强刷。
- full refresh 作为资源搜索主路径。
- Python mixin 巨型 bot 外观对象。

## P0 索引队列

| Legacy Path | Migration Symbols | Doc Owner | TS Target | Priority | Phase |
|---|---|---|---|---|---|
| `backend/bot/mineflayer/action.py` | `mine`, `_equip_best_tool_for_block`, `_execute_stair_mining_collect` | `legacy-skills-index.md` | `src/skills/mine.ts`, `src/skills/equip.ts` | `P0` | `phase1` |
| `backend/bot/mineflayer/movement.py` | `navigate_relative`, `_wait_for_arrival`, `_stop_navigation` | `legacy-runtime-index.md` | `src/skills/goTo.ts` | `P0` | `phase1` |
| `backend/bot/mineflayer/environment.py` | `get_environment_snapshot`, `_query_resource_clusters_sync`, `_pick_cluster_candidate` | `legacy-observation-index.md`, `legacy-world-model-index.md` | `src/observation/*`, `src/world-model/*` | `P0` | `phase1` |
| `backend/bot/mineflayer/lifecycle.py` | `_init_bot`, `_load_plugins`, `_register_events` | `legacy-runtime-index.md` | `src/runtime/bot-actor.ts`, `src/runtime/plugin-loader.ts` | `P0` | `phase1` |
| `backend/bot/mineflayer/assets/stair_mining_helper.js` | `planStairPath`, `evaluateStandCandidate`, `sortedNeighbors` | `legacy-skills-index.md` | `src/skills/mine.ts` | `P0` | `phase1` |
| `backend/bot/mineflayer/assets/resource_cache.js` | `buildClusters`, `queryClusters`, `queryBestCluster` | `legacy-world-model-index.md` | `src/world-model/*` | `P0` | `phase1` |
| `backend/bot/mineflayer/assets/env_snapshot.js` | `getInventorySummary`, `getNearbyBlocksSummary`, `getEnvironmentSnapshot` | `legacy-observation-index.md` | `src/observation/snapshot.ts` | `P0` | `phase1` |
| `backend/bot/mineflayer/assets/minecraft_data_bridge.js` | `getMiningRule`, `resolveCanonicalTarget`, `pickMinimumHarvestTool` | `legacy-skills-index.md` | `src/domain/minecraft-data.ts` | `P0` | `phase1` |
| `backend/application/services/task_job/support.py` | `capture_env_snapshot`, `TaskJobReporter.record_event`, `StepSummaryScheduler.schedule` | `legacy-trace-index.md`, `legacy-bridge-pitfalls.md` | `src/diagnostics/*`, runtime guard 约束 | `P0` | `phase1` |
| `backend/application/services/task_job/summary_input_builder.py` | `_prune_inventory`, `_prune_nearby_blocks`, `build_step_summary_input` | `legacy-observation-index.md` | `src/observation/summary-input.ts` | `P0` | `phase1` |
| `backend/tracing/store.py` | `TraceStore`, `record_llm_call`, `record_event` | `legacy-trace-index.md` | `src/diagnostics/trace-store.ts` | `P0` | `phase1` |
| `backend/data/resource_profiles.json` | `profile schema`, `any_log`, ore profiles | `legacy-data-index.md` | `src/data/resource-profiles.json` | `P0` | `phase1` |
