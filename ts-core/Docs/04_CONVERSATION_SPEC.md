# CONVERSATION_SPEC.md — 对话与意图处理规格

> v0.1 | 2026.04 | 依赖 ARCHITECTURE.md v0.2, RUNTIME_SPEC.md v0.1, SANDBOX_SPEC.md v0.1

---

## 0. 本文档的职责边界

本文档定义 ConversationWorker 的完整行为规格：两阶段 LLM 调用模型、意图分类与优先级判定、上下文组装策略、代码/skill 产出格式、回复生成、Token 预算管理、记忆检索集成。

**本文档不涉及**：BotActor 状态机（见 RUNTIME_SPEC.md）、沙箱执行细节（见 SANDBOX_SPEC.md）、BrainWorker 摘要压缩算法（见 DATA_SPEC.md）、具体 skill 实现（见 SKILL_CATALOG.md）。

---

## 1. ConversationWorker 核心定位

ConversationWorker 是 Bot 的「理解与决策中枢」。它不碰 Bot，不碰 Mineflayer，不碰沙箱。它只做三件事：

1. **理解**：用户说了什么，什么意图，什么紧迫度
2. **决策**：闲聊直接回、任务生成执行计划、中断直接转发
3. **产出**：聊天回复文本 / ExecJob（skill_call 或 sandbox_code）

ConversationWorker 消费 `msg:{botId}` 队列，产出物推入 `bot:{botId}:exec` 队列或直接通过 Socket.io 广播回复。

---

## 2. 两阶段 LLM 调用模型

### 2.1 为什么分两阶段

单次调用要求 LLM 同时完成意图分类 + 回复/代码生成。问题：

- 闲聊占比约 60-70%，不需要生成代码，单次调用浪费深度推理的 token
- 意图判错时，整个深度输出全部作废
- 无法在分类后做差异化的上下文注入（闲聊不需要 Facade API 类型定义）

两阶段模型：先用轻量 prompt 做分类，再根据分类结果决定是否需要第二次深度调用。

### 2.2 调用流程

```
用户消息到达 ConversationWorker
    │
    ▼
╔════════════════════════════════════════╗
║  Stage 1: Triage（分诊）               ║
║                                        ║
║  输入：消息 + 最近 3 轮原始对话          ║
║        + Bot 状态一行摘要               ║
║  输出：ConversationCompositeTriage JSON ║
║  Token 预算：输入 ~400, 输出 ~80       ║
║  延迟预期：300-800ms                    ║
╚═══════════════════╤════════════════════╝
                    │
          ┌─────────┼────────────┐
          ▼         ▼            ▼
        chat       task        cancel
          │         │            │
          ▼         │            ▼
╔═══════════════╗   │    直接调 botActor.interrupt()
║ Stage 2-Chat  ║   │    + 生成确认回复
║               ║   │    （不需要第二次 LLM，
║ 输入：消息     ║   │     模板回复即可）
║ + 3 轮对话    ║   │
║ + 人设 prompt ║   │
║ + 记忆摘要    ║   │
║               ║   │
║ 输出：回复文本 ║   │
║ Token: ~600   ║   │
║ 延迟: 0.5-2s  ║   │
╚═══════════════╝   │
                    ▼
          ╔═══════════════════════╗
          ║ Stage 2-Plan          ║
          ║                       ║
          ║ 输入：消息 + 快照      ║
          ║ + Facade API 签名     ║
          ║ + 记忆/RAG 检索结果   ║
          ║ + 任务历史索引        ║
          ║                       ║
          ║ 输出：ExecJob JSON    ║
          ║ Token: ~2000-3000     ║
          ║ 延迟: 2-8s            ║
          ╚═══════════════════════╝
```

### 2.3 cancel 的特殊处理

Stage 1 判定 `intent: cancel` 时，不需要第二次 LLM 调用。ConversationWorker 直接：

1. 调 `botActor.interrupt({ source: { type: 'triage', intent_epoch }, reason })`
2. 广播模板回复：`"好的，已经停下来了喵~"` 或从 3-5 个预设模板中随机选一个

这比走 LLM 生成回复快一个数量级。

---

## 3. Stage 1: Triage Prompt 设计

### 3.1 System Prompt

```
你是一个消息分类器。根据用户消息和上下文，判断用户的意图类别和紧迫度。
只输出 JSON，不要输出其他内容。

输出片段规则：
- chat：可选。闲聊、问候、问问题、情感表达、与 Minecraft 游戏操作无关的对话；只输出空对象 `{}`
- action：可选。要求 Bot 执行游戏内动作（采集、移动、制造、跟随等）；`intent` 固定为 `task`
- cancel：可选。要求停止当前任务（但不是一般性的"不要"——只有明确指向当前动作的停止指令）
- 修改当前任务：不再有独立 intent，必须表达为 `cancel + action`

紧迫度规则：
- interrupt：必须立刻中止当前动作（"快跑"、"停下"、"别打了"）
- urgent：尽快执行，插队（"赶紧来"、"快点挖"）
- normal：正常排队
- background：低优先级（"有空的话"、"之后帮我"）

输出格式：
{"cancel":{"reason":"一句话原因","priority":"interrupt|queued"},"chat":{},"action":{"intent":"task","priority":"interrupt|urgent|normal|background","reason":"一句话说明判断依据"}}
```

### 3.2 User Prompt 模板

```
Bot 状态：{idle|正在执行:{当前任务简述}}
---
{最近3轮对话，格式: [主人] xxx / [Bot] xxx}
---
[主人] {当前消息}
```

### 3.3 Triage 输出类型

```typescript
interface ConversationCompositeTriage {
  cancel?: {
    reason: string
    priority: 'interrupt' | 'queued'
  }
  chat?: Record<string, never>
  action?: {
    intent: 'task'
    priority: 'interrupt' | 'urgent' | 'normal' | 'background'
    reason: string
  }
}

interface MessageTriage {
  intent: 'chat' | 'task' | 'cancel'
  priority: 'interrupt' | 'urgent' | 'normal' | 'background'
  reason: string
}
```

### 3.4 Triage 容错

LLM 输出解析失败时的诊断策略：

| 情况 | 处置 |
|------|------|
| JSON 解析失败 | 写入 LLM diagnostics JSONL 并抛出分诊错误 |
| 输出旧 `{ intent, priority, reason }` | 写入 LLM diagnostics JSONL 并抛出分诊错误 |
| `chat` 携带正文 | 写入 LLM diagnostics JSONL 并抛出分诊错误 |
| 旧 `reply` 字段 | 写入 LLM diagnostics JSONL 并抛出分诊错误 |
| `action.intent` 非 `task` | 写入 LLM diagnostics JSONL 并抛出分诊错误 |

分诊失败不再静默回退为 `{ chat: {} }`，由 diagnostics 日志保留原始 prompt 和错误摘要，避免把 schema 漂移误当成闲聊。

---

## 4. Stage 2-Chat: 闲聊回复

### 4.1 System Prompt

```
你是 {bot_name}，一个在 Minecraft 中的贴心猫娘女仆。你的主人是 {master_name}。

性格：
- 温柔、活泼、偶尔卖萌
- 忠诚但有自己的小脾气
- 对 Minecraft 世界充满好奇

绝对规则：
- 每句回复结尾必须加"喵"或"喵~"
- 回复简短自然，不超过 3 句话
- 不要输出 JSON，不要输出动作计划，只说话
```

### 4.2 User Prompt 组装

```
{记忆检索结果（如有相关，≤200字）}
---
{最近3轮对话}
---
[主人] {当前消息}
```

### 4.3 回复输出处理

LLM 的文本输出直接作为 Bot 回复，通过 Socket.io 广播到双端。

后处理检查：如果回复末尾没有"喵"，自动追加"喵~"。这是兜底，不依赖 LLM 100% 遵守。

---

## 5. Stage 2-Plan: 任务规划

### 5.1 输出格式选择：skill_call 优先

