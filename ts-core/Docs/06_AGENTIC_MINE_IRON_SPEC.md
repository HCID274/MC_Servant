# AGENTIC_MINE_IRON_SPEC.md — 挖铁闭环与经验学习规格

> v0.1 | 2026-05 | 依赖 ARCHITECTURE / RUNTIME / SANDBOX / CONVERSATION / DATA

---

## 0. 职责边界

本文档定义"木头 → 工具链 → 石镐 → 铁矿"闭环的系统策略。它不是一次性 demo（演示）脚本,而是 TS Core（TypeScript 单核心）证明 Minecraft Agent（我的世界智能体）具备以下能力的最小闭环：

- LLM（大语言模型）理解自然语言目标并组合 TS（TypeScript）计划。
- TS（TypeScript） skill/API（技能/接口）提供可靠动作、状态判断和 ensure（确保）函数。
- runtime（运行时）返回结构化成功/失败原因。
- BrainWorker（大脑工作线程）把失败后成功脱困的路径沉淀为经验 skill（经验技能）。
- 检索系统在后续任务中以低延迟、低 token（词元）成本召回经验。

本文档不定义 UI（前端界面）、realtime（实时推送增强）、event_log（事件日志补强）或通用 Minecraft（我的世界）百科系统。相关推迟项登记在 DEMO_DEBT（演示欠账）文档。

---

## 1. 第一性原理分工

系统最稀缺的是延迟、token（词元）和可靠性：

| 能力 | 擅长 | 禁止承担 |
|------|------|----------|
| LLM（大语言模型） | 目标理解、策略组合、失败后换方案 | 直接执行世界动作、猜 Minecraft（我的世界）事实、硬选世界/坐标资源 |
| TS（TypeScript） | 状态判断、循环、分支、可测试执行、结构化失败 | 幻觉式推理、把 MC（我的世界）事实写死进业务逻辑 |
| minecraft-data（Minecraft 数据库）/ Mineflayer（Minecraft 协议客户端）/ runtime（运行时） | 配方、掉落、工具等级、方块状态、能否执行 | 替代任务规划 |
| BrainWorker（大脑工作线程） | 异步沉淀经验、提炼长期记忆、维护索引 | 阻塞当前 Bot（机器人）动作 |

**硬约束**：

- 禁止新增 `demoMineIron()`（演示挖铁） 或等价一键隐藏入口。
- 用户说"挖铁"时,应由 Stage 2-Plan（第二阶段规划）生成可读 TS（TypeScript）计划。
- 只向 LLM（大语言模型） 暴露通用 `ensure(action, condition)`（确保语义）,不暴露具体 ensure（确保）函数。
- `mine`（挖掘） 与 `cutTree`（砍树） 自带掉落物 `collect`（捡拾） 和背包增量验收；`craft`（合成）、`place`（放置）、`equip`（装备） 只返回结构化失败,由 `ensure`（确保语义） 补局部前置。
- Minecraft（我的世界）事实只能来自 minecraft-data（Minecraft 数据库）、Mineflayer（Minecraft 协议客户端）或实时 runtime（运行时）校验。

---

## 2. 输入路由与检索策略

### 2.1 并发路径

普通消息进入后,除 control fast-path（控制快路径）外,同时启动：

```
消息进入
  ├─ Triage LLM（分诊大语言模型）
  └─ cheap speculative retrieval（廉价投机检索）
        ↓
deterministic merge gate（确定性合并闸门）
        ↓
Chat（闲聊） / TS code plan（TypeScript 代码规划）
```

control fast-path（控制快路径） 命中"停下 / 取消"等精确控制词时,不启动检索,直接中断。

### 2.2 cheap speculative retrieval（廉价投机检索）

廉价投机检索必须是本地、低延迟、可丢弃的候选准备,不得阻塞简单任务：

- hot LRU（热点最近最少使用）短索引匹配。
- skill index（技能索引）关键词匹配。
- C layer memory（长期资产）关键词匹配。
- 最近失败任务索引匹配。
- PostgreSQL FTS（全文检索）/ trigram（三元组模糊匹配）。

默认不跑以下昂贵路径：

