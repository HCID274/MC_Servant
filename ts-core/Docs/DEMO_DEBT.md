# DEMO_DEBT.md — 最小闭环欠账备忘

> v0.1 | 2026-05 | 仅记录为当前闭环收缩、白名单和推迟项；不得当作永久架构结论。

---

## 0. 目的

当前目标是让 TS Core（TypeScript 单核心）先跑通"木头 → 工具链 → 石镐 → 铁矿"的 Agent（智能体）闭环。为降低范围和风险,允许短期收缩,但所有收缩必须登记在本文档,闭环完成后逐项回补或重新评估。

---

## 1. 白名单但不得硬编码事实

| 项 | 当前收缩 | 回补方向 |
|----|----------|----------|
| CraftService（合成服务） | 只允许 planks（木板）、sticks（木棍）、crafting_table（工作台）、wooden_pickaxe（木镐）、stone_pickaxe（石镐） 等目标 | 扩展为 RecipeService（配方服务）,支持更多配方 |
| recipe allowlist（配方白名单） | 只限制可合成目标,不承载材料数量或合成形状 | 所有 recipe（配方）事实继续来自 minecraft-data（Minecraft 数据库）/ Mineflayer（Minecraft 协议客户端） |
| mine（挖掘）目标 | 优先支持 stone（石头）、iron_ore（铁矿）、deepslate_iron_ore（深层铁矿） | 扩展为按资源类型、工具等级和目标物品统一采集 |
| place（放置） | 只做 crafting_table（工作台）放置/复用 | 扩展为通用 placeBlock（放置方块）能力 |

---

## 2. 明确推迟

- UI（前端界面）复杂面板。
- realtime（实时推送）增强。
- event_log（事件日志）补拉增强。
- Server Bridge（服务端桥接）观测增强。
- 通用 drop（丢弃）技能。
- 通用建筑/搭路系统。
- 全木种兼容调优。
- 大规模矿洞探索策略。
- 火把照明策略。
- 熔炼 iron（铁） 到 iron_ingot（铁锭） 的完整链路。

---

## 3. 当前验收世界假设

闭环验收可以使用可控测试世界或预设区域,确保附近存在：

- 可砍树木。
- 可挖 stone（石头）。
- 可接近 iron_ore（铁矿） 或 deepslate_iron_ore（深层铁矿）。

这不是永久限制。可控世界只服务于验证 Agent（智能体）链路能规划、执行、失败恢复和沉淀经验；后续必须回到更开放的生存环境验证。

---

## 4. 失败恢复最小集合

当前最小集合：

- 木头不足 → 继续 cutTree（砍树）。
- 没有工作台 → 由 `ensure(action, until.placed("crafting_table"))` 触发工具链恢复：先 `craft("crafting_table", 1)`,再 `place("crafting_table")`。
- 没有木镐 → 补齐材料并 craft/equip（合成/装备）。
- 圆石不足 → 使用 stair BFS mining（阶梯广度优先采矿） 挖 stone（石头）。
- 没有石镐 → 补圆石并 craft/equip（合成/装备）。
- 找不到铁矿 → 扩大矿石搜索或尝试 deepslate_iron_ore（深层铁矿）,仍失败则清晰汇报。

后续回补：

- 工具耐久预测。
- 掉落物被水/岩浆/实体干扰时的恢复。
- cave（矿洞）更复杂危险处理。
- 更丰富的 fill（填方块）策略。
- 自动回家/返回主人策略。

---

## 5. 不得成为永久债务的约束

- 不得新增 `demoMineIron()`（演示挖铁） 一键入口。
- 不得把 Minecraft（我的世界）配方、掉落、工具等级写死在业务逻辑里。
- 不得绕开 ResourceService（资源服务）/ currentWorld（当前世界） 处理 `world_key`（世界键）。
- 不得把经验 skill（经验技能）全文常驻塞进 prompt（提示词）。
- 不得用 BullMQ retry（队列重试）盲目重跑物理动作。