ConversationWorker 的规划输出有两种路径。**默认走 skill_call**，只有当意图复杂到无法映射为单个 skill 时才走 sandbox_code。

判定逻辑：

```
用户意图能否映射为单个 Facade API 调用？
    │
    ├─ 是："帮我砍 5 棵树" → skill_call { skill: 'cutTree', params: { count: 5 } }
    │      "过来" → skill_call { skill: 'goToOwner', params: {} }
    │      "跟着我" → skill_call { skill: 'follow', params: {} }
    │
    └─ 否："去矿洞挖 10 个钻石，挖完回来给我" → sandbox_code
           "先做一把石镐再去挖铁" → sandbox_code
           任何需要条件判断、多步编排、错误处理的意图 → sandbox_code
```

### 5.2 Plan System Prompt（sandbox_code 路径）

```
你是 {bot_name} 的任务规划引擎。根据主人的指令、当前环境快照和可用 API，生成可执行的 TypeScript 代码。

# 可用 API
{Facade API 类型定义（精简版，见 5.4 节）}

# 代码约束
- 代码是一段顶层 async 函数体，不需要 import/export/class
- 全局可用对象：api, console, sleep(ms), Math, JSON, Date
- 用 try/catch 处理预期内的失败，提供替代方案
- 每完成一个里程碑阶段，用 api.chat.say() 向主人汇报
- 所有汇报和对话必须以"喵"或"喵~"结尾
- 代码不超过 150 行

# 输出格式
只输出 JSON：
{
  "reply": "给主人的开场回复（带喵）",
  "code": "TypeScript 代码字符串"
}
不要输出任何解释文本。
```

### 5.3 Plan User Prompt 组装

```
# 环境快照
{压缩后的 EnvironmentSnapshot，见第 7 节}

# 任务历史
{压缩索引，≤300字}

# 记忆检索
{RAG 结果，≤200字}

# 主人的指令
{当前消息}
```

### 5.4 Facade API 精简版类型定义

完整的 Facade API 定义在 SANDBOX_SPEC.md 第 4 节。注入 LLM prompt 时使用精简版，省去注释和次要字段，压缩 token 用量：

```typescript
interface api {
  bot: {
    goTo(x: number, y: number, z: number): Promise<Position>
    goToOwner(distance?: number): Promise<Position>
    follow(distance?: number): Promise<void>
    mine(blockName: string, count: number): Promise<ToolchainResult<{block_name:string,completed_count:number,world_key:string|null}>>
    craft(itemName: string, count: number): Promise<ToolchainResult<{item_name:string,completed_count:number,world_key:string|null}>>
    place(blockName: 'crafting_table', near?: Position): Promise<ToolchainResult<{block_name:string,completed_count:number,world_key:string|null,position?:Position}>>
    collect(itemName: string, radius?: number): Promise<{collected: number}>
    equip(itemName: string, destination?: 'hand'): Promise<{skill:'equip',item_name:string,destination:'hand',status:'already_equipped'|'equipped',total_steps:0|1}>
    cutTree(count: number): Promise<{collected: number}>
    ensureLogs(count: number): Promise<ToolchainResult<{item_name:string,completed_count:number,target_count:number,world_key:string|null,actions:ToolchainActionSummary[]}>>
    ensureCraftingTablePlaced(): Promise<ToolchainResult<{block_name:string,completed_count:number,target_count:number,world_key:string|null,actions:ToolchainActionSummary[]}>>
    ensureWoodenPickaxeEquipped(): Promise<ToolchainResult<{item_name:string,completed_count:number,target_count:number,world_key:string|null,actions:ToolchainActionSummary[]}>>
    ensureCobblestone(count: number): Promise<ToolchainResult<{item_name:string,completed_count:number,target_count:number,world_key:string|null,actions:ToolchainActionSummary[]}>>
    ensureStonePickaxeEquipped(): Promise<ToolchainResult<{item_name:string,completed_count:number,target_count:number,world_key:string|null,actions:ToolchainActionSummary[]}>>
    attack(entityName: string): Promise<{killed: boolean}>
    getStatus(): Promise<BotStatus>
    getInventory(): Promise<InventoryItem[]>
  }
  world: {
    nearestBlocks(blockName: string, radius?: number, maxCount?: number): Promise<BlockInfo[]>
    nearestEntities(filter?: {type?: string, name?: string}, radius?: number): Promise<EntityInfo[]>
    blockAt(x: number, y: number, z: number): Promise<BlockInfo | null>
    getTime(): Promise<{timeOfDay: number, isDay: boolean}>
  }
  knowledge: {
    getRecipe(itemName: string): Promise<Recipe[]>
    getBlockInfo(blockName: string): Promise<BlockData | null>
    getItemInfo(itemName: string): Promise<ItemData | null>
  }
  memory: {
    search(query: string, limit?: number): Promise<MemoryEntry[]>
    recentTasks(limit?: number): Promise<TaskSummary[]>
  }
  chat: {
    say(message: string): Promise<void>
    report(message: string): Promise<void>
  }
  owner: {
    readonly position: Position
    readonly name: string
    readonly online: boolean
  }
  task: {
    readonly id: string
    readonly userMessage: string
  }
}
```

`ToolchainResult`（工具链结果） 固定为 `{ok:true,data}` 或 `{ok:false,error}`。`error.code`（错误码） 必须使用结构化失败码,覆盖 `missing_materials`（缺材料）、`missing_crafting_table`（无工作台）、`missing_crafting_table_item`（背包无工作台物品）、`no_placeable_position`（附近无可放位置）、`place_failed`（放置失败）、`cached_position_invalid`（缓存位置失效）、`cannot_place`（无法放置）、`missing_item`（缺目标物品）、`runtime_equip_failed`（运行时装备失败）、`not_equipped`（未装备）、`resource_not_found`（找不到资源）、`unsafe_path`（路径不安全） 等可恢复原因。Plan（规划）不得生成或引用 `demoMineIron()`（演示挖铁） 或等价一键隐藏脚本。

`place('crafting_table')`（放置工作台） 若背包没有 crafting table（工作台） 物品，执行层必须先通过 `craft('crafting_table', 1)`（合成工作台） 尝试获得物品；若 runtime（运行时） 配方校验显示缺少中间材料，可继续调用已开放的最小 `craft('planks', n)`（合成木板） 能力补齐，再重试合成工作台。放置阶段必须在当前世界附近预选最多 3 个合法候选点顺序尝试，一个被挡住或验证失败则顺延。材料不足时返回 `missing_materials`（缺材料），不得直接停在“无工作台物品”；工具链 `ok:false`（失败结果） 必须让 sandbox（沙箱） 步骤失败并保留结构化 `error.code`（错误码），供下一轮 Plan（规划）按失败原因补材料或重新选位。

所有资源、坐标和维度上下文必须通过 existing world tag（既有世界标签）、`currentWorld`（当前世界） 或 ResourceService（资源服务） 接口读取；sandbox TS（沙箱 TypeScript） 不得自行拼接 `world_key`（世界键）。

约 800 token。这是 sandbox_code 路径 prompt 的固定开销，闲聊路径完全不需要。

### 5.5 Plan 输出解析

```typescript
interface PlanOutput {
  reply: string        // 开场回复，直接广播
  code: string         // TS 代码，包装为 sandbox_code ExecJob
}
```

解析失败时（JSON 格式错误、缺少字段）：

1. 尝试从 LLM 输出中提取 code 块（```` ```typescript ... ``` ````回退匹配）
2. 如果仍然失败，emit `task.failed`，向用户广播"没听懂你的意思喵……再说一遍？喵~"

### 5.6 skill_call 路径的 Prompt

skill_call 路径不需要 LLM 生成代码。Stage 2-Plan 的 prompt 简化为：

