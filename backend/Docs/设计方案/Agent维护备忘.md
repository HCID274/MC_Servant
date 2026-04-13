# Agent 维护备忘

用于记录文档结构调整、关键架构改动与后续排查备注。

## 记录规则

- 只写“这次改了什么”和“以后看哪里”。
- 保持简短，不在这里写长篇设计说明。
- 主架构图保留稳定结构，本文件承接增量备注。

## 2026-03-12

- `00Python项目分层架构图.md`
  - 保留架构图与执行生命周期，移除冗长的“重构后的核心价值”和“本轮修正补充”章节。
- 新增 `02Agent状态流转图.md`
  - 单独描述 Agent 状态流、关键实现代码与重试/重规划机制。
- 后续规则
  - 以后若继续调整 Agent 内部编排、状态机、重试链路或文档结构，先更新对应主文档，再在本文件追加一条简记。

- `backend` 目录重组
  - `bot` 的 `mineflayer_*` Python 与 JS 伴生脚本收拢到 `backend/bot/mineflayer/` 子包。
  - `application/services` 的 `task_job_*` 与 `summary_input_builder.py` 收拢到 `backend/application/services/task_job/`。
  - `tracing` 的 schema / manager / repository / transcript writer 收拢到 `backend/tracing/storage/`。
  - `llm_agent` 的 `router/planner/summary` 实现收拢到 `backend/llm_agent/agents/`。

- 真实交付链补齐
  - `TaskStep` 新增可选 `count`，`task_translator.py -> task_executor.py -> mineflayer/action.py` 现在会把 `mine / craft / drop` 的数量一路透传到底层。
  - `node_task_planner_agent.md` 明确要求：涉及“给/准备/交付”时，必须在 `move_to master_front` 后使用 `drop` 做真实交付，不能再用 `speak` 假装给出物品。
  - `bot/mineflayer/action.py` 新增阻塞式 `drop()`，通过 `toss/tossStack` 丢物，并以库存真实减少作为唯一成功判据。

- 主人定位严格化
  - `player_handler.py` 与 `task_job/runner.py` 现在会把当前会话的 `player` 绑定到 Bot。
  - `mineflayer/base.py` 新增会话级 `master_name`，`movement.py` 的 `navigate_relative/look_at_eyes` 改为只认这个名字的实时实体，不再用“第一个非 bot 玩家”兜底。
  - 后续又修了一次：Mineflayer 的 `bot.players` 不是标准 Python `dict`，不能直接调 `.get()`；现在统一走兼容查找，避免 `move_to` 再报 `'NoneType' object is not callable`。

- 移动阻塞与交付朝向修正
  - `movement.py` 的 `navigate_relative` 不再 `setGoal()` 后立即返回，而是改为走 `pathfinder.goto(goal, timeout=None)` 并由 Python 外层 `asyncio.wait_for` 做 120s 业务超时。
  - `task_executor.py` 会把 `move_to` 的业务超时显式传给底层移动执行。
  - `action.py` 的 `drop` 在真实 `toss/tossStack` 前会先朝向当前绑定主人，避免站在原地朝错误方向丢物。

- Task 链说话恢复
  - `task_executor.py` 的 `speak/say` 继续只产出结构化 `spoken_text`，但 `task_job/runner.py` 现在会把普通 task 的 `speak/say` 成功结果强制转成插件 `npc_response`。
  - `TaskJobReporter.send_feedback()` 新增 `force` 开关，用于恢复 task 进度汇报发声，同时不把旧的双通道白字公屏重新带回来。

- 工作台规划职责收口
  - `domain_catalog.py` 的 `tool_context` 现在额外给 Planner 暴露工作台上下文：附近是否已有工作台、背包里已有几个工作台、目标/所需工具是否需要 3x3 合成。
  - `node_task_planner_agent.md` 新增工作台硬规则：遇到 3x3 配方时，必须优先规划 `craft/place crafting_table`，不能再直接跳到 `craft stone_pickaxe`。
  - `workflow.py` 不再额外维护工作台策略诊断；graph 层只负责把 `tool_context` 交给 Planner。
  - `bot/mineflayer/action.py` 的 `craft.workbench` 现在只负责复用附近已有工作台和显式报错，不再由执行器偷偷自动放台；缺失工作台链时，统一返回 `MissingCraftingTable` 触发重规划。

- 木板 tag 配方修正
  - `minecraft_data_bridge.js` 与 `domain_catalog.py` 现在把木板类配方材料统一归一成 `planks`，不再把 `crafting_table` 等“任意木板”配方误报成只需要 `oak_planks`。
  - `bot/mineflayer/action.py` 的 Python 侧 recipe patch 逻辑已删除；`craft` 在 `recipesFor()` 返回空时，会先做库存刷新，再调用 `bot/mineflayer/assets/craft_recipe_helper.js` 在 JS 侧直接选择并 patch Mineflayer 原生 Recipe；日志关键字仍是 `craft.precheck` 和 `craft.recipe_fallback`。
