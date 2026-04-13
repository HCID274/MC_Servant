# Legacy World Model Index

## Scope

- 主题：resource profile、resource query、cluster 选择、轻量 world model。
- Phase 1 只做查询与选择，不把 full refresh 作为主路径。
- query 与 refresh 必须拆开。

## Entry

## Resource Cache Core

- legacy_path: `backend/bot/mineflayer/assets/resource_cache.js`
- symbols: `collectCandidateBlocks`, `buildClusters`, `buildSummary`, `refreshResourceCache`, `queryClusters`, `queryBestCluster`, `selectBestBlock`
- migration_symbols: `buildClusters`, `queryClusters`, `queryBestCluster`, `selectBestBlock`
- responsibility: `旧系统 world model 的资源扫描、聚类、摘要和最优簇查询`
- migration_fit: `rewrite_with_reference`
- reuse_type: `algorithm`
- ts_target: `src/world-model/resource-index.ts`, `src/world-model/cluster.ts`, `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/data/resource-profiles.json`
- do_not_copy: `不要把 full refresh 当主工作流；不要保留 query/refresh 混接口`
- notes: `真正值得迁的是 cluster 和 query 逻辑，refresh 策略要重做`

### Symbol Notes

#### `buildClusters`

- role: `把候选方块按邻接关系聚成簇`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/world-model/cluster.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `resource candidate list`
- do_not_copy: `和旧全局 state 强耦合的写法`
- notes: `这是明确可迁算法`

#### `queryClusters`

- role: `返回指定 resource_key 的 cluster 列表`
- migration_fit: `direct_port`
- reuse_type: `flow`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/cluster.ts`
- do_not_copy: `隐式读取旧全局 cache state`
- notes: `TS 中应显式接收 world-model state`

#### `queryBestCluster`

- role: `选择最优资源簇`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/cluster.ts`
- do_not_copy: `隐式获取 anchor 和 state`
- notes: `可迁成纯查询函数`

#### `selectBestBlock`

- role: `从 cluster 中挑选最适合当前动作的块`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `cluster summary`
- do_not_copy: `旧 helper 的状态耦合`
- notes: `可和 runtime 层 attempt state 解耦`

## World Query Adapter Facet

- legacy_path: `backend/bot/mineflayer/environment.py`
- symbols: `_query_best_resource_cluster_sync`, `_query_resource_clusters_sync`, `_pick_cluster_candidate`, `_resource_profile_sync`
- migration_symbols: `_query_best_resource_cluster_sync`, `_query_resource_clusters_sync`, `_pick_cluster_candidate`, `_resource_profile_sync`
- responsibility: `旧系统 Python 侧的 world-model 查询适配与候选块挑选`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/world-model/query.ts`, `src/world-model/resource-profiles.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/data/resource-profiles.json`, `src/world-model/cluster.ts`
- do_not_copy: `通过 Python bridge 调 JS cache`
- notes: `这部分更像 TS world-model 的接口草图，而不是可直接迁的实现`

### Symbol Notes

#### `_query_best_resource_cluster_sync`

- role: `查询最优簇`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `同步 bridge 包装`
- notes: `保留 query contract，不保留 transport`

#### `_query_resource_clusters_sync`

- role: `查询资源簇列表`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `同步 bridge 包装`
- notes: `保留输入输出结构`

#### `_pick_cluster_candidate`

- role: `从 cluster 中选当前候选块`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/world-model/query.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `cluster query result`
- do_not_copy: `依赖旧 attempt state 组织方式`
- notes: `这是 world-model 里最值得迁的局部算法之一`

#### `_resource_profile_sync`

- role: `读取资源 profile`
- migration_fit: `direct_port`
- reuse_type: `config`
- ts_target: `src/world-model/resource-profiles.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/data/resource-profiles.json`
- do_not_copy: `Python accessor 形式`
- notes: `重点是 profile shape`