- query embedding（查询向量嵌入）远程 API（接口）。
- LLM summarization（大语言模型摘要）。
- skill full content（技能全文）大段注入。
- 多轮 tool calling（工具调用）。

### 2.3 deterministic merge gate（确定性合并闸门）

Triage（分诊）返回后,由确定性规则决定是否采用投机候选：

| Triage（分诊）结果 | 候选使用策略 |
|-------------------|--------------|
| 普通 chat（闲聊） 且无记忆指代 | 丢弃检索候选 |
| 记忆型 chat（闲聊）,如"上次 / 之前 / 还记得 / 基地在哪" | 使用 memory（记忆）候选 |
| 明确简单 action（动作）,如 goTo（移动）/ collect（捡拾）/ cutTree（砍树） | 可丢弃检索候选,但仍输出 TS（TypeScript）代码 |
| 多步 action（动作）或含不熟悉名词 | 使用 skill index（技能索引）与相关经验候选；不熟悉名词必须 search（检索） |
| 上轮失败后的 continuation（继续任务） | 只强制加载短 Failure Capsule（失败胶囊）与必要经验候选 |

本地检索若超过小超时（建议 80ms）,merge gate（合并闸门）不得等待；Plan（规划）确实需要时再通过 `search()`（检索）工具补查。

---

## 3. 上下文装载层级

### 3.1 常驻短上下文

以下内容可以常驻,但必须短：

- A.5 rolling summary（近期滚动摘要）。
- C layer memory（长期资产）短条。
- recent context（最近上下文）。
- inventory/equipment summary（背包/装备摘要）。
- resource summary（资源摘要）。
- Failure Capsule（失败胶囊）短摘要,仅在最近一轮失败且当前消息是 continuation（继续任务） 时注入。
- hot LRU（热点最近最少使用）短索引。

### 3.2 渐进披露

经验 skill（经验技能）不全文常驻。上下文采用 Hermes-style progressive disclosure（赫尔墨斯式渐进披露）：

| 层级 | 内容 | 触发 |
|------|------|------|
| Level 0（第零层） | skill index（技能索引）：关键词、触发条件、一句话概述 | 常驻短索引 / 廉价检索 |
| Level 1（第一层） | skill body（技能正文）：步骤、坑点、验证方式 | merge gate（合并闸门）命中或 Plan（规划）调用 search（检索） |
| Level 2（第二层） | reference（引用材料）/ raw task（原始任务）片段 | Level 1（第一层）仍不足时按需查 |

Plan/Chat（规划/闲聊）最终拿到的是被选中的内容,不是全库内容。

---

## 4. 规划与执行闭环

### 4.1 "挖铁"必须走可编程 TS（TypeScript）

"挖铁"属于多步目标,不得映射为单个 `demoMineIron()`（演示挖铁） 或具体 ensure（确保）函数。Plan（规划）应生成类似结构。示例只表达目标、动作和完成条件,不代表一键隐藏入口：

```ts
await reply("好的，我去挖铁矿喵")

const task = await runGoal("挖铁矿", async () => {
  try {
    await ensure(
      async () => {
        await mine("iron_ore", 1)
      },
      until.gained("raw_iron", 1),
    )
  } catch (error) {
    if (error.code !== "resource_not_found") {
      throw error
    }

    await ensure(
      async () => {
        await mine("deepslate_iron_ore", 1)
      },
      until.gained("raw_iron", 1),
    )
  }
})

await report(task)
```

如果附近没有 `iron_ore`（铁矿）,Plan（规划）应能在 Failure Capsule（失败胶囊） 的提示下改试 `deepslate_iron_ore`（深层铁矿）或清晰汇报附近无矿；不得依赖完整坐标列表或完整资源搜索结果进入 prompt（提示词）。

### 4.2 ensure（确保语义）

LLM（大语言模型） 只允许使用一个通用 ensure（确保语义）：

```ts
await ensure(
  async () => {
    await mine("stone", 5)
  },
  until.gained("cobblestone", 5),
)
```

ensure（确保语义）内部允许 if/else（条件分支）、循环、补采、位置搜索和最小恢复,但必须调用底层通用原语：