```
根据主人的指令和当前状态，选择最合适的动作。

可用动作：
- goTo(x, y, z)：移动到坐标
- collect(itemName)：捡拾掉落物
- mine(blockName, count)：挖掘 stone / iron_ore / deepslate_iron_ore；count 是实际进入背包的掉落物数量
- cutTree(count)：砍树；count 是实际进入背包的原木数量
- equip(itemName, destination?)：把背包目标物品拿到主手；destination 当前只支持 hand

规划约束：
- 用户说"砍 12 块木头"时只输出 cutTree(count=12)
- 用户说"挖 5 个石头 / 圆石"时只输出 mine(blockName="stone", count=5)
- LLM 不输出树木簇、坐标、循环次数或挖掘目标；这些由执行层确定
- LLM 不输出矿石簇、阶梯路线或挖掘坐标；这些由执行层确定

输出 JSON：
{"reply":"开场回复（带喵）","skill":"动作名","params":{参数对象}}
```

Token 预算：输入 ~500，输出 ~100。比 sandbox_code 路径省 5-10 倍。

### 5.7 skill_call 输出解析

```typescript
interface SkillCallOutput {
  reply: string
  skill: string
  params: Record<string, unknown>
}
```

ConversationWorker 将其包装为 ExecJob：

```typescript
const execJob: ExecJob = {
  type: 'skill_call',
  skill: output.skill,
  params: output.params,
  intent_epoch: currentEpoch,
  snapshot_ts: snapshot.timestamp,
  message_id: msg.message_id,
}
```

---

## 6. 上下文预算管理

### 6.1 Token 预算总表

ConversationWorker 的每一次 LLM 调用都有严格的 token 预算。预算不是建议——是硬上限。超出预算的内容必须被裁剪。

| 调用类型 | 总输入预算 | 总输出预算 |
|---------|-----------|-----------|
| Stage 1 Triage | 500 | 100 |
| Stage 2-Chat | 800 | 200 |
| Stage 2-Plan (skill_call) | 800 | 150 |
| Stage 2-Plan (sandbox_code) | 3000 | 1500 |

### 6.2 输入 Token 分配（sandbox_code 路径，最重的场景）

```
┌───────────────────────────────────────────┐
│  总预算 3000 tokens                        │
├───────────────────────────────────────────┤
│  System Prompt（含 Facade API 签名）  ~1000 │  ← 固定开销
│  环境快照（压缩版）                  ~400  │  ← 动态
│  最近 3 轮原始对话                   ~300  │  ← 动态
│  任务历史索引                       ~300  │  ← 动态
│  记忆检索结果                       ~200  │  ← 动态
│  当前消息                           ~100  │  ← 固定
│  格式标记与分隔符                    ~100  │  ← 固定
│  余量                               ~300  │  ← 安全缓冲
└───────────────────────────────────────────┘
```

### 6.3 各槽位的裁剪策略

每个动态槽位有独立的裁剪规则，当内容超出分配预算时执行：

| 槽位 | 预算 | 裁剪策略 |
|------|------|---------|
| 环境快照 | 400 tok | 先砍 `nearby_blocks`（只保留 Top-5），再砍 `nearby_entities`（只保留敌对），最后砍 `server_extended` |
| 最近 3 轮对话 | 300 tok | 从最旧一轮开始砍，保证最新一轮完整。每轮超过 100 字时截断到 100 字 + "…" |
| 任务历史索引 | 300 tok | 保留最近 3 条摘要。如果仍超，将每条摘要压缩到一句话 |
| 记忆检索结果 | 200 tok | 只保留 Top-2 结果。每条超过 100 字时截断 |

裁剪在 ConversationWorker 内部同步完成（字符串操作），不是额外的 LLM 调用。

---

## 7. 环境快照压缩格式

observation 模块产出的 EnvironmentSnapshot 原始结构约 2000-5000 字符。注入 LLM prompt 前压缩为紧凑文本格式：

### 7.1 压缩模板

#### 7.1.1 全量模板（Plan / Modify 路径）

```
[Bot] 位置:({x},{y},{z}) 生命:{hp}/20 饥饿:{food}/20 着火:{是|否}
[世界] {world_key}（仅作为上下文信息呈现给 LLM，不参与任何分支逻辑；详见 §7.4 架构原则）
[主人] 位置:({x},{y},{z}) 距离:{N}格 在线:{是|否}
[装备] 头:{head} 身:{torso} 腿:{legs} 脚:{feet} 主手:{hand} 副手:{off_hand}
[背包] {item1}x{count}, {item2}x{count}, ...（空槽不列）
[背包变化] {item1}{+/-N}, {item2}{+/-N}, ...（详见 §7.5；首次对话或净变化为零时整行省略）
[最近上下文]
{最近 10 整轮对话与执行时间线，按 message_id 聚合，从旧到新排列；轮次为空时整段省略；详见 §7.6}
[资源簇] tree={status}, ore={status}（详见 §7.4）
[附近方块] {block1}x{count}(最近{dist}格), ...（Top-5，按距离排序）
[附近生物] {entity1}({type},{dist}格), ...（敌对优先，Top-5）
[时间] {白天|夜晚}({timeOfDay})
```

#### 7.1.2 Chat 子集模板（Chat 路径）

```
[Bot] 位置:({x},{y},{z}) 生命:{hp}/20 饥饿:{food}/20 着火:{是|否}
[世界] {world_key}
[主人] 位置:({x},{y},{z}) 距离:{N}格 在线:{是|否}
[背包] {item1}x{count}, {item2}x{count}, ...（空槽不列）
[背包变化] ...（净变化为零时整行省略）
[最近上下文]
{...对话与执行时间线；轮次为空时整段省略；详见 §7.6}
[时间] {白天|夜晚}({timeOfDay})
```

Chat 子集不含 `[装备] / [资源簇] / [附近方块] / [附近生物]`——闲聊不规划，无需局部地形或资源态势，token 预算收紧。`[最近上下文]` 与全量模板共享同一时间线数据源（§7.6），渲染规则一致。

#### 7.1.3 通用降级

主人离线时 `[主人]` 行降级为单行 `[主人] 离线`，不输出位置/距离/在线字段（全量模板与 Chat 子集一致）。

### 7.2 压缩示例

```
[Bot] 位置:(120,64,200) 生命:18/20 饥饿:16/20 着火:否
[世界] minecraft:overworld
[主人] 位置:(115,64,205) 距离:7.1格 在线:是
[装备] 主手:stone_pickaxe
[背包] oak_log x12, cobblestone x34, stick x8, crafting_table x1
[背包变化] oak_log+5, cobblestone-2
[最近上下文]
主人：去捡盾牌
Bot：我去捡盾牌。
沙盒TS：
```ts
await collect("shield")
```
执行结果：collect 成功，捡到 shield x1

主人：再去砍点橡木
Bot：去砍橡木。
执行结果：cutTree 成功，砍伐 oak_log x6
[资源簇] tree=found(最近3格,2簇), ore=found(最近12格,1簇)
[附近方块] oak_log x6(最近3格), stone x20(最近1格), coal_ore x3(最近8格), iron_ore x2(最近12格), dirt x15(最近1格)
[附近生物] zombie(敌对,22格), cow(被动,8格), sheep(被动,15格)
[时间] 白天(6000)
```

`[最近上下文]` 段不做 token 预算精算，按 §7.6.2 容量规则限制为最近 10 整轮；超长沙盒 TS 由 §7.6.4 截断兜底。

### 7.3 主人坐标行

主人坐标行让 Bot 能解析"过来"、"朝我这边"、"我在哪挖"这类带主人位置参照的指令。仅靠 Bot 自身坐标无法处理这类相对指代。

| 字段 | 来源 | 缺失处置 |
|------|------|---------|
| 位置 | observation 快照 `owner.position` | 主人离线时整行降级为 `[主人] 离线` |
| 距离 | `distance(bot.position, owner.position)`，保留一位小数 | 同上 |
| 在线 | `owner.online` | 同上 |

主人离线意味着 observation 快照中 `owner` 字段为 `null` 或 `online=false`，此时不输出位置/距离，整行简化为 `[主人] 离线`。

### 7.4 资源簇上下文与圆心刷新协议