- 采集无进展超时
  - `bot/mineflayer/assets/collect_watchdog_helper.js` 新增 JS 侧采集 watchdog：只要 bot 坐标继续变化，或目标 `success_targets` 继续入包，就持续放行 collectBlock；只有“坐标长时间不动且目标物 7 秒未入包”才会主动 cancel 并抛 `MineStalledTimeout`。
  - `bot/mineflayer/action.py` 会把 watchdog 诊断信息写入 `mine` 的 postcheck / error extra，便于区分“正常长距离寻路”与“原地卡死没进展”。
  - 同时在 `inventory/entity/position` 读取上继续保留桥接熔断；一旦出现 `Timed out accessing` / `BrokenBarrierError`，后续状态读取直接降级为空，避免二次崩溃。
- `place` 在 `equip` 成功后新增短暂同步等待，并改为按多个相邻候选位轮流尝试；单个 `placeBlock` 的 `blockUpdate` 超时不再直接结束整步。
- `place` 现在还会显式过滤与 bot 当前脚下/头顶碰撞箱重叠的目标落点，避免在狭窄矿道里重复尝试把工作台塞进自己身体。
- `place` 的候选点生成器已从“平面十字四格”改成“半径 2、上下 3 层的 3D 扫描”，会同时处理斜角、阶梯和坑洞，并按距离排序后逐个尝试合法落点。
- `craft.precheck` 现在会显式记录 `selected_via`，区分直接命中配方、依赖工作台命中、fallback 命中或完全无配方；`mine.precheck` 会记录主手物品与 `canHarvest`，避免继续被“看起来像 craft 失败，实际可能是挖矿前没切到正确工具”误导。
- `env_snapshot` 现已补充精确的 `nearby_crafting_table` 布尔值，Planner 复用工作台优先看这个近距检测结果，不再只依赖 `nearby_blocks` 摘要。
- `mine` 在进入 `collectBlock` 前会先显式执行一次 `equipForBlock`，避免“石镐已经做出来，但 collectblock 开始前主手还是空的”这类黑盒状态不透明问题。
- 采矿 watchdog 又补了一次桥接与进展判定：
  - `bot/mineflayer/action.py` 调 `collectBlockWithProgressWatchdog(...)` 时显式传 `timeout=None`，避免再被 `javascript` 桥的默认 10 秒 barrier 提前打断。
  - `bot/mineflayer/assets/collect_watchdog_helper.js` 不再只盯 `success_targets` 入包；现在“背包任意物品计数变化”以及“任意方块被破坏/替换的 `blockUpdate`”都会刷新进展时间，降低矿道里先清挡路块时的误判超时。

## 2026-03-14

- 正式采矿已接入楼梯巡路
  - `bot/mineflayer/lifecycle.py` 现在会正式加载 `stair_mining_helper.js`，不再只靠独立调试脚本手动 require。
  - `bot/mineflayer/action.py` 的 `mine` 执行链新增策略分流：矿脉资源（`resource_profiles.json` 的 `profile=ore_vein`）或目标与 bot 的 Y 轴高度差绝对值大于 3 时，改走 JS 侧楼梯采矿；其它采集仍保留原来的 collect watchdog。
  - 楼梯采矿执行后仍复用原有 post_collect / 掉落补拣 / inventory refresh 闭环，所以正式链路没有再复制一套采后校验代码。
- 资源配置补齐
  - `backend/data/resource_profiles.json` 新增 `copper_ore / gold_ore / redstone_ore / lapis_ore / diamond_ore / emerald_ore`，统一纳入 `ore_vein` 资源语义，后续排查矿类目标先看这里。
- 采矿工具前置与失败分流收紧
  - `bot/mineflayer/action.py` 的采前装备不再单靠 `_held_item_can_harvest()` 放行；只要 `mineflayer-tool` 可用，就强制走 `equipForBlock(requireHarvest=true)` 做工具守门。
  - `bot/mineflayer/assets/stair_mining_helper.js` 不再吞掉 `equipForBlock` 异常，缺合格工具时会直接停止挖掘，避免木镐把铁矿挖成空气却无掉落。
  - `backend/execution/error_translator.py` 现在把 `no_required_tool` 归类为 `fatal`，让任务直接重规划补工具链，不再局部重试。
  - `BlockBrokenNoCollection` 会把当前矿点写进 failed block 集合，避免对已变空气的同一矿点重复重试。
- 采矿缓存与楼梯搜索又补了一轮
  - `bot/mineflayer/environment.py` 的 cluster 选块现在会用 live `blockAt` 二次校验缓存坐标；如果现场已变 `air` 或被替换，会立刻淘汰该矿点并尝试同 cluster 的下一个候选。
  - `bot/mineflayer/action.py` 在每轮采矿确认成功后会主动刷新一次资源缓存，再清空本轮 failed block 记忆，减少 `count>1` 时重复命中旧矿点快照。
  - `bot/mineflayer/action.py` 也上调了高垂直差楼梯采矿的 `horizontalPadding / verticalPadding / maxNodes`，让 stateful spiral BFS 不再沿用旧的体积预算。