- `cutTree()`（砍树）。
- `collect()`（捡拾）。
- `craft()`（合成）。
- `place()`（放置）。
- `equip()`（装备）。
- `mine()`（挖掘）。

底层动作必须在失败时抛出统一结构化错误,供 ensure（确保语义） 解析：

```ts
type ActionError = {
  code:
    | "missing_materials"
    | "missing_crafting_table"
    | "crafting_table_unavailable"
    | "cannot_place"
    | "not_equipped"
    | "resource_not_found"
    | "unsafe_path"
    | "unreachable_target"
    | "inventory_full"
    | "world_mismatch"
    | "unsupported_capability"
  message: string
  world_key: string | null
  action: string
  target?: string
  missing?: Array<{ item_name: string; count: number }>
  details?: Record<string, unknown>
}
```

失败码语义：

| code（失败码） | 含义 |
|----------------|------|
| `missing_materials`（缺材料） | 背包和可采集资源都不足以完成合成或确保目标 |
| `missing_crafting_table`（无工作台） | 目标配方需要工作台,但当前没有可用工作台 |
| `crafting_table_unavailable`（工作台不可用） | 找到工作台但不可达、被阻挡或交互失败 |
| `cannot_place`（无法放置） | 没有安全放置点、目标方块不可放置或服务端拒绝 |
| `not_equipped`（未装备） | 目标装备不存在、槽位不合法或装备动作失败 |
| `resource_not_found`（找不到资源） | 当前半径/刷新阶梯内找不到目标资源 |
| `unsafe_path`（路径不安全） | 路径或采矿动作会经过岩浆、深坑、坍塌等危险 |
| `unreachable_target`（目标不可达） | 资源存在但 runtime（运行时） 找不到可达候选点 |
| `inventory_full`（背包已满） | 没有空间接收产物或掉落物 |
| `world_mismatch`（世界不匹配） | 请求和 currentWorld（当前世界）/ResourceService（资源服务） 当前世界不一致 |
| `unsupported_capability`（能力未启用） | 契约已声明但实现尚未接入 |

### 4.3 CraftService（合成服务）边界

Phase 1（第一阶段）可以使用 recipe allowlist（配方白名单）限制可合成目标：

- planks（木板）。
- sticks（木棍）。
- crafting_table（工作台）。
- wooden_pickaxe（木镐）。
- stone_pickaxe（石镐）。

白名单只限制范围,不得承载材料事实。材料数量、是否需要 crafting table（工作台）、可用 recipe（配方）必须通过 minecraft-data（Minecraft 数据库）/ Mineflayer（Minecraft 协议客户端）查询和 runtime（运行时）校验。

---

## 5. 资源与世界模型

### 5.1 world_key（世界键）硬约束

所有资源搜索、资源簇读取、矿石查找必须复用现有 ResourceService（资源服务）/ runtime currentWorld（当前世界）接口。业务层不得自行读取 `bot.game.dimension`（机器人当前维度） 或拼接 `world_key`（世界键）。

### 5.2 树和矿石

- tree（树） 继续走 ResourceService（资源服务） BFS（广度优先搜索）资源簇与 cutTree（砍树）分类结果。
- ore（矿石） 走 ResourceService（资源服务） BFS（广度优先搜索）资源簇,按具体 blockName（方块名）分组。

### 5.3 stone（石头）例外

stone（石头） 太常见,不得进入 ResourceService（资源服务）资源簇,避免缓存被低价值高频方块污染。采集圆石时直接在 runtime（运行时） 读取附近最近可挖 `stone`（石头）/等价石头目标,成功标准看库存 `cobblestone`（圆石） 是否增加。

T-059（任务） 的最小执行链保持这条边界：stone（石头） 只走 runtime scan（运行时扫描）；iron_ore（铁矿） / deepslate_iron_ore（深层铁矿） 先走 ResourceService（资源服务） 具体方块名簇。两类目标最终都由 runtime（运行时） 用 StairBFSPlanner（阶梯广度优先规划器） 生成 8 到 16 步安全短段并按背包增量确认。

### 5.4 完成标准