`[资源簇]` 行来自 world-model 的 ResourceService（世界感知资源服务接口），以"按具体方块名分组 + BFS 连通聚类"模式维护跨对话缓存。它是后续 mine / cutTree 等技能启用时的资源抓手——LLM 规划时知道周边有没有树有没有矿，而不必每次都让 skill 临时全图扫描。

**架构原则（强约束，违反即视为架构冲突）**：

- 世界辨别由 ResourceService 接口内部承担。本协议描述的所有状态（P0、cache 条目、刷新触发、登录初扫、in-flight Promise、await 对齐）均**隐含按 Bot 当前所在世界路由**，消费者**不传 world_key**。
- 业务层（skill、planner、ConversationWorker、observation 派生层、未来新功能）**不得自行读取 `bot.game.dimension` 或拼接 world_key 做资源判断**。任何"按世界路由"的需求一律通过 ResourceService 公共 API 满足。
- ResourceService 内部缓存按 `(world_key, resource_key)` 二元组组织；跨世界回归时旧世界数据自然冷藏在另一桶，不需要消费者写"世界变更失效"补丁。
- §7.1 `[世界]` 行只作为上下文信息呈现给 LLM，不参与任何分支逻辑或缓存路由判断。
- §7.1 `[世界]` 行的 `world_key` 取值来源为 **transport/currentWorld 端口**（权威世界辨别），不经 ResourceService。ResourceService 只保证资源查询的世界感知路由，不充当世界信息展示源。业务层仍禁止直接读取 `bot.game.dimension`。

#### 7.4.1 协议规则

| 项 | 值 |
|----|---|
| 半径 | **恒为 16 格**（本节场景；与 `RESOURCE_REFRESH_RADIUS_STEPS` 16/32/64 阶梯刷新是不同调用路径，详见 §7.4.3） |
| 圆心 | 上次刷新时 Bot 的位置 P0 |
| 触发阈值 | `distance(bot.position_now, P0) > 8` 时触发新一轮刷新 |
| 刷新方式 | 异步：以 `bot.position_now` 为新圆心，扫半径 16，刷新成功后 P0 推进为当前位置 |
| 聚类语义 | 先按具体 `block_name` 分组，再用 26 邻域 BFS 连通聚类；不同原木 / 矿石类型默认不混簇 |
| 缓存更新 | 方块变化只更新当前 `world_key` 桶；移除变化方块，空簇删除，断裂簇重新 BFS 切分 |
| 树木分类 | `cutTree` 只消费 ResourceService 当前 `world_key` 下的 `tree` 簇；原木语义来自 runtime refresh 的 `semantic_roles` / tag 事实，不按方块名后缀猜测；不可挖 / 不可达 / 非原木 / 空簇 / 无合法目标输出 rejected 结构 |
| 可挖语义 | `is_diggable` 表示方块 / 工具 / 世界规则下可挖，不包含 Mineflayer `canDigBlock` 的当前 5.1 格手边距离限制 |
| 树木选择 | `cutTree(count)` 先找单个 `log_count >= count` 的最近足量簇；没有单簇足量时再按推荐目标距离升序累计多个小簇；每簇默认选最低合法原木作为推荐目标；缓存不足时复用 16→32→64 阶梯刷新 |
| 砍树完成标准 | 执行层只挖每个选中簇的一个推荐原木，由 plugin 连锁掉落；等待 0.5 秒后以树簇中心半径 8 强制 collect 全部掉落物，collect 失败则任务失败；随后以 dig+collect 前后的背包原木增量判断是否达到 `count`，不足则继续下一簇 |
| 挖掘资源路径 | `mine('stone', count)` 不写入 ResourceService，直接由 runtime scan 最近可挖 stone 并用 StairBFSPlanner 执行安全短段；`mine('iron_ore'/'deepslate_iron_ore', count)` 先按具体方块名刷新/读取 ResourceService 矿石簇，再由 runtime 执行 StairBFSPlanner 路线 |
| 挖掘完成标准 | runtime 根据 registry / Mineflayer 执行结果计算目标掉落物背包增量；增量不足时返回 `drop_not_obtained`，不得假设挖掉方块就等于获得物品 |
| 资源 key 集合 | Phase 1 锁定 `tree`、`ore` 两个 key，并行刷新 |
| 资源 key 解析 | `tree` 是 TS Core 公共资源键；runtime/transport 负责把它解析到 Mineflayer / minecraft-data 的原木 tag 事实，refresh 返回仍保留 `resource_keys=["tree"]` |
| 登录初扫 | Bot 登录瞬间以登录位置为初始圆心，异步触发一次半径 16 扫描；不阻塞登录流程 |
| 对话等待 | ConversationWorker 在 plan 路径读取 resource_context 时，必须 `await` 当前 in-flight 刷新 Promise（若有）再读缓存 |

#### 7.4.2 状态映射

每个 resource_key 在 prompt 中的呈现按 ResourceService 返回的 `status` 字段渲染：

- `found`：`tree=found(最近{N}格,{M}簇)`
- `cache_miss` / `stale_snapshot`：`tree=cache_miss`
- `unsupported_resource_key`：`tree=unsupported`
- `runtime_unavailable`：`tree=unavailable`

整行格式：`[资源簇] tree={...}, ore={...}`

#### 7.4.3 与 RESOURCE_REFRESH_RADIUS_STEPS 阶梯刷新的关系

`RESOURCE_REFRESH_RADIUS_STEPS`（16/32/64）阶梯刷新是**按需深度搜寻**路径——由用户明确触发 mine / cutTree 类任务时，skill 实施层逐级扩半径直到命中。

§7.4 的"圆心 + 固定半径 16"是**被动周边感知**路径——纯粹服务于 planner prompt 的资源态势注入，不参与 skill 实施。

两条路径共享同一个 ResourceService 缓存（按 `(world_key, resource_key)` 二元组组织），但触发源、半径策略、圆心语义彼此独立。同一个 `(world_key, resource_key)` 条目可能被任一路径写入，**后写覆盖前写**。

**消费者契约**：后写覆盖可能把先前的 `found` 状态降级为 `cache_miss`（例如阶梯刷新在更大半径未命中后写回空簇）。消费者必须按返回结果的 `status` 字段判断当前态势，**不得把 ResourceService 缓存当作全局资源记忆**。

### 7.5 背包跨对话 diff 缓存

让 Bot 能感知"上次对话以来背包发生了什么变化"——例如主人偷偷塞了铁锭、或者执行任务消耗了原木。仅靠当前快照，LLM 无法分辨"这是新到手的还是一直有的"。

#### 7.5.1 缓存形态

```typescript
interface InventorySnapshotCache {
  readonly bot_id: string                          // 缓存 key，Phase 1 一主一 Bot，不引入 session_id 维度
  readonly snapshot: ReadonlyMap<string, number>   // item_name → count
  readonly captured_at: number                     // 上次 plan 调用写入时间戳
}
```

#### 7.5.2 递推规则

```
新缓存 = 旧缓存 + 本次 diff ≡ 当前真实背包快照
```

即每次 ConversationWorker 进入 prompt 构建阶段时（不区分 Chat / Plan / Modify 路径）：

1. 从 observation 取当前真实 inventory
2. 与缓存中的 `snapshot` 逐 item 对比，产出 diff
3. prompt 同时注入 `[背包]`（当前快照）和 `[背包变化]`（diff）；渲染策略由路径决定（全量模板 vs Chat 子集，详见 §7.1）
4. **完成本次 prompt 渲染后立即**推进 `snapshot` 为当前真实 inventory

**时序硬约束**：baseline 推进必须发生在"diff 计算 → prompt 渲染"之后、当前路径返回之前，**不得等待 skill 执行完成后再推进**。否则本轮 skill 引发的背包变化会被吞进上一轮 baseline，下一轮 prompt 看不到。

"上次上下文" 语义统一为"上一条进入 LLM 的对话上下文"，不区分路径类型。

#### 7.5.3 diff 形态

按 `item_name` 求 delta，采用单一 delta 形式（正=新增，负=减少，0 不输出）：

