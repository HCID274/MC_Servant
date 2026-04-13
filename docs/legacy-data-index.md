# Legacy Data Index

## Scope

- 主题：Phase 1 真正需要迁移的配置数据。
- 当前只覆盖 `resource_profiles.json`。
- 不顺手扩展到 `target_mappings`、`runtime_rules`，这些后续再补。

## Entry

## Resource Profiles

- legacy_path: `backend/data/resource_profiles.json`
- symbols: `resource profile schema`, `any_log`, `iron_ore`, `coal_ore`, `copper_ore`, `gold_ore`
- migration_symbols: `resource profile schema`, `any_log`, `iron_ore`, `coal_ore`, `copper_ore`, `gold_ore`
- responsibility: `定义资源类型、候选方块、聚类规则、扫描半径等 world-model 配置`
- migration_fit: `direct_port`
- reuse_type: `config`
- ts_target: `src/data/resource-profiles.json`, `src/world-model/resource-profiles.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/world-model/query.ts`
- do_not_copy: `不要把 profile 当执行流程；不要让 profile 掩盖 world-model 设计问题`
- notes: `Phase 1 重点是 schema 与 ore/log profile；stone 和 sand 不在当前阶段 migration_symbols 范围内`

### Symbol Notes

#### `resource profile schema`

- role: `规定 resource profile 的字段结构`
- migration_fit: `direct_port`
- reuse_type: `config`
- ts_target: `src/world-model/resource-profiles.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/data/resource-profiles.json`
- do_not_copy: `Python accessor 形式`
- notes: `先类型化 schema，再交给 world-model 消费`

#### `any_log`

- role: `树木类泛化资源 profile`
- migration_fit: `direct_port`
- reuse_type: `config`
- ts_target: `src/data/resource-profiles.json`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/skills/cutTree.ts`
- do_not_copy: `继续把 cutTree 语义建模成 mine(any_log) 技能实现`
- notes: `配置保留，技能边界重做`

#### `ore profiles`

- role: `矿类 resource profile`
- migration_fit: `direct_port`
- reuse_type: `config`
- ts_target: `src/data/resource-profiles.json`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/skills/mine.ts`
- do_not_copy: `每个矿都走旧 full-refresh 工作流`
- notes: `可直接作为 mine skill 的输入配置`

