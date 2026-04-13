# Legacy Bridge Pitfalls

## Purpose

- 这是反例库，不是迁移源码库。
- 只记录 Phase 1 必须规避的旧架构问题。
- 所有条目都默认 `phase: drop` 或 `migration_fit: drop | idea_only`。

## Pitfall

## Per-Block Transactional Mining

- legacy_path: `backend/bot/mineflayer/action.py`
- symbols: `mine`, `_do_collect_block`, `_force_inventory_refresh`, `_sync_world_state`
- migration_symbols: `_do_collect_block`, `_force_inventory_refresh`, `_sync_world_state`
- responsibility: `旧系统把挖矿拆成逐块事务，并在每块上叠加 refresh、postcheck、recovery`
- migration_fit: `drop`
- reuse_type: `idea_only`
- ts_target: `src/runtime/execution-guard.ts`
- priority: `P0`
- phase: `drop`
- depends_on: `execution critical section`
- do_not_copy: `每块都选目标、equip、inventory 强刷、postcheck、resource refresh`
- notes: `TS Core 的 mine/cutTree 必须是持续动作，不是单块事务循环`

## Intrusive Snapshot

- legacy_path: `backend/bot/mineflayer/environment.py`
- symbols: `get_environment_snapshot`, `_refresh_resource_cache_sync`, `_refresh_resource_cache_async`
- migration_symbols: `get_environment_snapshot`, `_refresh_resource_cache_sync`
- responsibility: `旧 snapshot 入口会顺手触发 refresh`
- migration_fit: `drop`
- reuse_type: `idea_only`
- ts_target: `src/runtime/observation-gate.ts`
- priority: `P0`
- phase: `drop`
- depends_on: `read-only snapshot contract`
- do_not_copy: `snapshot 触发 resource refresh`
- notes: `Phase 1 的 observation 必须严格只读`

## Detached Summary Interference

- legacy_path: `backend/application/services/task_job/support.py`
- symbols: `StepSummaryScheduler.schedule`, `_capture`
- migration_symbols: `StepSummaryScheduler.schedule`
- responsibility: `旧系统用 detached task 后台生成摘要`
- migration_fit: `drop`
- reuse_type: `idea_only`
- ts_target: `src/runtime/execution-guard.ts`
- priority: `P0`
- phase: `drop`
- depends_on: `summary scheduling policy`
- do_not_copy: `asyncio.create_task 脱离主执行流`
- notes: `summary 只能消费稳定 observation，不得与 skill 抢 bot`

## Spawn-Time Warmup Side Effect

- legacy_path: `backend/bot/mineflayer/lifecycle.py`
- symbols: `_register_events`
- migration_symbols: `_register_events`
- responsibility: `旧系统在 spawn 事件中直接做 resource cache warmup`
- migration_fit: `drop`
- reuse_type: `idea_only`
- ts_target: `src/runtime/bot-actor.ts`
- priority: `P0`
- phase: `drop`
- depends_on: `runtime boot policy`
- do_not_copy: `spawn -> warmup refresh`
- notes: `运行时启动与 world-model warmup 必须分开设计`

## Full Refresh World Model

- legacy_path: `backend/bot/mineflayer/assets/resource_cache.js`
- symbols: `refreshResourceCache`, `collectCandidateBlocks`
- migration_symbols: `refreshResourceCache`
- responsibility: `旧系统把 full refresh 当资源搜索主路径`
- migration_fit: `drop`
- reuse_type: `idea_only`
- ts_target: `src/world-model/resource-index.ts`
- priority: `P0`
- phase: `drop`
- depends_on: `lightweight query path`
- do_not_copy: `每次动作后或观测时都 full refresh`
- notes: `TS Core Phase 1 先做轻量 query，再考虑增量 refresh`