```typescript
interface InventoryDiffEntry {
  readonly item_name: string
  readonly delta: number
}
```

prompt 注入文本格式：`oak_log+5, cobblestone-2, iron_ingot+1`。所有 entry 的 delta 都为 0 时，整行 `[背包变化]` 省略。

#### 7.5.4 边界与降级

| 场景 | 处置 |
|------|------|
| 首次对话（缓存为空） | 整行 `[背包变化]` 不输出。缓存初始化为当前快照，下次对话起生效 |
| 进程崩溃后重启 | 缓存为进程内内存对象，不持久化到 PG；重启等同首次对话 |
| Chat / Plan / Modify 路径 | 共用 diff 能力，均读取并推进 baseline。渲染策略差异见 §7.1：Chat 子集与全量模板均按 "净变化为零则整行省略" 规则展示 `[背包变化]` |
| Cancel 路径 / Triage 阶段 | 不读不写缓存。diff 不污染分诊与取消路径 |

#### 7.5.5 缓存边界归属

钉死为 **ConversationWorker 共享上下文构建能力**：diff 服务于 Chat / Plan / Modify 三路 prompt 渲染，放在 conversation/ 域内紧贴消费链。

不放观测端的理由：observation 是"当前真值物化视图"，写入触发器是 Mineflayer 物理事件；diff 缓存的写入触发器是对话事件（任一路径进入 prompt 构建）。两个时钟轴混在一起会迫使观测端开放写 API 给对话侧，破坏其只读边界。

**缓存单写入口**：写入只发生在 ConversationWorker 路由分发后、prompt 渲染时；读和写在同一路径里同步完成，由路径出口统一推进 baseline。Cancel / Triage 路径不进入这一写入入口。这是 inventory diff 缓存自身的写入约束，**与架构层面 BotActor 的"单写者"角色不同名同义**——本节用"缓存单写入口"以避免混淆。

---

### 7.6 [最近上下文] 对话与执行时间线

让 LLM 在 Chat / Plan / Modify 路径接续对话时，能看到「最近几轮主人说了什么 / Bot 回了什么 / 沙盒怎么写的 / 实际执行结果如何」——不依赖 LLM 总结，不依赖 §8 异步压缩通路，不依赖数据库，由 ConversationWorker 与 BotActor 在现有事件链路上确定性合并产出。

#### 7.6.1 双 owner 与合并

底层数据由两个 owner 各自记录，prompt 构建期由 ConversationWorker 合并渲染：

| owner | 记录内容 | 触发时机 |
|-------|---------|---------|
| ConversationWorker | 主人原文 / Bot reply 原文 / 沙盒 TS 代码原文 / 沙盒报错（`error.message`） | 路由分发 / 回复广播 / 沙盒 finalize |
| BotActor | `recent_events`：skill / sandbox 执行结果一行（确定性 formatter） | skill / sandbox 执行完成（成功 / 失败 / 中断 / 取消） |

合并方式：

- 聚合键 = 主人 `message_id`。同一 `message_id` 触发的所有事件（主人输入 / Bot reply / 沙盒 TS / 沙盒报错 / 执行结果）归为一轮。
- 没有 `message_id` 的事件（reflex 反射、system 自发动作）单独成一轮，以 reflex / system 标识为聚合键，容量上同样算 1 整轮。
- 同轮内按真实事件 timestamp 排序；不强制四要素齐全（chat-only 轮可能只有「主人 / Bot」，plan 轮可能有「主人 / Bot / 沙盒TS / 执行结果」）。
- 跨轮按时间从旧到新排列。

BotActor 通过 `BotActorStateProjection.recent_events: ReadonlyArray<{ message_id: string | null; line: string; timestamp: number }>` 投影只读暴露执行结果一侧。BotActor 仍是 `recent_events` 的 single writer；ConversationWorker 是对话轮一侧（主人 / Bot / 沙盒 TS / 沙盒报错）的 single writer。**两侧不得交叉写**（BotActor 不写对话轮，ConversationWorker 不写 `recent_events`）。

#### 7.6.2 容量规则

| 项 | 值 |
|----|---|
| 容量 | 最近 **10 整轮**，LRU 淘汰 |
| 淘汰粒度 | **整轮淘汰**——主人输入 / Bot reply / 沙盒 TS / 沙盒报错 / 执行结果作为原子单位一并丢弃，不允许只剩半轮 |
| 持久化 | 无，进程内，重启清空 |
| 排序 | 渲染时按从旧到新排列 |

不做 token 预算精算；10 整轮 + 单条沙盒 TS 超阈值截断（§7.6.4）即可。

#### 7.6.3 渲染规则

- prompt 段名：`[最近上下文]`，位于 `[背包变化]` 之后、`[资源簇]` 之前（全量模板）；Chat 子集位置见 §7.1.2。
- 渲染范围：**只渲染当前 prompt 之前已经完成的轮次**。当前 user message 由正常 user message 槽位提供，**不得**同时进入 `[最近上下文]`，否则与 user message 重复。
- 缺失元素跳过对应行；不输出占位符。
- 沙盒 TS 用 ` ```ts ... ``` ` 围栏多行包裹，其余各项单行渲染。
- 字面格式（按真实 timestamp 排序，本示例展示典型顺序）：

```
主人：<原文>
Bot：<reply 原文>
沙盒TS：
```ts
<TS 原文>
```
报错：<error.message，单行>
执行结果：<recent_events 单行>
```

- 报错行只贴 `error.message`，不贴 stack trace；skill 失败同样单行化（由 formatter 产出，例：`mine 失败：工具等级不足`）。
- 整段无任何轮次时，`[最近上下文]` 段省略。
- 轮与轮之间用一个空行分隔，便于 LLM 阅读。

#### 7.6.4 沙盒 TS 代码超长截断

默认完整注入沙盒 TS 代码原文，**不做语义摘要、不调用 LLM 总结、不写规则猜代码含义**。仅以下安全阈值触发截断：

- 单段 TS 代码 > 200 行 **或** > 8000 字符。
- 触发后渲染：

```
沙盒TS：[代码 N 行/M 字超阈值，已截断，code_ref=<message_id>]
```ts
<截断后片段（保留前若干行）>
```
```

- `code_ref` 取该轮主人 `message_id`（链路自带，不新增存储标识）；reflex / system 轮使用其聚合键。
- 截断仅作用于 TS 代码块；同轮内的执行结果、报错行不允许被截断省略——用户原话「不能删执行结果」。

#### 7.6.5 与 §7.5 / §8 的边界

| 维度 | A 层最近上下文 (§7.6) | inventory diff (§7.5) | A.5 滚动摘要 (§8.2) | B 层任务卡 (§8.3) | C 层资产 (§8.4) |
|------|----------------------|------------------------|---------------------|-------------------|------------------|
| 时效 | 实时，合并即写 | 同步，prompt 渲染时算 | 异步，BrainWorker 追加 + 触发重压 | 异步，BrainWorker 写入 | 异步，BrainWorker 自动提拔 |
| 内容 | 对话 + 沙盒 + 执行结果时间线 | 背包净变化 | 近期事件的有损流水摘要 | 任务卡全档 + embedding | 主人偏好 / 世界事实 / 复用 SOP |
| 存储 | ConversationWorker 进程内 + BotActor 进程内 `recent_events` | ConversationWorker 进程内缓存 | PG `bot_rolling_summary` | PG `task_events` | PG `bot_memory` |
| 注入 prompt | 永远（最近 5 轮） | 永远 | 永远（≤1000 字） | 仅 `search()` 工具召回时 | 永远 |
| 重启 | 清空（恢复后从 PG 拉对话） | 等同首次对话 | 保留 | 保留 | 保留 |
| 用途 | 刚才对话和执行链路发生了什么 | 背包多了啥少了啥 | 今天/这周大概记得什么 | 上次 / 上周做过的具体细节 | 长期一直该知道的事实 |