- 挖 stone（石头） 阶段：以 `cobblestone`（圆石） 背包增量为准。
- 挖 iron_ore（铁矿） 阶段：以 `raw_iron`（粗铁） 背包增量为准。
- 不得假设"挖了方块名 X 就得到物品名 X"。
- 失败必须区分 `not_equipped`（未装备）、`resource_not_found`（找不到资源）、`unsafe_path`（路径危险）、`unreachable_target`（目标不可达）、`drop_not_obtained`（掉落未获得） 与 `runtime_mine_failed`（运行时挖掘失败）。

---

## 6. 阶梯 BFS（广度优先搜索）采矿算法

### 6.1 总体策略

mine（挖掘）在 stone（石头） 和 ore（矿石） 场景都必须走 stair BFS mining（阶梯广度优先采矿）策略。核心是"两阶段 BFS（广度优先搜索）"：

1. 第一阶段：只挖不填,寻找安全、连续、阶梯状路线。
2. 第二阶段：第一阶段失败后,才允许使用背包低价值方块补路。

执行不得一次性挖完整条路线。每次规划短段（建议 8 到 16 步）,执行一步或一小段后重新扫描,再继续。

### 6.2 State（状态）

BFS（广度优先搜索）的节点不是方块,而是"玩家脚下位置"：

```ts
type StairMiningState = {
  pos: BlockPos        // 玩家脚的位置
  dir: Direction       // 当前前进方向
  mode: "down" | "up"  // 下降或上升
  usedFill: number     // 已使用填充方块数量
}
```

每个节点必须满足：

- 脚下有支撑。
- 身体两格空间可站。
- 周围没有 lava（岩浆）风险。
- 不会掉进洞。
- 不破坏阶梯结构。

### 6.3 候选动作

下降时主要扩展：

```text
forward_down:
  next = 当前坐标 + 前方一格 + y - 1
```

上升时主要扩展：

```text
forward_up:
  next = 当前坐标 + 前方一格 + y + 1
```

候选动作优先级：

1. 继续向前阶梯下降/上升。
2. 左转后阶梯下降/上升。
3. 右转后阶梯下降/上升。
4. 在 cave（矿洞）里短距离平移,不挖方块。
5. 第二阶段才允许填方块通过缺口。

每次移动高度变化只能是 -1、0、+1。

### 6.4 isValidStep（有效台阶判断）

`isValidStep(current, next, allowFill)`（有效台阶判断）必须检查：

1. nextFoot（下一脚部位置） 和 nextHead（下一头部位置） 必须是 air（空气） 或可挖开。
2. nextFloor（下一地板位置） 必须是实体方块。
3. next（下一位置） 附近不能有 lava（岩浆）。
4. 高度差只能是 -1、0、+1。
5. 如果这一步需要挖 stone（石头）/ ore（矿石）,必须符合阶梯方向。
6. 如果 nextFloor（下一地板） 为空,第一阶段拒绝,第二阶段才考虑 fill（填方块）。

下降楼梯时,假设玩家脚位置为 `(x, y, z)`（坐标）,朝 `dir`（方向） 前进：

```text
nextFoot  = (x + dx, y - 1, z + dz)
nextHead  = (x + dx, y,     z + dz)
nextFloor = (x + dx, y - 2, z + dz)
```

算法可挖掉 nextFoot（下一脚部位置） 和 nextHead（下一头部位置）,但必须保留 nextFloor（下一地板） 作为支撑。

上升楼梯时：

```text
nextFoot  = (x + dx, y + 1, z + dz)
nextHead  = (x + dx, y + 2, z + dz)
nextFloor = (x + dx, y,     z + dz)
```

同样只挖 nextFoot（下一脚部位置） 和 nextHead（下一头部位置）,nextFloor（下一地板） 必须是实体方块。

### 6.5 危险检测

`isDangerous(next)`（危险判断） 至少覆盖：

- nextFoot（下一脚部位置） 或 nextHead（下一头部位置） 是 lava（岩浆）。
- nextFoot（下一脚部位置） 或 nextHead（下一头部位置） 附近 1 格有 lava（岩浆）。
- nextFloor（下一地板） 是 air（空气）、lava（岩浆） 或 water（水）。
- 要挖的方块上方有 sand（沙子）/ gravel（沙砾）。
- 挖开后会暴露 deep pit（深坑）。

