    # SANDBOX_SPEC.md — TS 代码沙箱执行规格

    > v0.1 | 2026.04 | 依赖 ARCHITECTURE.md v0.2, RUNTIME_SPEC.md v0.1

    ---

    ## 0. 本文档的职责边界

    本文档定义 TS 代码沙箱的完整执行规格：isolated-vm 集成方案、Facade API 类型签名与行为契约、安全边界、超时策略、代码转译流程、错误处理。

    **本文档不涉及**：BotActor 状态机（见 RUNTIME_SPEC.md）、具体 skill 的游戏逻辑实现（见 SKILL_CATALOG.md）、LLM 如何生成代码（见 CONVERSATION_SPEC.md）。

    ---

    ## 1. 沙箱的核心定位

    沙箱不是一个"代码运行器"。它是 **LLM 意志与物理世界之间的翻译膜**。

    LLM 生成的 TS 代码表达了"意图的执行计划"——先去哪、再挖什么、挖多少、遇到问题怎么处理。沙箱的职责是：让这段代码在一个受控环境里运行，每一步通过 Facade API 向 BotActor 发起请求，BotActor 审批后驱动 Mineflayer 执行。

    **沙箱内的代码看起来在直接操作 Bot，实际上它没有任何直接权力。** 每一个动作都是一次跨 isolate 的 RPC，BotActor 是唯一的批准者。

    ---

    ## 2. 技术选型：isolated-vm

    ### 2.1 选型理由

    | 方案 | 隔离级别 | 安全性 | async 支持 | 结论 |
    |------|---------|--------|-----------|------|
    | `node:vm` | 同进程共享堆 | 官方 "not for security" | 有 | 淘汰 |
    | `isolated-vm` | V8 Isolate 独立堆 | 内存/CPU 限制开箱即用 | 通过 Reference 回调 | **选用** |
    | `quickjs-emscripten` | WASM 隔离 | 真隔离 | 受限 | 性能不够 |
    | `worker_threads` | 独立线程 | 中等 | 原生 | 隔离不够彻底，共享 ArrayBuffer |

    ### 2.2 已知风险与防线

    | 风险 | 防线 |
    |------|------|
    | isolated-vm 处于 maintenance mode | 沙箱调用集中在 `sandbox/` 模块内，未来替换只改一个目录 |
    | V8 OOM 可能带崩宿主进程 | `memoryLimit: 128` MB 拦截绝大多数 OOM |
    | Node.js 大版本升级时 native addon 编译问题 | pnpm lockfile 锁定版本，升级前在 CI 验证 |
    | 宿主进程崩溃 | Docker restart policy 自动重启容器 |

    ### 2.3 Isolate 池管理

    Phase 1 不做 Isolate 池——每次任务创建一个 Isolate，执行完毕后 dispose。理由：

    - Phase 1 一主一 Bot，同一时间只有一个沙箱任务在执行
    - Isolate 创建开销约 5-10ms，相比 LLM 响应的 3-10 秒可忽略
    - 每次新建确保零状态残留，避免前一个任务的变量污染下一个任务

    未来如果创建开销成为瓶颈，可改为"创建一个长生命周期 Isolate + 每次任务新建 Context"的模型。但 Phase 1 不做。

    ---

    ## 3. 代码转译流程

    ### 3.1 完整管线

    ```
    LLM 输出 TS 代码字符串
        │
        ▼
    ┌──────────────────────────────────────┐
    │  Stage 1: 静态预检（< 1ms）           │
    │                                      │
    │  检查禁止模式：                        │
    │  - import / require / dynamic import │
    │  - process / global / globalThis     │
    │  - eval / Function constructor       │
    │  - fs / net / http / child_process   │
    │  - __dirname / __filename            │
    │                                      │
    │  未通过 → 拒绝执行，emit task.failed  │
    └──────────────────┬───────────────────┘
                    │ 通过
                    ▼
    ┌──────────────────────────────────────┐
    │  Stage 2: esbuild 转译（< 1ms）      │
    │                                      │
    │  esbuild.transform(code, {           │
    │    loader: 'ts',                     │
    │    target: 'es2022',                 │
    │    format: 'iife',                   │
    │  })                                  │
    │                                      │
    │  转译失败 → 拒绝执行，emit task.failed│
    └──────────────────┬───────────────────┘
                    │ 成功
                    ▼
    ┌──────────────────────────────────────┐
    │  Stage 3: 包装为可执行脚本            │
    │                                      │
    │  将转译后的 JS 包装进一个              │
    │  async 立即执行函数，注入 api 参数     │
    └──────────────────┬───────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────┐
    │  Stage 4: isolated-vm 执行           │
    │                                      │
    │  创建 Isolate → 创建 Context         │
    │  → 注入 Facade API References        │
    │  → 编译并运行脚本                     │
    │  → 等待执行完成或超时/中断             │
    │  → dispose Isolate                   │
    └──────────────────────────────────────┘
    ```

    ### 3.2 静态预检：禁止模式

    ```typescript
    const FORBIDDEN_PATTERNS: RegExp[] = [
    /\bimport\s/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
    /\bprocess\b/,
    /\bglobal\b/,
    /\bglobalThis\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\b__dirname\b/,
    /\b__filename\b/,
    ]

    function staticPrecheck(code: string): { ok: boolean; violation?: string } {
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(code)) {
        return { ok: false, violation: pattern.source }
        }
    }
    return { ok: true }
    }
    ```

    这不是安全的万无一失防线（正则可被绕过），而是**第一道快速筛查**。真正的安全边界是 isolated-vm 本身的 V8 隔离——沙箱内即使写了 `process.exit()`，V8 Isolate 里根本不存在 `process` 对象。

    ### 3.3 代码包装模板

    LLM（大语言模型）生成的代码被包装为一个 async（异步）函数。执行器注入语义化全局函数,这些全局函数再映射到 Facade API（门面接口）：

    ```javascript
    // 包装后的最终脚本
    (async function(runtime) {
    // ===== LLM 生成的代码开始 =====
    await reply("好的，我去砍 5 个木头喵")
    const task = await runGoal("砍 5 个木头", async () => {
      await ensure(
        async () => {
          await cutTree(5)
        },
        until.gainedTag("logs", 5),
      )
    })
    await report(task)
    // ===== LLM 生成的代码结束 =====
    })(runtime)
    ```

    `runtime`（运行时注入对象）由宿主进程通过 isolated-vm（V8 隔离沙箱） Reference（引用）机制注入。LLM（大语言模型） 不直接看到 `runtime`（运行时注入对象） 或 Facade API（门面接口） 的底层形态,只能调用受控语义函数与外界交互。

    ---

    ## 4. Facade API 完整类型定义

    ### 4.1 顶层结构

    ```typescript
    interface FacadeAPI {
    bot: BotAPI          // Bot 物理动作
    world: WorldAPI      // 环境查询（只读）
    knowledge: KnowledgeAPI  // MC 常识查询（只读）
    memory: MemoryAPI    // 历史记忆查询（只读）
    chat: ChatAPI        // 聊天输出
    owner: OwnerAPI      // 主人信息（只读）
    task: TaskAPI        // 任务自身元信息
    }
    ```

    Plan（规划） prompt（提示词） 不直接暴露上述命名空间结构,而是暴露 `reply`（开场回复）、`runGoal`（目标运行）、`ensure`（确保语义）、`until`（完成条件）、`mine`（挖掘）、`cutTree`（砍树）、`craft`（合成）、`place`（放置）、`equip`（装备）、`collect`（捡拾）、`report`（汇报） 等语义化全局函数。沙箱执行器在注入阶段把这些全局函数映射回 Facade API（门面接口） 与 BotActor（机器人执行代理） 单写者入口。这样 LLM（大语言模型） 写的是可读 TS（TypeScript） 计划,不是底层命名空间路径。

    ### 4.2 BotAPI — 物理动作

    每个方法都是异步的，执行完成后才返回。内部由 BotActor（机器人执行代理） 驱动 Mineflayer（Minecraft 协议客户端） 执行。

    T-054（任务）后，工具链能力分为三类：

    - 已注册 Phase 1（第一阶段） 技能：`goTo`（前往）、`mine`（挖掘）、`cutTree`（砍树）、`collect`（捡拾）、`equip`（装备）。
    - 已实现工具链基础能力：`craft`（合成） 与 `place`（放置）。其中 `place`（放置） Phase 1（第一阶段） 只允许放置 `crafting_table`（工作台），不得扩展成通用建筑系统。
    - 已实现通用 `ensure(action, condition)`（确保语义）：尝试动作、检查完成条件、捕获结构化失败、按 Minecraft（我的世界）事实解析依赖、补前置并回到原动作。不得向 LLM（大语言模型） 暴露一组具体 ensure（确保）函数。

    未实现能力不得注入真实 Facade API（门面接口） 伪装可用；实现前必须返回结构化 unsupported failure（不支持失败） 或不出现在当前 prompt（提示词） 可用方法中。

    ```typescript
    type ToolchainFailureCode =
      | "missing_materials"
      | "missing_crafting_table"
      | "crafting_table_unavailable"
      | "missing_crafting_table_item"
      | "no_placeable_position"
      | "place_failed"
      | "cached_position_invalid"
      | "cannot_place"
      | "not_equipped"
      | "resource_not_found"
      | "unsafe_path"
      | "unreachable_target"
      | "inventory_full"
      | "world_mismatch"
      | "unsupported_capability"

    interface ToolchainFailure {
      code: ToolchainFailureCode
      message: string
      world_key: string | null
      details?: Record<string, unknown>
    }

    type ToolchainResult<T> =
      | { ok: true; data: T }
      | { ok: false; error: ToolchainFailure }

    interface BotAPI {
    /**
     * 寻路移动到指定坐标
     * @returns 到达后的实际坐标
     * @throws NavigationError 如果找不到路径
     */
    goTo(x: number, y: number, z: number): Promise<Position>

    /**
     * 移动到主人身边
     * @param distance 停在主人多远处（默认 2 格）
     */
    goToOwner(distance?: number): Promise<Position>

    /**
     * 持续跟随主人
     * 这是一个长时运行动作，直到被外部中断
     * @param distance 保持距离（默认 3 格）
     */
    follow(distance?: number): Promise<void>

    /**
     * 挖掘指定资源方块。stone 不进入 ResourceService，执行层直接 runtime scan；iron_ore / deepslate_iron_ore 先走 ResourceService 具体方块簇，再用 StairBFSPlanner 生成安全短段。mine 自带移动、挖掘与掉落物 collect（捡拾）,完成标准来自 runtime 基于背包增量返回的 collected_count。
     * 失败必须保留结构化原因：not_equipped、resource_not_found、unsafe_path、unreachable_target、drop_not_obtained、runtime_mine_failed。
     */
    mine(blockName: string, count: number): Promise<ToolchainResult<{ block_name: string; completed_count: number; world_key: string | null }>>

    /**
     * 合成指定物品。材料、配方、是否需要工作台必须由 minecraft-data / Mineflayer / runtime 校验。
     */
    craft(itemName: string, count: number): Promise<ToolchainResult<{ item_name: string; completed_count: number; world_key: string | null }>>

    /**
     * 放置指定方块。Phase 1 仅允许 crafting_table；place 只尝试放置背包已有物品,不展开完整资源链。
     * 若缺工作台物品、缺材料、无合法位置或运行时放置失败,必须返回结构化失败,由 ensure 解析依赖并补前置。
     * runtime 在当前世界中选择最多 3 个附近合法候选点顺序尝试。工具链返回 ok:false 时必须使代码步骤失败并保留结构化 error.code，不得把失败当成成功执行。
     */
    place(blockName: 'crafting_table', near?: Position): Promise<ToolchainResult<{ block_name: string; completed_count: number; world_key: string | null; position?: Position }>>
    placeCraftingTable(): Promise<ToolchainResult<{ block_name: 'crafting_table'; completed_count: number; world_key: string | null; position?: Position }>>

    /**
     * 收集附近掉落物
     * @param itemName 物品名称
     * @param radius 搜索半径
     * @returns 实际收集的数量
     */
    collect(itemName: string, radius?: number): Promise<{ collected: number }>

    /**
     * 装备物品
     * @param itemName 物品名称
     * @param destination 装备位置
     */
    equip(itemName: string, destination?: 'hand'): Promise<{ skill: 'equip'; item_name: string; destination: 'hand'; status: 'already_equipped' | 'equipped'; total_steps: 0 | 1 }>

    /**
     * 砍树（复合动作：找到树 → 移动过去 → 挖原木 → 收集掉落物）
     * @param count 砍多少棵
     * @returns 实际收集到的原木数量
     */
    cutTree(count: number): Promise<{ collected: number }>

    /**
     * 通用 ensure（确保语义）。action 是要尝试的动作,condition 是完成条件。
     * ensure 内部只能基于结构化失败码和 Minecraft（我的世界）事实源补局部前置,不得变成一次性挖铁脚本。
     */
    ensure(action: () => Promise<void>, condition: UntilCondition): Promise<void>

    /**
     * 攻击实体
     * @param entityName 实体名称或 'nearest_hostile'
     */
    attack(entityName: string): Promise<{ killed: boolean }>

    /**
     * 查看自身状态
     */
    getStatus(): Promise<BotStatus>

    /**
     * 查看背包内容
     */
    getInventory(): Promise<InventoryItem[]>
    }

    interface Position {
    x: number
    y: number
    z: number
    }

    interface BotStatus {
    position: Position
    health: number
    food: number
    experience: number
    is_on_fire: boolean
    is_in_water: boolean
    }

    interface InventoryItem {
    name: string
    count: number
    slot: number
    }
    ```

    **统一结果摘要**：TS（TypeScript） 代码任务能力的终态必须进入统一 `SkillResultSummary`（技能结果摘要），供 `TaskResultReporter`（任务结果汇报器）、diagnostics（诊断） 与后续上下文消费：

    ```typescript
    interface SkillResultSummary {
      skill_name: string
      status: 'completed' | 'failed' | 'interrupted'
      target?: string
      requested_count?: number
      completed_count?: number
      inventory_delta?: Array<{ item_name: string; count: number }>
      world_key?: string | null
      duration_ms?: number
      diagnostics?: string[]
      failure?: {
        failure_code: string
        failure_stage: string
        message: string
        recoverable: boolean | null
        current_position?: Position | null
        inventory_summary?: Record<string, unknown> | null
        equipment_summary?: Record<string, unknown> | null
        target_progress?: {
          action?: string | null
          target?: string | null
          requested_count?: number | null
          completed_count?: number | null
          target_count?: number | null
        } | null
      }
    }
    ```

    `craft`（合成）、`place`（放置）、`equip`（装备）、`mine`（挖掘）、`collect`（捡拾）、`cutTree`（砍树） 与 `ensure`（确保语义） 都必须能转换为上述摘要。没有数量语义的 `equip` / `place` 仍要写入可读状态，例如 `already_equipped`（已装备） 或 `placed`（已放置） 到 `details` / diagnostics（诊断） 中。失败码至少区分 `resource_not_found`（找不到资源）、`unsafe_path`（路径不安全）、`not_equipped`（未装备）、`missing_materials`（缺材料）。

    **失败上下文**：所有可编程动作失败时，`FacadeCallError.details`（门面调用错误细节） 必须保留 `failure_stage`（失败阶段）、`current_position`（当前位置摘要）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要） 与 `target_progress`（目标完成度）。这些完整字段进入 sandbox（沙箱） JSONL（结构化日志）、diagnostics（诊断） 和 step result（步骤结果）；下一轮 Plan（规划） prompt（提示词） 只读取由执行终态摘要格式化出的短 Failure Capsule（失败胶囊）,不默认注入完整失败详情。不允许只返回字符串。

    **禁止项**：不得新增或暴露 `demoMineIron()`（演示挖铁） 或等价的一键隐藏链路。用户说“挖铁”时，LLM（大语言模型） 应生成可读 TS（TypeScript） 组合，显式调用 `reply`（开场回复）、`runGoal`（目标运行）、`ensure`（确保语义）、`until`（完成条件）、`mine`（挖掘） 与 `report`（汇报）。TS Core（TypeScript 核心） 不得把整条链路藏在单个 demo（演示） 方法里,也不得向 LLM（大语言模型） 暴露具体 ensure（确保）函数。

    **世界定位硬约束**：上述所有能力涉及资源、坐标、维度或缓存时，必须从 existing world tag（既有世界标签）、`currentWorld`（当前世界） 或 ResourceService（资源服务） 读取世界上下文。TS（TypeScript） 计划、skills（技能） 与 runtime（运行时） 不得自行读取维度字段并拼接 `world_key`（世界键），也不得跨世界复用资源缓存。

    ### 4.3 WorldAPI — 环境查询

    全部只读，从 observation 缓存读取，不触发 Mineflayer 写操作。

    ```typescript
    interface WorldAPI {
    /**
     * 查找附近指定类型的方块
     * @param blockName 方块名称
     * @param radius 搜索半径（默认 64）
     * @param maxCount 最多返回几个（默认 10）
     * @returns 按距离排序的坐标列表
     */
    nearestBlocks(blockName: string, radius?: number, maxCount?: number): Promise<BlockInfo[]>

    /**
     * 查找附近实体
     * @param filter 过滤条件
     * @param radius 搜索半径
     */
    nearestEntities(filter?: EntityFilter, radius?: number): Promise<EntityInfo[]>

    /**
     * 获取指定坐标的方块信息
     */
    blockAt(x: number, y: number, z: number): Promise<BlockInfo | null>

    /**
     * 获取当前时间（游戏内时间）
     */
    getTime(): Promise<{ timeOfDay: number; isDay: boolean }>

    /**
     * 获取当前生物群系
     */
    getBiome(): Promise<string>
    }

    interface BlockInfo {
    name: string
    position: Position
    distance: number
    }

    interface EntityInfo {
    name: string
    type: 'player' | 'hostile' | 'passive' | 'item' | 'other'
    position: Position
    distance: number
    health?: number
    }

    interface EntityFilter {
    type?: EntityInfo['type']
    name?: string
    }
    ```

    ### 4.4 KnowledgeAPI — MC 常识查询

    确定性查询，底层直连 `minecraft-data` 本地 JSON。永远不走 LLM，永远不走网络。

    ```typescript
    interface KnowledgeAPI {
    /**
     * 查询合成配方
     * @param itemName 目标物品
     * @returns 所有可用配方
     */
    getRecipe(itemName: string): Promise<Recipe[]>

    /**
     * 查询方块属性（硬度、掉落物、需要的工具等级）
     */
    getBlockInfo(blockName: string): Promise<BlockData | null>

    /**
     * 查询物品属性
     */
    getItemInfo(itemName: string): Promise<ItemData | null>

    /**
     * 查询实体属性（生命值、攻击力、掉落物）
     */
    getEntityInfo(entityName: string): Promise<EntityData | null>

    /**
     * 查询冶炼配方
     */
    getSmeltingRecipe(itemName: string): Promise<SmeltingRecipe | null>
    }

    interface Recipe {
    result: { name: string; count: number }
    ingredients: { name: string; count: number }[]
    requiresCraftingTable: boolean
    }

    interface BlockData {
    name: string
    hardness: number
    drops: string[]
    harvestTools: string[]      // 可采集的最低工具
    transparent: boolean
    }

    interface ItemData {
    name: string
    stackSize: number
    durability?: number
    foodRestore?: number
    }

    interface EntityData {
    name: string
    health: number
    attackDamage: number
    drops: { name: string; chance: number }[]
    hostile: boolean
    }

    interface SmeltingRecipe {
    input: string
    output: string
    experience: number
    }
    ```

    ### 4.5 MemoryAPI — 历史记忆查询

    ```typescript
    interface MemoryAPI {
    /**
     * 搜索历史记忆（混合 RAG：全文 + 向量）
     * @param query 自然语言查询
     * @param limit 返回条数
     * @returns 按相关度排序的记忆摘要
     */
    search(query: string, limit?: number): Promise<MemoryEntry[]>

    /**
     * 获取最近 N 条任务历史
     */
    recentTasks(limit?: number): Promise<TaskSummary[]>
    }

    interface MemoryEntry {
    summary: string
    relevance_score: number
    timestamp: number
    task_id?: string
    }

    interface TaskSummary {
    task_id: string
    intent: string
    status: 'completed' | 'failed' | 'interrupted'
    summary: string
    timestamp: number
    }
    ```

    ### 4.6 ChatAPI — 聊天输出

    ```typescript
    interface ChatAPI {
    /**
     * 向主人说一句话
     * 通过 Socket.io 广播到网页端 + 游戏端聊天栏
     * @param message 消息内容
     */
    say(message: string): Promise<void>

    /**
     * 向主人展示一个状态信息（进度、发现等）
     * 与 say 的区别：say 是角色扮演式对话，report 是系统式状态汇报
     */
    report(message: string): Promise<void>
    }
    ```

    ### 4.7 OwnerAPI — 主人信息

    ```typescript
    interface OwnerAPI {
    /** 主人当前位置 */
    readonly position: Position
    /** 主人名称 */
    readonly name: string
    /** 主人是否在线 */
    readonly online: boolean
    }
    ```

    注意：`owner.position`（主人位置） 是读取时的实时值（通过 observation 缓存），不是任务开始时的快照。TS（TypeScript） 代码每次访问 `owner.position` 都会拿到最新位置。

    ### 4.8 TaskAPI — 任务自身元信息

    ```typescript
    interface TaskAPI {
    /** 当前任务 ID */
    readonly id: string
    /** 用户原始消息 */
    readonly userMessage: string
    /** ConversationWorker 解析出的意图描述 */
    readonly intent: string
    }
    ```

    ---

    ## 5. Facade API 注入机制

    ### 5.1 isolated-vm 的 Reference 回调模型

    isolated-vm 的核心通信原语是 `Reference`：一个跨 Isolate 的函数指针。沙箱内调用 Reference 时，实际执行发生在宿主进程。

    ```typescript
    import ivm from 'isolated-vm'

    function createSandboxContext(
    isolate: ivm.Isolate,
    botActor: BotActor,
    signal: AbortSignal,
    job: ExecJob
    ): ivm.Context {
    const context = isolate.createContextSync()
    const jail = context.global

    // 注入顶层 api 对象
    const apiRef = new ivm.Reference({
        bot: createBotAPIProxy(botActor, signal),
        world: createWorldAPIProxy(botActor.observation, signal),
        knowledge: createKnowledgeAPIProxy(),
        memory: createMemoryAPIProxy(),
        chat: createChatAPIProxy(botActor, signal),
        owner: createOwnerAPIProxy(botActor.observation),
        task: {
        id: job.message_id,
        userMessage: job.userMessage ?? '',
        intent: job.intent ?? '',
        },
    })

    jail.setSync('__apiRef', apiRef)

    // 在 isolate 内部解包 Reference 为可调用对象
    context.evalSync(`
        const api = __apiRef.copySync();
        delete __apiRef;
    `)

    return context
    }
    ```

    ### 5.2 异步方法的跨 Isolate 桥接

    > **⚠️ 实现警告**：以下代码为概念性伪代码，展示跨 Isolate 异步桥接的设计意图。isolated-vm 的 `ExternalCopy` 不能直接包装 Promise 对象。实际实现时需要使用 `Reference.applySync` + `transferIn` 模式，或通过 `ivm.Reference` 回调 + 宿主侧 Promise resolve 的方式完成异步桥接。实现前必须编写 PoC 验证 async/await 在 isolate 内的可行性。

    isolated-vm 的 Reference 回调是同步的。要支持 async/await，需要把异步操作包装为 `Reference.applySync()` + `Promise` 桥接：

    ```typescript
    function createBotAPIProxy(botActor: BotActor, signal: AbortSignal) {
    return {
        goTo: new ivm.Reference(function(x: number, y: number, z: number) {
        // 返回一个 transferable Promise
        return new ivm.ExternalCopy(
            botActor.executeFacadeCall('goTo', { x, y, z }, signal)
        ).copyInto()
        }),

        mine: new ivm.Reference(function(blockName: string, count: number) {
        return new ivm.ExternalCopy(
            botActor.executeFacadeCall('mine', { blockName, count }, signal)
        ).copyInto()
        }),

        // ... 其他方法同理
    }
    }
    ```

    **关键约束**：每个 Facade API 方法内部都必须检查 `signal.aborted`。如果中断已发生，立即 reject，不执行任何 Mineflayer 操作。

    ### 5.3 executeFacadeCall：BotActor 的统一网关

    所有 Facade API 方法最终汇聚到 BotActor 的一个统一入口：

    ```typescript
    class BotActor {
    async executeFacadeCall(
        method: string,
        params: Record<string, unknown>,
        signal: AbortSignal
    ): Promise<unknown> {
        // 1. 中断检查
        signal.throwIfAborted()

        // 2. 方法路由到对应 skill
        const skill = this.skillRegistry.get(method)
        if (!skill) {
        throw new FacadeError(`Unknown method: ${method}`)
        }

        // 3. 执行 skill（signal 穿透到 Mineflayer）
        const result = await skill.execute(params, signal)

        // 4. 记录步骤（返回给沙箱的同时写日志）
        this.currentStepResults.push({
        action: method,
        params,
        result,
        timestamp: Date.now(),
        })

        return result
    }
    }
    ```

    这保证了：
    - **单写者**：所有写操作都经过 BotActor
    - **signal 穿透**：中断信号一路到底
    - **统一日志**：每次 Facade 调用都被记录
    - **可审计**：沙箱代码做了什么，BotActor 全知道

    ---

    ## 6. 安全边界

    ### 6.1 沙箱内不存在的东西

    isolated-vm 的 V8 Isolate 是一个干净的 JavaScript 执行环境。以下宿主对象在沙箱内**根本不存在**，不是被禁止，是物理上不存在：

    | 不存在的对象 | 含义 |
    |-------------|------|
    | `process` | 无法访问进程信息、环境变量、退出进程 |
    | `require` / `import` | 无法加载任何模块 |
    | `fs` / `net` / `http` | 无法访问文件系统和网络 |
    | `child_process` | 无法创建子进程 |
    | `global` / `globalThis` | 被沙箱自己的 global 覆盖 |
    | `setTimeout` / `setInterval` | 除非显式注入，否则不存在 |
    | `Buffer` | 不存在 |
    | `console` | 不存在（除非显式注入安全版本） |

    ### 6.2 显式注入的安全工具

    ```typescript
    // 安全的 console（只能向宿主写日志，无法做其他事）
    const safeConsole = new ivm.Reference({
    log: new ivm.Reference((...args: unknown[]) => {
        diagnostics.appendSandboxLog(jobId, 'log', args)
    }),
    warn: new ivm.Reference((...args: unknown[]) => {
        diagnostics.appendSandboxLog(jobId, 'warn', args)
    }),
    error: new ivm.Reference((...args: unknown[]) => {
        diagnostics.appendSandboxLog(jobId, 'error', args)
    }),
    })
    jail.setSync('console', safeConsole)

    // 安全的 sleep（让沙箱代码可以等待一段时间）
    const safeSleep = new ivm.Reference((ms: number) => {
    const capped = Math.min(ms, 10_000) // 单次最多等 10 秒
    return new Promise(resolve => setTimeout(resolve, capped))
    })
    jail.setSync('sleep', safeSleep)
    ```

    ### 6.3 资源限制

    | 资源 | 限制 | 超限行为 |
    |------|------|---------|
    | 内存 | 128 MB（`memoryLimit`） | Isolate 自行终止，宿主捕获异常 |
    | 执行时间 | 120 秒（`SANDBOX_TIMEOUT_MS`） | AbortController 超时触发 |
    | 单次 sleep | 10 秒 | 被强制截断到 10 秒 |
    | Facade API 调用频率 | 不限制（Phase 1） | 未来可加限流 |

    ### 6.4 防御性校验层级

    ```
    第一层：静态预检（正则扫描禁止模式）
        ↓ 能拦住明显的恶意代码和低级错误
    第二层：esbuild 转译（语法校验）
        ↓ 能拦住 TS 语法错误
    第三层：isolated-vm 隔离（V8 Isolate 物理隔离）
        ↓ 沙箱内根本不存在宿主对象，无法逃逸
    第四层：Facade API 参数校验（每个方法入口校验）
        ↓ 无效参数在 BotActor 侧被拒绝
    第五层：BotActor 单写者审批（所有动作经过统一网关）
        ↓ 任何不合理的操作序列可被拦截
    第六层：资源限制（内存 + 时间 + signal）
        ↓ 即使前面都没拦住，资源耗尽后强制终止
    ```

    ---

    ## 7. 超时与生命周期管理

    ### 7.1 Isolate 生命周期

    ```
    任务开始
        │
        ├─ isolate = new ivm.Isolate({ memoryLimit: 128 })
        ├─ context = createSandboxContext(isolate, botActor, signal, job)
        │
        ▼
    执行代码
        │
        ├─ 正常完成 → 收集结果
        ├─ AbortError → 中断退出
        ├─ 执行异常 → 捕获错误
        └─ 内存超限 → Isolate 自动终止
        │
        ▼
    清理
        │
        ├─ context.release()
        ├─ isolate.dispose()
        └─ isolate = null
    ```

    ### 7.2 超时控制的三层嵌套

    ```
    ┌─────────────────────────────────────────────┐
    │  Layer 1: BotActor 总超时                    │
    │  SANDBOX_TIMEOUT_MS = 120s                   │
    │  通过 AbortController + setTimeout 实现       │
    │                                              │
    │  ┌────────────────────────────────────────┐  │
    │  │  Layer 2: isolated-vm 脚本超时          │  │
    │  │  script.run({ timeout: 115_000 })      │  │
    │  │  比总超时短 5 秒，给清理留余量           │  │
    │  │                                        │  │
    │  │  ┌─────────────────────────────────┐   │  │
    │  │  │  Layer 3: 单个 Facade API 调用   │   │  │
    │  │  │  每个 skill 自带超时              │   │  │
    │  │  │  如 goTo: 30s, mine: 60s        │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  └────────────────────────────────────────┘  │
    └─────────────────────────────────────────────┘
    ```

    三层超时的关系：内层超时总是短于外层。单个 Facade 调用超时 → 该调用失败，沙箱代码可以 try/catch 处理。脚本超时 → 整个执行终止。BotActor 总超时 → 强制 abort + dispose isolate。

    ### 7.3 中断后的清理时序

    ```
    AbortController.abort() 被调用
        │
        t=0     signal.aborted = true
        │       沙箱内下一个 await 点抛出 AbortError
        │
        t=0~500ms  等待沙箱执行函数返回（finally 清理）
        │
        t=500ms    如果沙箱还没返回：
        │          isolate.dispose() 强制终止
        │          ABORT_CLEANUP_TIMEOUT_MS = 500
        │
        t=500ms+   context.release(), isolate = null
                BotActor 状态转换
    ```

    ---

    ## 8. LLM 代码生成约束

    本节定义 LLM 生成代码时必须遵守的约束。这些约束会体现在 CONVERSATION_SPEC.md 中的 system prompt 里。

    ### 8.1 代码结构约束

    ```
    LLM 生成的代码必须是一段顶层 async 函数体：

    ✅ 正确：
    await reply("好的，我去挖 5 个石头喵")
    const task = await runGoal("挖 5 个石头", async () => {
      await ensure(
        async () => {
          await mine("stone", 5)
        },
        until.gained("cobblestone", 5),
      )
    })
    await report(task)

    ❌ 错误：
    import { something } from 'somewhere'   // 禁止 import
    const fs = require('fs')                // 禁止 require
    export default function() {}            // 禁止 export
    class MyBot {}                          // 不需要定义 class
    ```

    ### 8.2 可用的全局对象

    | 对象 | 说明 |
    |------|------|
    | `reply` / `report` | 开场回复与终态汇报 |
    | `runGoal` | 目标生命周期包装 |
    | `ensure` / `until` | 依赖补齐与完成条件 |
    | `mine` / `cutTree` / `craft` / `place` / `equip` / `collect` / `goTo` | 受控动作能力 |
    | `owner` | 主人只读上下文 |
    | `console` | 安全版 console，只支持 log/warn/error |
    | `sleep(ms)` | 等待指定毫秒数（上限 10 秒） |
    | `Math` | 标准 Math 对象 |
    | `JSON` | 标准 JSON 对象 |
    | `Date` | 标准 Date 对象 |
    | `Array` / `Object` / `Map` / `Set` | 标准数据结构 |
    | `Promise` | 标准 Promise |

    ### 8.3 错误处理约束

    LLM 生成的代码应该使用 try/catch 处理预期内的失败：

    ```typescript
    // 推荐模式
    try {
    await ensure(
      async () => {
        await mine("diamond_ore", 10)
      },
      until.gained("diamond", 10),
    )
    } catch (e) {
    await reply("附近暂时没找到钻石矿，我先换一个可行目标喵")
    await ensure(
      async () => {
        await mine("iron_ore", 10)
      },
      until.gained("raw_iron", 10),
    )
    }
    ```

    如果代码没有 try/catch，未捕获的异常会导致整个任务标记为 failed。这不是灾难——BrainWorker 会评估是否重规划——但有 try/catch 的代码更健壮。

    ### 8.4 代码长度约束

    | 约束 | 限制 | 理由 |
    |------|------|------|
    | 最大字符数 | 10,000 | 超长代码说明 LLM 试图做太多事，应该拆分 |
    | 最大行数 | 200 | 同上 |
    | 最大嵌套深度 | 不限制 | esbuild 转译 + runtime 执行会自然暴露问题 |

    超限的代码在 Stage 1 静态预检时拒绝。

    ---

    ## 9. 步骤结果收集

    ### 9.1 沙箱内代码如何产出 StepResult

    沙箱内的代码不需要显式 yield。BotActor 的 `executeFacadeCall` 在每次语义函数映射到 Facade API（门面接口） 调用完成后，自动收集一个 StepResult。

    从 BotActor 的角度看，沙箱执行的步骤流就是一连串的 `executeFacadeCall` 调用：

    ```
    TS 代码:   await goTo(100, 64, 200)
    BotActor:  executeFacadeCall('goTo', {x:100,y:64,z:200}) → StepResult #0

    TS 代码:   await mine('stone', 5)
    BotActor:  executeFacadeCall('mine', {blockName:'stone',count:5}) → StepResult #1

    TS 代码:   await report(task)
    BotActor:  executeFacadeCall('report', {task}) → StepResult #2
    ```

    ### 9.2 StepResult 与事件流的关系

    每个 StepResult 对应一个 `step.progress` 事件，写入 event_log 并通过 Socket.io 广播：

    ```typescript
    // BotActor 内部
    private onFacadeCallCompleted(result: StepResult): void {
    // 1. event_log
    this.emitEvent({
        type: 'step.progress',
        job_id: this.currentJobId,
        ...result,
    })

    // 2. BullMQ job progress
    this.currentJob?.updateProgress({
        step_index: result.step_index,
        action: result.action,
        status: result.status,
    })

    // 3. JSONL 日志
    this.diagnostics.appendStep(this.currentJobId, result)
    }
    ```

    ### 9.3 只读 API 调用不产出 StepResult

    WorldAPI、KnowledgeAPI、MemoryAPI、OwnerAPI 的查询不是"步骤"，不产出 StepResult，不写入 event_log。它们是沙箱代码的信息获取操作，不是 Bot 的物理动作。

    只有 BotAPI 和 ChatAPI 的方法才产出 StepResult。

    ---

    ## 10. 代码任务与底层动作能力

    ### 10.1 唯一在线执行入口

    ConversationWorker（对话工作线程） 在线只产出代码型 job。简单任务和复杂任务都进入同一个代码执行生命周期：

    ```typescript
    type ExecJob = {
      type: 'code'
      code: string
      intent_epoch: number
      snapshot_ts: number
      message_id: string
    }
    ```

    代码任务统一经过静态预检、esbuild（构建转译器） 转译、isolated-vm（V8 隔离沙箱） 执行、Facade API（门面接口） 审批和 BotActor（机器人执行代理） 单写者动作入口。不得恢复 ConversationWorker（对话工作线程） 直接指定 skill（技能） 名与参数的在线快路径。

    ### 10.2 语义 API 与底层 skill 的关系

    Plan（规划） 看到的是语义化全局 API（应用程序接口）,底层可复用 skill（技能） 模块实现：

    ```
    TS 语义 API                 底层动作能力
    ─────────────               ─────────────
    goTo(...)              →    goTo（移动）
    mine(...)              →    mine（挖掘，自带 collect）
    cutTree(...)           →    cutTree（砍树，自带 collect）
    collect(...)           →    collect（捡拾）
    craft(...)             →    craft（合成）
    place(...)             →    place（放置）
    equip(...)             →    equip（装备）
    ensure(action, until)   →    dependency resolver（依赖解析器）+ 上述动作能力
    report(task)           →    TaskResultReporter（任务结果汇报器）/ optional report LLM（可选汇报大语言模型）
    ```

    `ensure`（确保语义） 的 dependency resolver（依赖解析器） 根据结构化失败码和 Minecraft（我的世界）事实源推导局部依赖。例如 `mine("iron_ore", 1)` 返回 `not_equipped`（未装备） 时,解析器查询 runtime（运行时）/minecraft-data（Minecraft 数据库） 得到所需工具,再通过 `craft`（合成）、`equip`（装备）、`mine("stone")`（挖石头）、`cutTree`（砍树） 等动作补前置。该依赖链是系统能力,不是 LLM（大语言模型） 手写事实表。

    ### 10.3 新增动作能力的步骤

    增加一个新的 Bot（机器人）动作能力只需要三步：

    1. 在 skills（技能）/runtime（运行时） 边界实现动作能力。
    2. 在语义 API（应用程序接口） 与 Facade API（门面接口） 中暴露最小函数。
    3. 在 dependency resolver（依赖解析器） 中补充该能力的结构化失败处理和依赖映射。

    多步目标必须通过 TS（TypeScript） 代码里的 `runGoal`（目标运行） + `ensure`（确保语义） + `until`（完成条件） 组合表达。

    ---

    ## 11. 诊断与调试

    ### 11.1 沙箱执行日志

    每次沙箱执行产出一个独立的 JSONL 文件：

    ```
    logs/sandbox/
    └── 2026-04-12/
        ├── T-abc123.jsonl     # 任务级执行日志
        └── T-abc123.code.ts   # LLM 生成的原始 TS 代码
    ```

    JSONL 内容示例：

    ```jsonl
    {"t":1712930000,"phase":"precheck","ok":true}
    {"t":1712930001,"phase":"transpile","ok":true,"duration_ms":0.8}
    {"t":1712930002,"phase":"isolate_create","mem_limit_mb":128}
    {"t":1712930003,"phase":"facade_call","method":"goTo","params":{"x":100,"y":64,"z":200}}
    {"t":1712930008,"phase":"facade_result","method":"goTo","status":"success","duration_ms":5200}
    {"t":1712930009,"phase":"facade_call","method":"mine","params":{"blockName":"oak_log","count":5}}
    {"t":1712930025,"phase":"facade_result","method":"mine","status":"success","result":{"collected":5},"duration_ms":16000}
    {"t":1712930025,"phase":"sandbox_complete","total_steps":2,"duration_ms":25000}
    ```

    ### 11.2 console 输出捕获

    沙箱内的 `console.log()` / `console.warn()` / `console.error()` 全部被捕获写入同一个 JSONL 文件：

    ```jsonl
    {"t":1712930010,"phase":"console","level":"log","args":["找到了5棵树"]}
    {"t":1712930015,"phase":"console","level":"warn","args":["第3棵树附近有僵尸"]}
    ```

    ### 11.3 LLM 原始代码保留

    LLM 生成的 TS 代码原文保存为 `.code.ts` 文件。当任务失败时，开发者可以直接查看"LLM 到底写了什么代码"，对照 JSONL 日志定位问题。

    ---

    ## 12. 错误类型与处置

    ### 12.1 沙箱层面的错误分类

    | 错误类型 | 触发场景 | 处置 |
    |---------|---------|------|
    | `StaticCheckError` | 禁止模式命中 | 拒绝执行，emit task.failed |
    | `TranspileError` | esbuild 转译失败（TS 语法错误） | 拒绝执行，emit task.failed |
    | `SandboxTimeoutError` | 脚本执行超过 `timeout` | 终止 isolate，emit task.failed |
    | `SandboxOOMError` | 内存超过 `memoryLimit` | Isolate 自行终止，emit task.failed |
    | `FacadeCallError` | Facade API 方法执行失败（找不到路、挖不到矿等） | 抛给沙箱代码的 catch，沙箱可处理 |
    | `AbortError` | 中断信号到达 | 沙箱执行终止，emit task.interrupted |
    | `UnhandledError` | 沙箱代码未捕获的 JS 运行时异常 | emit task.failed |

    TS（TypeScript） 代码任务终态由 BotWorker（机器人工作线程） 统一进入 `TaskResultReporter`（任务结果汇报器）。成功、失败、中断都必须生成一次结构化 `result_summary`（结果摘要）。`report(task)`（汇报任务） 的职责是提交 `runGoal`（目标运行） 产生的结构化 GoalResult（目标结果），不是让沙箱代码直接拼最终聊天文案；真正对外发送的终态文本由 `TaskResultReporter`（任务结果汇报器） 基于 `result_summary`（结果摘要） 生成。启用 `ReportLLM`（汇报大语言模型） 时，它只能在终态事实基础上润色表达，不能改事实、数量、世界、耗时、失败码、中断原因或完成状态；润色失败时必须回退到确定性模板。不得让代码任务失败沉默。

    ### 12.2 错误信息的传递

    所有错误信息都记录在 event_log 和 JSONL 中。FacadeCallError 额外携带结构化的失败原因：

    ```typescript
    interface FacadeCallError {
    method: string
    params: Record<string, unknown>
    error_code: string          // 'path_not_found' | 'block_not_reachable' | 'inventory_full' | ...
    message: string
    recoverable: boolean        // 沙箱代码是否可以 try/catch 后继续
    }
    ```

    `recoverable: true` 的错误意味着沙箱代码可以 catch 后尝试替代方案。`recoverable: false` 的错误（如 AbortError）意味着必须停止执行。

    ---

    ## 13. 配置参数

    | 参数 | 默认值 | 环境变量 | 说明 |
    |------|--------|---------|------|
    | `SANDBOX_MEMORY_LIMIT_MB` | 128 | `SANDBOX_MEM_MB` | isolated-vm 内存上限 |
    | `SANDBOX_TIMEOUT_MS` | 120000 | `SANDBOX_TIMEOUT_MS` | 沙箱总执行超时 |
    | `SANDBOX_SCRIPT_TIMEOUT_MS` | 115000 | — | isolated-vm script.run 超时，比总超时短 5 秒 |
    | `SANDBOX_ABORT_CLEANUP_MS` | 500 | `ABORT_CLEANUP_MS` | 中断后等待沙箱清理的最大时间 |
    | `SANDBOX_MAX_CODE_LENGTH` | 10000 | `SANDBOX_MAX_CODE` | 允许的最大代码字符数 |
    | `SANDBOX_MAX_SLEEP_MS` | 10000 | — | 单次 sleep 上限 |

    ---

    ## 14. 后续文档依赖

    本文档定义了沙箱的完整执行规格。以下文档依赖本文档：

    - **SKILL_CATALOG.md**：依赖第 10 节 SkillFunction 类型定义、第 4.2 节 BotAPI 方法签名
    - **CONVERSATION_SPEC.md**：依赖第 8 节 LLM 代码生成约束、第 4 节 Facade API 完整类型定义（用于构造 system prompt）
    - **DATA_SPEC.md**：依赖第 11 节 JSONL 日志格式

    ---

    v0.1 完毕。你审一遍，没问题就继续下一个文档。