五者互不替代,各自职责清晰：A 层是"刚才说了什么",inventory diff 是"刚才动了什么",A.5 是"近期大概记得什么"（有损但常驻）,B 层是"按需翻档案",C 层是"长期不变的事实清单"。详细分工见 §8。

#### 7.6.6 不变量

- skill 模块新增时，**必须**同处实现 `formatRecentEventLine`。缺失 formatter 应在测试或 review 阶段失败；运行时不得调用 LLM 兜底，也不得静默丢弃事件。
- 沙盒 TS 注入 **不做** 摘要、不调用 LLM 总结、不写规则猜代码含义；唯一允许的偏离是 §7.6.4 的超长截断。
- 沙盒报错只取 `error.message`，不接 stack trace，不做 LLM 改写。
- ConversationWorker 不得调用 LLM 总结 skill 结果或对话内容作为回退路径。
- BotActor 是 `recent_events` 的 single writer；ConversationWorker 是对话轮一侧的 single writer。**两侧不得交叉写**。
- 当前用户输入不重复进 `[最近上下文]`；当前 prompt 之后才完成的事件下一轮再渲染。
- `recent_events` 不直接写入 §8 长期记忆链路；任务卡是唯一进入 B 层 / A.5 / 候选层的事实源（详见 §8）。

---

## 8. 长期记忆架构

### 8.1 设计目标

每次新会话不从零开始：让 Bot 自动带上"我知道你是谁、你的项目是什么、最近做过什么、长期不变的事实有哪些"——但又**不让 prompt 无限膨胀**。

借鉴 Hermes Agent 的三层心智模型，结合本项目"skill 自带结构化轨迹（ts 源码 + 背包 diff + 坐标）"的现实：取消"每次任务由 LLM 总结一句话"的旧设计，换成下面四层错位互补的体系。

### 8.2 A.5 滚动摘要块（近期记忆,常驻）

**作用**：承担"今天 / 这周大概记得什么"的有损中期记忆。永远注入 prompt。

- 存储：PG `bot_rolling_summary`,每 bot 一行
- 写入者：BrainWorker 独家维护
- 写入触发：BotWorker 任务完成 → BrainWorker 写完 B 层任务卡 → 把任务卡的 50~100 字摘要追加到 `content`
- 字数管理：软上限 1000 字,硬上限 2000 字
  - `char_count > 2000` → 触发整块 LLM 重压回 ≤1000 字
  - 重压所用模型与 ConversationWorker 调用一致
  - 被挤掉的旧摘要直接丢弃,**不回流 B 层**（B 层已有原始任务卡）
- 注入位置：所有三个 LLM 阶段（Triage / Chat / Plan）

A.5 不分层（不拆 [FACTS] / [FLOW]）。事实类信息的长期保留靠 C 层提拔机制（§8.4）,不在 A.5 内做二次保险——若某条事实在 A.5 反复出现却没被提拔,说明 rubric 阈值或 BrainWorker 漏判,应修那里。

### 8.3 B 层任务卡（全档,按需召回）

**作用**：完整任务执行档案。不进 prompt,通过 `search()` 工具按需召回。

- 存储：PG `task_events`,结构化字段直接列入 + `owner_text` / `takeaway` 走 embedding
- 写入者：BrainWorker
- 写入时机：BotWorker 任务完成时推任务卡进 brain 队列,BrainWorker 一次写入 `task_card jsonb` + `embedding`
- LLM 调用约束（**触发式,不是逐条**）：
  - `result = failed` → 必跑根因 takeaway,update `takeaway` 字段
  - 会话收尾静默 5 分钟（**前提**：5 分钟内无活跃任务、无新主人消息）→ 跑会话级 takeaway,合并到本会话最后一条 task_events
  - 普通成功任务跳过 LLM,`takeaway = NULL`
- 召回路径：见 §9 `search()` 工具

### 8.4 C 层资产（长期事实,常驻）

**作用**：跨会话不变的长期事实清单,永远注入 prompt。三类：

| kind | 内容 | 字符上限 | 例子 |
|------|------|---------|------|
| `USER` | 主人偏好、沟通风格 | 1375 | "主人喜欢直接给坐标,不要罗嗦" |
| `MEMORY` | 世界 / 项目稳定事实 | 2200 | "主基地 x=120 y=64 z=-300","东林指 x=380 附近橡木林" |
| `SKILL` | 复用 SOP 流程模板（**非 ts skill,是流程套路**） | 视情况 | "挖钻石前置：检查铁镐 → 检查火把 → 检查背包空间" |

存储：PG `bot_memory`,主键 `(bot_id, kind)`。注入位置：USER + MEMORY 三阶段都注入,SKILL 仅 Stage 2-Plan 注入（Triage / Chat 不需要流程套路）。

**自动提拔机制（无感写入,主人不参与）**：

```
BrainWorker 处理每个任务卡时跑一次 rubric LLM 调用
    ↓
产出 0~N 条候选 { kind, content, confidence, reason }
    ↓
全部写入 memory_candidates 表
    ↓
按 confidence 阈值分流：
  ≥ 0.85 → 立刻写入 bot_memory（含必要的合并/替换）
            容量超限 → 二次 LLM 调用做"合并 / 替换 / 删除最旧"
            拒绝精确重复
            扫 prompt injection / 凭证类内容,命中则降级 pending
            同步追加 memory_audit 一行
            候选 status = applied
  0.6 ~ 0.85 → 留 pending,主人 /memory review 时才看
  < 0.6 → status = rejected
```

冲突处理：坐标 / 偏好类新值覆盖旧值,旧值进 audit log；流程类做差异 patch。Rubric prompt 详见 DATA_SPEC.md §7.3。

### 8.5 不进任何长期记忆层的内容

明确排除（学 Hermes "memory 只存稳定事实,不存这次发生了什么"）：

- 一次性任务结果、临时 TODO、completed-work logs → 已在 B 层任务卡里,不再进 A.5 / C 层
- 沙盒 TS 源码、背包 diff 数值、具体时间戳 → 留在 A 层 `recent_events` + B 层 `task_card`,不提拔
- 当前会话的进度、未完成的步骤 → A 层窗口承担

### 8.6 Curator 后台维护（防资产层腐烂）

周期 cron 任务（每天一次）：

- 扫 `bot_memory` 中长期未被引用的条目 → 标 stale 状态（Phase 1 仅打标,不归档）
- 扫 `memory_candidates` 中 pending 超 30 天的 → 自动 rejected
- 扫 `memory_audit` 超 180 天的 → 归档清理
- Phase 2 可加：辅助模型审查、合并近义条目（受 Hermes Curator 启发,但需限制只能用 memory + skills 工具,不能乱用 shell / web）

---

## 9. B 层召回：并发廉价检索 + search() 工具

### 9.1 设计原则

为避免把每轮链路扩成 `Triage LLM → ContextGate LLM → Chat/Plan LLM`,系统不新增默认 ContextGate LLM（上下文门控大语言模型）。检索策略分两段：

- 消息进入后,除 control fast-path（控制快路径）外,ConversationWorker 可与 Triage LLM（分诊大语言模型）并发启动 cheap speculative retrieval（廉价投机检索）。该检索只返回候选,不直接注入 prompt。
- Triage（分诊）返回后,由 deterministic merge gate（确定性合并闸门）决定是否采用候选：简单 skill_call（技能调用）丢弃,记忆型 chat（闲聊）采用 memory（记忆）候选,复杂 sandbox plan（沙箱规划）采用 skill index（技能索引）/经验候选,上轮失败继续则强制加载失败上下文。
- Stage 2-Chat / Stage 2-Plan 仍暴露 `search()` 工具给 LLM（大语言模型）,用于候选不足时的按需深查。
- `search()` 是单次 chat / plan 请求生命周期内的多轮 tool calling（工具调用）,**不是再发起一次新任务请求**。

Stage 1-Triage **不暴露 search()**：分诊只判断路由（chat / cancel / task）,不需要历史细节,省一次 LLM 往返。