lava cave（岩浆洞） 默认判危险并绕路；只有算法能确认封堵位置安全时,第二阶段才允许封边,不主动填岩浆。

### 6.6 cave（矿洞）处理

cave（矿洞）不是立即填平,而是已有空气空间：

- small cave（小矿洞）：若地面安全,可沿安全地面穿过。
- large cave（大矿洞）：贴墙走,避免中心区域。
- deep pit（深坑）：不跳、不落、优先绕。
- lava cave（岩浆洞）：判危险,优先绕。
- 无路可绕：第二阶段才尝试用低价值方块补路。

### 6.7 fill（填方块）策略

fill（填方块）只在第二阶段启用。可用填充物仅限低价值方块,例如：

- cobblestone（圆石）。
- deepslate（深板岩）。
- dirt（泥土）。
- netherrack（下界岩）。

不得使用 ore（矿石）、log（原木）、tool（工具）、food（食物）或 torch（火把） 作为填充物。

填充主要用于：

1. cave（矿洞） 地面缺一格,补成可站立地板。
2. small gap（小裂缝） 搭桥。
3. water/lava edge（水/岩浆边缘） 封边。

判断逻辑：

```text
if nextFloor is air and allowFill:
  if inventory has disposableBlock:
    addPlaceBlockAction(nextFloor)
  else:
    reject
```

### 6.8 ore（矿石）处理

遇到 ore（矿石） 分两类：

1. ore（矿石） 在阶梯路线前方：按阶梯规则继续挖。
2. ore（矿石） 在侧面、上方或下方：启动局部 BFS（广度优先搜索）,找能安全站立并挖到矿石的位置。

矿石不得破坏主规则。例如脚下有 diamond_ore（钻石矿） 时,不得直接向下挖一格跳坑,必须找下降楼梯接近。

局部矿石处理流程：

```text
if scanNearbyOre(current):
  orePath = bfsToReachableMiningPosition(current, ore)
  if orePath exists:
    execute(orePath)
    mineOreSafely()
    returnToMainPath()
```

### 6.9 模块划分

| 模块 | 职责 |
|------|------|
| WorldScanner（世界扫描器） | 读取方块、液体、矿石、洞穴 |
| SafetyChecker（安全检查器） | 判断能否站、能否挖、是否危险 |
| StairBFSPlanner（阶梯广度优先规划器） | 生成阶梯路线 |
| OreHandler（矿石处理器） | 处理路线附近矿石 |
| Executor（执行器） | 挖掘、移动、必要时放方块 |

---

## 7. 失败恢复与重新规划

物理动作不可幂等,不得用 BullMQ retry（队列重试）盲目重跑。失败恢复采用双轨：

1. prompt（提示词） 只接收短 Failure Capsule（失败胶囊）。
2. diagnostics（诊断）/ JSONL（结构化日志） 保存完整失败详情,供开发者排错。

Failure Capsule（失败胶囊）只允许包含：

- goal（目标）。
- failed_action（失败动作）。
- failure_code（失败码）。
- progress（目标进度）。
- retry_guard（重复保护）。
- hint（一个提示）。

示例：

```text
[上一轮失败]
目标：挖 iron_ore x1
失败：resource_not_found at mine
进度：raw_iron 0/1
避免重复：不要原样重复 mine("iron_ore", 1)
建议：可尝试 deepslate_iron_ore 或汇报附近无矿
```

以下内容不得默认进入下一轮 Plan（规划） prompt（提示词）：完整 bot_position（机器人坐标）、完整 inventory/equipment（背包/装备）、完整 resource_search_result（资源搜索结果）、visible_hazard（可见危险）列表、失败轮的 last_ts_code（上一段 TypeScript 代码）、stack trace（堆栈）、runtime details（运行时详情） 与完整 JSONL（结构化日志）。这些内容必须进入 diagnostics（诊断）/ JSONL（结构化日志）。普通非失败轮的 TS（TypeScript） recent context（最近上下文） 仍按 CONVERSATION_SPEC（对话规格） §7.6.4 处理；失败 continuation（继续任务） 时由 Failure Capsule（失败胶囊）替代失败轮完整代码。

