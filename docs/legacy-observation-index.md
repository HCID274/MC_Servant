# Legacy Observation Index

## Scope

- 主题：只读 snapshot、snapshot normalize、summary input 压缩。
- Phase 1 只做只读观测，不做侵入式 refresh。
- summary 可以消费 observation，不得驱动重查询。

## Entry

## Observation Adapter

- legacy_path: `backend/bot/mineflayer/environment.py`
- symbols: `get_environment_snapshot`, `_collect_environment_snapshot`, `_refresh_resource_cache_sync`, `_query_resource_clusters_sync`, `_pick_cluster_candidate`, `_resource_profile_sync`
- migration_symbols: `get_environment_snapshot`, `_collect_environment_snapshot`
- responsibility: `旧系统 observation 与底层 helper 的 Python 侧适配层`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`, `src/world-model/query.ts`
- do_not_copy: `不要把 snapshot 和 refresh 混在一个入口；不要保留 Python bridge 适配层`
- notes: `Observation 维度只迁只读接口和返回 schema，不迁 refresh 策略`

### Symbol Notes

#### `get_environment_snapshot`

- role: `统一环境快照入口`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/observation/normalize.ts`
- do_not_copy: `快照内部触发 resource refresh`
- notes: `TS 版必须严格只读`

#### `_collect_environment_snapshot`

- role: `调用 helper 收集原始 snapshot`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `mineflayer bot access`
- do_not_copy: `经 Python executor 再包一层`
- notes: `关注输出形状，不关注旧调用链`

## Env Snapshot Helper

- legacy_path: `backend/bot/mineflayer/assets/env_snapshot.js`
- symbols: `getInventorySummary`, `getNearbyBlocksSummary`, `hasNearbyBlockExact`, `getEnvironmentSnapshot`
- migration_symbols: `getInventorySummary`, `getNearbyBlocksSummary`, `getEnvironmentSnapshot`
- responsibility: `底层环境快照拼装`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `snapshot 内部做 cache miss refresh 和 live exact findBlock`
- notes: `Phase 1 只保留只读部分`

### Symbol Notes

#### `getInventorySummary`

- role: `汇总背包摘要`
- migration_fit: `direct_port`
- reuse_type: `data_structure`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `inventory items read`
- do_not_copy: `无`
- notes: `可直接迁成 TS 纯 helper`

#### `getNearbyBlocksSummary`

- role: `读取附近资源摘要`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `依赖旧全局 resource cache state`
- notes: `适合改成消费 world-model query 输出`

#### `getEnvironmentSnapshot`

- role: `拼装完整环境快照`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/observation/normalize.ts`
- do_not_copy: `cache 为空时自动 refresh`
- notes: `TS Core 里必须保持只读`

## Summary Input Builder

- legacy_path: `backend/application/services/task_job/summary_input_builder.py`
- symbols: `_tokens`, `_is_relevant`, `_prune_inventory`, `_prune_nearby_blocks`, `_recent_summary_lines`, `build_step_summary_input`
- migration_symbols: `_prune_inventory`, `_prune_nearby_blocks`, `build_step_summary_input`
- responsibility: `把原始执行结果和 snapshot 压缩成适合 summary agent 的输入`
- migration_fit: `direct_port`
- reuse_type: `diagnostics`
- ts_target: `src/observation/summary-input.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/observation/normalize.ts`
- do_not_copy: `旧 job 字段命名可以重做，但裁剪逻辑值得保留`
- notes: `这份文件短小、纯函数化、直接适合迁移`

### Symbol Notes

#### `_prune_inventory`

- role: `保留和当前目标最相关的 inventory 摘要`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/observation/summary-input.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `snapshot inventory schema`
- do_not_copy: `无`
- notes: `Phase 1 直接迁`

#### `_prune_nearby_blocks`

- role: `保留与目标相关的 nearby blocks 摘要`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/observation/summary-input.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `snapshot nearby_blocks schema`
- do_not_copy: `无`
- notes: `Phase 1 直接迁`

#### `build_step_summary_input`

- role: `组装 summary agent 输入结构`
- migration_fit: `direct_port`
- reuse_type: `flow`
- ts_target: `src/observation/summary-input.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/observation/snapshot.ts`
- do_not_copy: `旧 job 字段可做更强类型化`
- notes: `diagnostics/summary 的核心输入构造器`