cheap speculative retrieval（廉价投机检索）允许使用本地 hot LRU（热点最近最少使用）、skill index（技能索引）、C 层 memory（记忆）关键词、最近失败任务索引、PostgreSQL FTS（全文检索）/ trigram（三元组模糊匹配）。默认不得跑 query embedding（查询向量嵌入）远程 API、LLM summarization（大语言模型摘要） 或加载大段 skill full content（技能全文）。详细闭环策略见 06_AGENTIC_MINE_IRON_SPEC.md。

### 9.2 search() 工具契约

声明给 LLM 的工具描述：

```ts
{
  name: "search",
  description: "查找长期任务历史。仅在 A.5 滚动摘要 / C 层 MEMORY 不够回答主人问题时使用",
  input_schema: {
    type: "object",
    properties: {
      query:  { type: "string", description: "自然语言查询" },
      kinds:  { type: "array",  items: { enum: ["task", "takeaway"] }, description: "默认两者都查" },
      top_k:  { type: "integer", default: 5, maximum: 10 }
    },
    required: ["query"]
  }
}
```

ConversationWorker 接收到 `tool_use(search)` 时调用 brain 层 SQL（详见 DATA_SPEC.md §3.1）：

```ts
brain.search({ bot_id, query, kinds, top_k })
  → { hits: [{ task_card_summary, score, snippet, created_at }] }
```

返回的 hits 序列化为 JSON 作为 `tool_result` 追加到当前会话历史,**不是塞进 system prompt 重发**。

### 9.3 多轮 tool calling 的硬性边界

| 限制 | 数值 | 理由 |
|------|------|------|
| 单次 chat / plan 请求内最大 `search()` 调用轮数 | **3** | 防 LLM 反复 search 不收敛 |
| 单次 `search()` 返回 hits 总字数上限 | **2000 字** | 防 prompt 爆炸 |
| 单条 hit snippet 上限 | 300 字 | 在总字数下保留多条命中 |
| 超 3 轮的处置 | **强制停止 tool calling,LLM 基于已有上下文产出回复** | 不重试不报错,降级返回 |

超字数处置：截断 + 提示 LLM "还有 N 条匹配,请细化 query 重试"——但这条提示也算入 3 轮配额。

### 9.4 时序示意

```
ConversationWorker                      LLM
    │                                     │
    │  request #1                         │
    │  ──────────────────────────────────▶│
    │  messages: [system,                 │
    │    user: A + A.5 + C + 主人消息]    │
    │  tools: [search]                    │
    │                                     │
    │            ◀────────────────────────│
    │            tool_use:                │
    │              {name:"search",        │
    │               input:{query:"东林"}} │
    │                                     │
    │  ▶ brain.search(...)                │
    │  ▶ pg_trgm + pgvector RRF 召回      │
    │  ▶ 拼 hits JSON (≤2000 字)          │
    │                                     │
    │  request #2(同一会话,轮次计数 +1) │
    │  ──────────────────────────────────▶│
    │  messages: [..., assistant tool_use,│
    │             user tool_result:hits]  │
    │                                     │
    │            ◀────────────────────────│
    │            最终 reply                │
    │            (或继续 tool_use 直到第 3 轮强制停止)│
```

### 9.5 缓存命中跳过

`search()`（检索）工具自身不需要单独实现"命中判断"逻辑：

- A.5 / C 层永远在 prompt 里
- 若内容已经包含答案,LLM 自然不会发 `search()` → 直接返回 reply
- 这是"缓存命中跳过 RAG"的天然实现,由 LLM 自主判断,无需额外 ContextGate LLM（上下文门控大语言模型）

### 9.6 Embedding 调用优化

`search()` 内部的 embedding 优化（对调用方透明,实现细节见 DATA_SPEC.md §3.2）：

- FTS 与 embedding API 并发发起
- FTS 高置信短路：返回 ≥3 条 `ts_rank > 0.3` 时跳过向量召回
- Embedding 结果不缓存（每次 query 不同,命中率极低）

---

## 10. 对话历史管理

### 10.1 原始对话窗口

ConversationWorker 维护每个 bot session 最近 N 轮原始对话，存储在 PG 中。

> **表结构完整定义见 DATA_SPEC.md 2.3 节 `chat_messages` 表。** 注意 `session_id` 可空（游戏端 `/svs` 消息无 web session）。

### 10.2 滑动窗口策略

每次 LLM 调用只带最近 **5 轮**（10 条消息：5 user + 5 bot）。理由：

- 5 轮覆盖典型多轮指令的上下文（"先做 X 再做 Y","等等改成 Z"）
- 超过 5 轮的内容由 A.5 滚动摘要承载有损形态,B 层任务卡承载完整档案,通过 `search()` 按需召回
- 5 轮 × 平均每轮 100 字 = ~500 字 ≈ ~250 token,在预算内

### 10.3 对话窗口拉取

```typescript
async function getRecentMessages(botId: string, sessionId: string, limit: number = 6): Promise<ChatMessage[]> {
  return await db.query(`
    SELECT role, content, created_at
    FROM chat_messages
    WHERE bot_id = $1 AND session_id = $2
    ORDER BY created_at DESC
    LIMIT $3
  `, [botId, sessionId, limit])
    .then(rows => rows.reverse())  // 按时间正序排列
}
```

### 10.4 对话格式化

注入 prompt 时的格式：

```
[主人] 帮我去砍 10 棵树
[小花] 好的主人，我这就去砍喵~
[主人] 等一下，先做一把斧头
[小花] 了解，我先做把斧头再去砍喵~
[主人] 对了，砍完之后把木头给我
```

不使用 JSON 或 XML 标签包裹对话——纯文本格式对 LLM 更自然，且省 token。

---

## 11. 回复广播与事件发射

### 11.1 闲聊回复

```typescript
async function broadcastChatReply(botId: string, reply: string, messageId: string): Promise<void> {
  // 1. 写入 chat_messages 表
  await db.insert('chat_messages', {
    bot_id: botId,
    role: 'bot',
    content: reply,
    source: 'system',
    message_id: `reply-${messageId}`,
  })

  // 2. Socket.io 广播
  io.to(`bot:${botId}`).emit('chat.reply', {
    content: reply,
    message_id: `reply-${messageId}`,
    timestamp: Date.now(),
  })

  // 3. 游戏内聊天（通过 Mineflayer 或 JAR Bridge）
  gameChat.send(botId, reply)

  // 4. event_log
  emitEvent({
    type: 'chat.reply',
    bot_id: botId,
    content: reply,
    in_response_to: messageId,
  })
}
```

### 11.2 任务规划回复

任务规划产出后，先广播开场回复（`PlanOutput.reply`），再推入 exec 队列：

```typescript
async function handlePlanOutput(output: PlanOutput | SkillCallOutput, msg: IncomingMessage): Promise<void> {
  // 1. 广播开场回复
  if (output.reply) {
    await broadcastChatReply(msg.botId, output.reply, msg.message_id)
  }

  // 2. 构造 ExecJob
  let execJob: ExecJob

  if ('code' in output) {
    execJob = {
      type: 'sandbox_code',
      code: output.code,
      intent_epoch: msg.epoch,
      snapshot_ts: msg.snapshot_ts,
      message_id: msg.message_id,
    }
  } else {
    execJob = {
      type: 'skill_call',
      skill: output.skill,
      params: output.params,
      intent_epoch: msg.epoch,
      snapshot_ts: msg.snapshot_ts,
      message_id: msg.message_id,
    }
  }

  // 3. 推入 exec 队列
  await execQueue.add('exec', execJob, {
    priority: priorityToNumber(msg.priority),
    jobId: msg.message_id,  // 去重
  })
}

function priorityToNumber(priority: string): number {
  switch (priority) {
    case 'interrupt': return 1  // interrupt 类在 Triage 阶段已处理，此处作为安全兜底
    case 'urgent': return 1
    case 'normal': return 5
    case 'background': return 10
    default: return 5
  }
}
```

---

