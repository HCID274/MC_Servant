# Legacy Runtime Index

## Scope

- 主题：bot actor、session lifecycle、plugin loader、基础 movement。
- Phase 1 只覆盖 TS Core 的最小运行时骨架。
- 不扩展 `craft`、`place`、`plugin UI`、外围 websocket。

## Entry

## Bot Lifecycle

- legacy_path: `backend/bot/mineflayer/lifecycle.py`
- symbols: `connect`, `_init_bot`, `_load_plugins`, `_register_events`, `disconnect`
- migration_symbols: `_init_bot`, `_load_plugins`, `_register_events`
- responsibility: `旧系统的 bot 生命周期入口、插件装载与核心事件绑定`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/runtime/bot-actor.ts`, `src/runtime/plugin-loader.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `mineflayer`, `mineflayer-pathfinder`, `mineflayer-tool`, `mineflayer-collectblock`
- do_not_copy: `不要保留 Python 外壳；不要在 spawn 事件里顺手做 resource cache refresh`
- notes: `TS Core 的 runtime 起点应直接从这里抽出 bot 初始化清单、插件清单和事件清单`

### Symbol Notes

#### `_init_bot`

- role: `创建 bot、挂载 helper、准备底层对象句柄`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/runtime/bot-actor.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/plugin-loader.ts`
- do_not_copy: `通过 Python require 间接装载 helper`
- notes: `保留初始化顺序，不保留 Python/JS 双层包装`

#### `_load_plugins`

- role: `装配 pathfinder、collectblock、tool 以及 movements 配置`
- migration_fit: `direct_port`
- reuse_type: `flow`
- ts_target: `src/runtime/plugin-loader.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `minecraft-data`, `mineflayer plugins`
- do_not_copy: `把 plugin state 直接塞进 Python 对象字段`
- notes: `这是 TS Core Phase 1 里最可直接迁的 runtime 片段之一`

#### `_register_events`

- role: `注册 login/spawn/message/error/end 事件`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/runtime/bot-actor.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`
- do_not_copy: `spawn 时立即 warmup resource cache；消息事件里扩展复杂副作用`
- notes: `保留事件集合，重写副作用边界`

## Movement Basics

- legacy_path: `backend/bot/mineflayer/movement.py`
- symbols: `navigate_relative`, `_wait_for_arrival`, `_stop_navigation`, `look_at`, `chat`
- migration_symbols: `navigate_relative`, `_wait_for_arrival`, `_stop_navigation`
- responsibility: `旧系统的基础位移动作、到达判定与导航停止逻辑`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/goTo.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`, `mineflayer-pathfinder`
- do_not_copy: `不要保留 Python executor 包装；不要把轻动作都变成阻塞线程任务`
- notes: `Phase 1 的 goTo 技能边界与到达确认策略主要参考这里`

### Symbol Notes

#### `navigate_relative`

- role: `按相对玩家的位置关系执行导航`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/skills/goTo.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/runtime/bot-actor.ts`
- do_not_copy: `旧接口里混入 Python timeout 包装和路径细节`
- notes: `保留输入模型：entity + offset_type + distance`

#### `_wait_for_arrival`

- role: `轮询确认 bot 进入目标半径`
- migration_fit: `direct_port`
- reuse_type: `algorithm`
- ts_target: `src/skills/goTo.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `bot position read`
- do_not_copy: `同步 sleep 轮询实现方式`
- notes: `判定逻辑可直接迁，调度方式改成 TS async`

#### `_stop_navigation`

- role: `在超时或取消时主动停止 pathfinder`
- migration_fit: `direct_port`
- reuse_type: `flow`
- ts_target: `src/skills/goTo.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `mineflayer-pathfinder`
- do_not_copy: `Python 侧多层 try/except 兼容写法`
- notes: `TS Core 必须保留显式 stop/cancel 语义`

