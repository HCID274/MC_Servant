# Legacy Skills Index

## Scope

- 主题：`mine`、`equip`、`cutTree` 所需的核心技能实现来源。
- Phase 1 严格只收敛到 `goTo`、`equip`、`collect`、`mine`、`cutTree`。
- 不顺手扩展 `craft`、`place`、`drop`。

## Entry

## Mine Skill Aggregator

- legacy_path: `backend/bot/mineflayer/action.py`
- symbols: `mine`, `_do_collect_block`, `_equip_best_tool_for_block`, `_execute_stair_mining_collect`, `_collect_block_with_progress_watchdog`, `_do_craft`, `_do_place_nearby`
- migration_symbols: `mine`, `_equip_best_tool_for_block`, `_execute_stair_mining_collect`
- responsibility: `旧系统的技能大总管，混合 mine/equip/collect/craft/place 与 postcheck/recovery`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/mine.ts`, `src/skills/equip.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`, `src/world-model/query.ts`, `src/domain/minecraft-data.ts`
- do_not_copy: `不要照搬逐块事务化 collect；不要照搬 inventory 强刷和 sleep sync`
- notes: `该文件对 TS Core 的价值在于技能边界样本和少量局部流程，不在于旧执行架构`

### Symbol Notes

#### `mine`

- role: `旧系统 mine 技能入口`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `按 count 逐块重复进入完整 collect 事务`
- notes: `保留 skill entry，不保留内部事务循环`

#### `_equip_best_tool_for_block`

- role: `为目标方块选择并装备工具`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/equip.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/domain/minecraft-data.ts`
- do_not_copy: `equip 后立即 inventory 强刷`
- notes: `保留按 block rule 选工具的意图，重写装备同步策略`

#### `_execute_stair_mining_collect`

- role: `调用楼梯挖掘 helper 执行采集`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/skills/mine.ts`, `src/world-model/query.ts`
- do_not_copy: `外层逐块事务化包装`
- notes: `真正可迁的核心在 stair helper 算法`

## Stair Mining Planner

- legacy_path: `backend/bot/mineflayer/assets/stair_mining_helper.js`
- symbols: `planStairPath`, `evaluateStandCandidate`, `sortedNeighbors`, `digIfNeeded`, `moveOneStep`, `ensureTool`
- migration_symbols: `planStairPath`, `evaluateStandCandidate`, `sortedNeighbors`
- responsibility: `为高差或地下目标生成楼梯式接近路径`
- migration_fit: `rewrite_with_reference`
- reuse_type: `algorithm`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`, `mineflayer-pathfinder`
- do_not_copy: `不要继续把它作为被旧事务链包裹的黑盒 helper`
- notes: `这是旧系统里最值得迁的纯算法来源之一`

### Symbol Notes

#### `planStairPath`

- role: `规划楼梯式路径`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `blockAt`, `path state model`
- do_not_copy: `旧 trace/debug payload 结构不必照搬`
- notes: `核心 BFS 和站位判定值得保留`

#### `evaluateStandCandidate`

- role: `评估可站立位置`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `block collision rules`
- do_not_copy: `与旧 trace counter 的耦合实现`
- notes: `适合改成纯函数`

#### `sortedNeighbors`

- role: `按接近目标和下降模式对候选邻居排序`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/skills/mine.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `path state model`
- do_not_copy: `旧 options 兼容分支`
- notes: `Phase 1 直接可用`

## Minecraft Domain Helper

- legacy_path: `backend/bot/mineflayer/assets/minecraft_data_bridge.js`
- symbols: `getMiningRule`, `normalizeRecipeOptions`, `resolveCanonicalTarget`, `preferredPlanksFromLog`, `pickMinimumHarvestTool`
- migration_symbols: `getMiningRule`, `resolveCanonicalTarget`, `pickMinimumHarvestTool`, `preferredPlanksFromLog`
- responsibility: `基于 minecraft-data 推导采掘规则、目标规范化和木材偏好`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/domain/minecraft-data.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `minecraft-data`
- do_not_copy: `bridge 的 Json string 包装形式`
- notes: `这是 Phase 1 skill/domain 层最适合直接迁的旧文件之一`

### Symbol Notes

#### `getMiningRule`

- role: `推导资源目标的采掘规则`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/domain/minecraft-data.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `minecraft-data`
- do_not_copy: `旧 bridge 导出形式`
- notes: `equip/mine 技能都依赖这个能力`

#### `resolveCanonicalTarget`

- role: `把 planner 目标解析成 canonical target`
- migration_fit: `direct_port`
- reuse_type: `flow`
- ts_target: `src/domain/minecraft-data.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `minecraft-data`
- do_not_copy: `返回 Json string`
- notes: `可作为 Phase 1 task translation 的底层工具`

#### `pickMinimumHarvestTool`

- role: `推导最小采掘工具`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/domain/minecraft-data.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `minecraft-data`
- do_not_copy: `helper 散落式组织方式`
- notes: `建议抽成独立纯函数`