## 12. ConversationWorker 完整处理流程

将前面所有环节串联：

```
msg:{botId} 队列取出 job（用户消息）
    │
    ▼
1. 拉取最近 5 轮对话（A 层）+ inventory diff
    │
2. 拉取 A.5 滚动摘要（PG bot_rolling_summary）
    │
3. 拉取 C 层资产（PG bot_memory: USER + MEMORY,Plan 阶段额外拉 SKILL）
    │
4. 获取 Bot 当前状态一行摘要
    │
5. ══ Stage 1: Triage LLM 调用 ══（不暴露 search()）
    │  输入：状态摘要 + A 层 + A.5 + C(USER+MEMORY) + 当前消息
    │  输出：ConversationCompositeTriage { cancel?, chat?, action? }
    │
6. 复合片段派发：
    │
    ├─ cancel 存在
    │   → botActor.interrupt(...)
    │   → 广播模板回复
    │
    ├─ chat 存在
    │   → ══ Stage 2-Chat LLM 调用（暴露 search()） ══
    │     - 输入：A + A.5 + C(USER+MEMORY) + 当前消息
    │     - LLM 自主决定是否发 search() 工具调用（≤3 轮,详见 §9）
    │     - 命中 search 时:ConversationWorker 调 brain.search(),
    │       将 hits JSON 作为 tool_result 追加到同一会话再次 invoke LLM
    │   → 广播回复
    │
    └─ action 存在
    │   → 并发：拉取环境快照 + C 层 SKILL
    │   → 判断：单 skill 可映射？
    │       ├─ 是 → ══ Stage 2-Plan (skill_call) LLM 调用（暴露 search()） ══
    │       └─ 否 → ══ Stage 2-Plan (sandbox_code) LLM 调用（暴露 search()） ══
    │     - 输入：A + A.5 + C(USER+MEMORY+SKILL) + 环境快照 + 当前消息
    │     - 多轮 tool calling 规则同 Stage 2-Chat
    │   → 解析输出
    │   → 若前面已广播 reply/cancel 模板,则不重复广播开场回复
    │   → 推入 exec 队列
    │   → done（任务完成后 BotWorker 推任务卡进 brain 队列,详见 §8）
```

---

## 13. 修改语义：cancel + task

修改诉求不再有独立 intent。分诊层只表达两个片段：`cancel` 负责中断当前任务，`action.intent='task'` 负责进入新规划。与 ARCHITECTURE.md 第 11.4 节一致：不做旧计划与新计划的 diff。

处理流程：

1. Stage 1-Triage 输出 `{"cancel":{...},"action":{"intent":"task",...}}`
2. ConversationWorker 先调用 `botActor.interrupt({ source: { type: 'triage', intent_epoch }, reason: cancel.reason })`
3. ConversationWorker 再按普通 `task` 片段构建 Stage 2-Plan prompt
4. LLM 基于当前环境快照生成全新计划，不注入旧任务 diff 或被中断任务摘要

---

## 14. 人设一致性保障

### 14.1 人设注入点

| 调用类型 | 人设注入方式 |
|---------|------------|
| Triage | 不注入人设（纯分类器，不需要角色扮演） |
| Chat | 完整人设 system prompt |
| Plan (skill_call) | 只注入"回复带喵"约束 |
| Plan (sandbox_code) | 只注入"api.chat.say 内容带喵"约束 |

Triage 阶段刻意不注入人设。分类器越干净越好，角色扮演会污染分类判断。

### 14.2 "喵"尾缀兜底

所有 Bot 发出的文本（聊天回复、api.chat.say/report 调用）在最终广播前，经过一次后处理：

```typescript
function ensureMeow(text: string): string {
  const trimmed = text.trimEnd()
  if (trimmed.endsWith('喵') || trimmed.endsWith('喵~') || trimmed.endsWith('喵！')) {
    return trimmed
  }
  return trimmed + '喵~'
}
```

这是兜底机制。LLM 大概率会遵守 prompt 中的规则，但不能 100% 保证。

---

## 15. 错误处理与降级

### 15.1 LLM 调用失败

| 失败类型 | 处置 |
|---------|------|
| 网络超时（>10s） | 重试 1 次。仍失败则广播"主人，我脑子有点卡喵……稍等一下喵~"，job 标记 failed |
| API 返回错误（5xx） | 同上 |
| API 返回错误（4xx） | 不重试，记录错误，广播"出了点问题喵……"，job 标记 failed |
| 响应解析失败 | 走兜底策略（见 3.4 节和 5.5 节） |

### 15.2 重试策略

最多重试 1 次，间隔 1 秒。不做指数退避——用户在等，延迟敏感。Phase 1 简单粗暴：成功就走，失败就报错。

### 15.3 ConversationWorker 自身崩溃

ConversationWorker 是 BullMQ Worker，崩溃后 BullMQ 自动将 job 标记为 failed。Docker 重启容器后，Worker 重新开始消费队列。未处理的消息留在队列里，不会丢失。

---

## 16. LLM 客户端抽象

### 16.1 接口定义

```typescript
interface LLMClient {
  chat(params: {
    system: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    temperature?: number
    max_tokens?: number
    response_format?: 'text' | 'json'
  }): Promise<string>
}
```

ConversationWorker 只依赖此接口，不依赖具体 SDK。Phase 1 实现 MiniMax 适配器，未来切换模型只需新增适配器。

### 16.2 温度参数

| 调用类型 | temperature | 理由 |
|---------|-------------|------|
| Triage | 0.1 | 分类要稳定，不需要创意 |
| Chat | 0.7 | 闲聊要自然，需要变化 |
| Plan (skill_call) | 0.2 | 结构化输出要稳定 |
| Plan (sandbox_code) | 0.3 | 代码要正确，但允许一定灵活性 |

---

## 17. 配置参数速查

| 参数 | 默认值 | 环境变量 | 说明 |
|------|--------|---------|------|
| `TRIAGE_TIMEOUT_MS` | 5000 | `TRIAGE_TIMEOUT` | Stage 1 LLM 超时 |
| `CHAT_TIMEOUT_MS` | 8000 | `CHAT_TIMEOUT` | Stage 2-Chat LLM 超时 |
| `PLAN_TIMEOUT_MS` | 15000 | `PLAN_TIMEOUT` | Stage 2-Plan LLM 超时 |
| `LLM_RETRY_COUNT` | 1 | `LLM_RETRY` | LLM 调用最大重试次数 |
| `LLM_RETRY_DELAY_MS` | 1000 | `LLM_RETRY_DELAY` | 重试间隔 |
| `RECENT_MESSAGES_COUNT` | 6 | `RECENT_MSG_COUNT` | 对话窗口大小（条数，3 轮 = 6 条） |
| `TASK_HISTORY_COUNT` | 5 | `TASK_HIST_COUNT` | 拉取的 Level 1 摘要条数 |
| `MEMORY_SEARCH_TOP_N` | 3 | `MEM_TOP_N` | 记忆检索返回条数 |
| `FTS_WEIGHT` | 0.6 | `FTS_WEIGHT` | 全文检索权重 |
| `VECTOR_WEIGHT` | 0.4 | `VEC_WEIGHT` | 向量检索权重 |

---

## 18. 后续文档依赖

本文档定义了 ConversationWorker 的完整行为。以下文档依赖本文档：

- **DATA_SPEC.md**：依赖第 8 节任务索引层级定义、第 10 节 chat_messages 表结构
- **SKILL_CATALOG.md**：依赖第 5.6 节 skill_call 路径的映射关系

本文档依赖的上游文档：

- **SANDBOX_SPEC.md 第 4 节**：Facade API 完整类型定义（精简版基于此裁剪）
- **SANDBOX_SPEC.md 第 8 节**：LLM 代码生成约束
- **RUNTIME_SPEC.md 第 5.3 节**：ExecJob 类型定义
- **RUNTIME_SPEC.md 第 7 节**：intent_epoch 行为

---

v0.1 完毕。你审一遍，没问题就继续下一个文档。