事实 owner（所有者） 边界：

- BotWorker / BotActor（机器人工作线程 / 机器人执行代理） 产出执行事实。
- TaskResultSummary（任务结果摘要） 承载结构化终态。
- deterministic formatter（确定性格式化器） 从终态摘要生成 Failure Capsule（失败胶囊）。
- ConversationWorker（对话工作线程） 只把 Failure Capsule（失败胶囊） 合并渲染进 recent context（最近上下文）,不得凭空制造执行事实。
- BrainWorker（大脑工作线程） 只做异步长期档案,不参与实时 Failure Capsule（失败胶囊） 生成。

continuation（继续任务）规则：如果最近一轮存在 Failure Capsule（失败胶囊）,且用户说"继续 / 再试试 / 想办法 / 换个办法 / 你自己解决"等短句,视为继续同一目标。不得新增 ContextGate LLM（上下文门控大语言模型）。下一轮 Plan（规划）看到 Failure Capsule（失败胶囊） 后不得原样重复 retry_guard（重复保护） 中的动作。

失败分类：

| 类别 | code（失败码） 示例 | 规划要求 |
|------|---------------------|----------|
| 可恢复失败 | `missing_materials`、`not_equipped`、`resource_not_found`、`missing_crafting_table`、`crafting_table_unavailable`、`inventory_full`、`unsafe_path`、`unreachable_target`、`drop_not_obtained` | 换策略,如补材料、装备工具、换目标、换路径或汇报附近不足 |
| 实现阻塞失败 | `unsupported_capability`、`runtime_adapter_error`、`world_mismatch`、`invalid_runtime_object`、`protocol_error`、`plugin_unavailable` | 不得乱试,直接汇报阻塞原因 |

建议单个用户目标最多自动 replan（重新规划） 3 次；超过后清晰汇报阻塞原因。后续触碰 Failure Capsule（失败胶囊） 注入或 Plan prompt（规划提示词） 规则的实现任务,需实服验证真实 LLM（大语言模型）行为。

---

## 8. 经验 skill（经验技能）沉淀

BrainWorker（大脑工作线程）在以下情况下创建或更新 agent-managed skill（智能体管理技能）：

- 任务经历失败后最终成功。
- 用户纠正了做法。
- 流程超过 5 个有效动作。
- 出现可复用脱困模式。

经验 skill（经验技能）必须记录：

- trigger（触发条件）。
- prerequisites（前置检查）。
- recommended TS pattern（推荐 TypeScript 组合模式）。
- common failures（常见失败）。
- verification（验证方式）。
- forbidden actions（禁止事项）,例如不得拼接 `world_key`（世界键）。
- keywords（关键词）,例如"挖铁 / 石镐 / 工具链 / 无矿 / 未装备 / 圆石不足"。

技能库维护采用 LRU（最近最少使用）/ usage（使用次数）/ view（查看次数）/ patch（补丁次数）指标。hot LRU（热点最近最少使用）只常驻短索引,不常驻全文；低频经验从热点索引淘汰,但仍保留在持久库中,未来检索命中后可重新拉起。

---

## 9. 验收标准

最终验收不是调用一键函数,而是：

1. 用户自然语言说"挖铁"。
2. Triage（分诊）判定为复杂任务。
3. cheap speculative retrieval（廉价投机检索）并发给出候选经验。
4. Plan（规划）在真实上下文中生成可读 TS（TypeScript）组合。
5. 执行层显式使用 `ensure(action, condition)`（确保语义） 和 mine（挖掘）原语。
6. 若失败,下一轮 Plan（规划）读取短 Failure Capsule（失败胶囊） 并换策略,完整失败详情留在 diagnostics（诊断）/ JSONL（结构化日志）。
7. 成功后 BrainWorker（大脑工作线程）沉淀经验 skill（经验技能）。
8. 下一次类似任务能通过索引和检索更快加载经验。
