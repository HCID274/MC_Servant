    # SANDBOX_SPEC.md — TS 代码沙箱执行规格

    > v0.2 | 2026.05 | 依赖 ARCHITECTURE.md v0.4, RUNTIME_SPEC.md v0.1

    ---

    ## 0. 本文档的职责边界

    本文档定义 TS 代码沙箱的完整执行规格：isolated-vm 集成方案、顶层语义 API、内部 host bridge、动作完成证明、安全边界、超时策略、代码转译流程、错误处理。

    **本文档不涉及**：BotActor 状态机（见 RUNTIME_SPEC.md）、具体 skill 的游戏逻辑实现（见 `skills/` 与 `core-ports/skills`）、LLM 如何生成代码（见 CONVERSATION_SPEC.md）。

    ---

    ## 1. 沙箱的核心定位

    沙箱不是一个"代码运行器"。它是 **LLM 意志与物理世界之间的翻译膜**。

    LLM 生成的 TS 代码表达了"意图的执行计划"——先去哪、再挖什么、挖多少、遇到问题怎么处理。沙箱的职责是：让这段代码在一个受控环境里运行，每一步通过顶层语义 API 向内部 host bridge 发起请求，再由 BotActor 审批后驱动 Mineflayer 执行。

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
    │  async 立即执行函数，注入语义函数      │
    └──────────────────┬───────────────────┘
                    │
                    ▼
    ┌──────────────────────────────────────┐
    │  Stage 4: isolated-vm 执行           │
    │                                      │
    │  创建 Isolate → 创建 Context         │
    │  → 注入语义 API / host bridge        │
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

    LLM（大语言模型）生成的代码被包装为一个 async（异步）函数。执行器注入语义化全局函数,这些全局函数再映射到内部 host bridge：

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

    `runtime`（运行时注入对象）由宿主进程通过 isolated-vm（V8 隔离沙箱） Reference（引用）机制注入。LLM（大语言模型） 不直接看到 `runtime`（运行时注入对象） 或 host bridge 的底层形态,只能调用受控语义函数与外界交互。

    ---

    ## 4. 顶层语义 API 与内部 host bridge

    ### 4.1 顶层结构

    ```typescript
    interface SandboxSemanticGlobals {
      reply(message: string): Promise<void>
      runGoal(name: string, action: () => Promise<void>): Promise<SandboxGoalResult>
      ensure(action: () => Promise<void>, condition: UntilCondition): Promise<void>
      until: UntilFactory
      mine(blockName: string, count: number): Promise<ToolchainResult<unknown>>
      cutTree(count: number): Promise<ToolchainResult<unknown>>
      craft(itemName: string, count: number): Promise<ToolchainResult<unknown>>
      place(blockName: 'crafting_table', near?: Position): Promise<ToolchainResult<unknown>>
      equip(itemName: string, destination?: 'hand'): Promise<ToolchainResult<unknown>>
      collect(itemName: string, radius?: number): Promise<ToolchainResult<unknown>>
      goTo(x: number, y: number, z: number): Promise<ToolchainResult<unknown>>
      report(task: SandboxGoalResult): Promise<void>
      search(query: string): Promise<unknown>
      sleep(ms: number): Promise<void>
      owner: Readonly<OwnerContext>
    }
    ```

    Plan（规划） prompt（提示词） 只暴露这些语义化全局函数。沙箱执行器在注入阶段把这些全局函数映射到内部 host bridge 与 BotActor（机器人执行代理） 单写者入口。这样 LLM（大语言模型） 写的是可读 TS（TypeScript） 计划,不是底层命名空间路径。旧 `api.bot` / `api.chat` / `api.task` / `api.owner` 不属于在线执行面,只能存在于 legacy/test-only 或负向测试。

    ### 4.2 语义函数到 host bridge 的映射

    在线沙箱不提供 `api.bot`、`api.chat`、`world`、`knowledge`、`task` 等命名空间对象。Plan TS（规划代码）只能调用顶层语义函数；bootstrap（引导脚本）负责把这些函数映射到内部 method（方法） 名,再由 host bridge 做参数规整、执行控制、日志记录和结构化错误转换。

    | 顶层语义函数 | 内部 method | 职责 |
    |--------------|-------------|------|
    | `reply(message)` | `chat.say` | 任务开始或中途对用户说话 |
    | `report(task)` | `system.reportGoal` | 提交 `runGoal` 结果；最终用户话术由 TaskResultReporter 处理 |
    | `runGoal(name, action)` | 沙箱内控制流 | 聚合动作结果、ensure 结果和失败事实 |
    | `ensure(action, condition)` | `system.captureConditionState` / `system.evaluateCondition` / `system.tryHostCall` | 执行动作前记录 baseline,动作后读取真实状态,不满足则按结构化失败恢复并复查 |
    | `mine(blockName, count)` | `bot.mine` | 挖掘并 collect 掉落物；成功必须有真实掉落/背包增量证明 |
    | `cutTree(count)` | `bot.cutTree` | 消费 ResourceService 树木簇,触发服务端连锁砍树并 collect；成功看原木增量 |
    | `craft(itemName, count)` | `bot.craft` | 根据 runtime / minecraft-data / Mineflayer 事实合成,不负责采集材料或放置工作台 |
    | `place("crafting_table")` | `bot.place` | 只放置背包已有工作台；缺物品时返回结构化失败,由 ensure 恢复 |
    | `equip(itemName, destination?)` | `bot.equip` | 装备指定物品,返回装备证明 |
    | `collect(itemName, radius?)` | `bot.collect` | 收集附近掉落物,返回收集证明 |
    | `goTo(x, y, z)` | `bot.goTo` | 移动到目标位置,返回 reached（到达）证明 |
    | `search(query)` | `memory.search` | 只读 RAG 检索；按对话/规划策略决定是否可用 |
    | `sleep(ms)` | `system.sleep` | 受限等待,单次有上限 |
    | `owner` | bootstrap 注入只读对象 | 主人上下文快照,不得写入 |

    ### 4.3 完成证明与条件检查

    沙箱不把“调用没抛错”当成成功。动作返回值必须被 `semantic-action-result`（语义动作结果规范化） 检查：

    - `mine` 必须带 `collected_count`、`collected_item_name` 等掉落/背包证明；数量不足返回 `condition_not_met`,缺证明返回 `unknown_completion`。
    - `cutTree` 必须带 `collected_count` 与簇级完成证明；不能从请求数量默认推断成功。
    - `craft` / `place` / `equip` / `goTo` 分别需要合成数量、放置方块、装备物品、到达状态证明。
    - `until.gained(item, n)` 基于 ensure 开始前后的背包差量；`until.has(item, n)` 基于当前总量；`until.gainedDropOf(block, n)` 由 runtime facts 解析掉落关系,不得让 LLM 背 Minecraft 掉落事实。

    `ensure(action, condition)` 的完整语义是：执行前读取 baseline → 执行动作 → 读取 current → 检查 condition → 不满足则按结构化失败恢复 → 再检查 → 仍不满足则输出结构化失败。恢复逻辑只补局部前置,例如缺工具、缺工作台、缺材料,不得变成隐藏的一键 demo 脚本。

    ### 4.4 只读能力与上下文

    沙箱只读能力也必须走窄入口：

    - `search` 只触发记忆/RAG 检索,不能执行世界动作。
    - `owner` 是注入时冻结的只读上下文；需要实时世界状态时必须通过 runtime / observation / ResourceService 的受控端口读取,不得在沙箱或 prompt 中拼接 `world_key`。
    - `system.captureConditionState` 与 `system.evaluateCondition` 只服务 ensure 条件检查,由宿主端读取背包、装备、世界事实和掉落/tag 解析。

    未实现能力不得注入语义 API 伪装可用；实现前必须返回结构化 unsupported failure（不支持失败） 或不出现在当前 prompt（提示词） 可用方法中。

    ---

    ## 5. 语义 API 注入与 host bridge

    ### 5.1 isolated-vm 的 Reference 回调模型

    isolated-vm 的核心通信原语是 `Reference`：一个跨 Isolate 的函数指针。沙箱内调用 Reference 时，实际执行发生在宿主进程。

    ```typescript
    import ivm from 'isolated-vm'

    function createSandboxContext(
      isolate: ivm.Isolate,
      hostBridge: SandboxHostExecutionAdapter,
      readBridge: SandboxHostReadAdapter,
      job: ExecJob
    ): ivm.Context {
      const context = isolate.createContextSync()
      const jail = context.global

      jail.setSync('__sandboxHostCall', new ivm.Reference(hostBridge.call))
      jail.setSync('__sandboxHostRead', new ivm.Reference(readBridge.call))

      // bootstrap 脚本只把顶层语义函数挂到 globalThis,
      // 随后删除 __sandboxHostCall / __sandboxHostRead,避免 Plan TS 绕过语义层。
      context.evalSync(createSandboxBootstrapScript(job))
      return context
    }
    ```

    ### 5.2 异步方法的跨 Isolate 桥接

    沙箱语义函数通过 `Reference.apply(..., { result: { promise: true, copy: true } })` 等待宿主侧 Promise。Plan TS 只能看到 `mine(...)`、`reply(...)`、`ensure(...)` 等顶层函数；`__sandboxHostCall` 与 `__sandboxHostRead` 是 bootstrap 内部闭包引用,注入完成后从 `globalThis` 删除。

    ```typescript
    const __sandboxCall = (method, args) =>
      __sandboxHostCallRef.apply(undefined, [method, args], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      })

    const mine = (...args) => __semanticCall("bot.mine", args)
    const reply = (message) => __sandboxCall("chat.say", [message])
    const search = (...args) => __sandboxRead("memory.search", args)
    ```

    **关键约束**：每个 host bridge 写动作都必须接入 BotActor 的执行控制与 AbortSignal。中断已发生时，必须立即失败并保留结构化中断/失败原因，不执行任何新的 Mineflayer 操作。

    ### 5.3 host bridge：沙箱到 BotActor 的唯一写通道

    所有写动作最终汇聚到 `SandboxHostExecutionAdapter`（沙箱宿主执行适配器）：

    ```typescript
    interface SandboxHostExecutionAdapter {
      executeSkill<TName extends SkillName>(
        skill: TName,
        params: SkillParamsByName[TName],
        control: SandboxHostCallControl,
      ): Promise<Record<string, unknown>>

      executeToolchainCapability<TName extends ToolchainCapabilityName>(
        capability: TName,
        params: ToolchainCapabilityParamsByName[TName],
        control: SandboxHostCallControl,
      ): Promise<Record<string, unknown>>

      writeChat(
        action: "say" | "report",
        params: Record<string, unknown>,
        control: SandboxHostCallControl,
      ): Promise<Record<string, unknown>>
    }
    ```

    这保证了：
    - **单写者**：所有写操作都经过 BotActor
    - **signal 穿透**：中断信号一路到底
    - **统一日志**：每次 host call 都被记录为 step result 与 sandbox JSONL
    - **可审计**：沙箱代码做了什么，BotActor 与 diagnostics 全知道

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
    | host call 调用频率 | 不限制（Phase 1） | 未来可加限流 |

    ### 6.4 防御性校验层级

    ```
    第一层：静态预检（正则扫描禁止模式）
        ↓ 能拦住明显的恶意代码和低级错误
    第二层：esbuild 转译（语法校验）
        ↓ 能拦住 TS 语法错误
    第三层：isolated-vm 隔离（V8 Isolate 物理隔离）
        ↓ 沙箱内根本不存在宿主对象，无法逃逸
    第四层：host bridge 参数校验（每个方法入口校验）
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
    │  │  │  Layer 3: 单个 host call 调用     │   │  │
    │  │  │  每个 skill 自带超时              │   │  │
    │  │  │  如 goTo: 30s, mine: 60s        │   │  │
    │  │  └─────────────────────────────────┘   │  │
    │  └────────────────────────────────────────┘  │
    └─────────────────────────────────────────────┘
    ```

    三层超时的关系：内层超时总是短于外层。单个 host call 超时 → 该调用失败，沙箱代码可以 try/catch 处理。脚本超时 → 整个执行终止。BotActor 总超时 → 强制 abort + dispose isolate。

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
        until.gainedDropOf("stone", 5),
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
	      until.gainedDropOf("diamond_ore", 10),
	    )
	    } catch (e) {
	    await reply("附近暂时没找到钻石矿，我先换一个可行目标喵")
	    await ensure(
	      async () => {
	        await mine("iron_ore", 10)
	      },
	      until.gainedDropOf("iron_ore", 10),
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

    沙箱内的代码不需要显式 yield。每次语义函数经 host bridge 调用完成后，沙箱执行器自动收集一个 StepResult。

    从 BotActor 的角度看，沙箱执行的步骤流就是一连串受控 host call：

    ```
    TS 代码:   await goTo(100, 64, 200)
    host bridge: bot.goTo({x:100,y:64,z:200}) → StepResult #0

    TS 代码:   await mine('stone', 5)
    host bridge: bot.mine({blockName:'stone',count:5}) → StepResult #1

    TS 代码:   await report(task)
    host bridge: system.reportGoal({task}) → StepResult #2
    ```

    ### 9.2 StepResult 与事件流的关系

    每个 StepResult 对应一个 `step.progress` 事件，写入 event_log 并通过 Socket.io 广播：

    ```typescript
    // BotActor / sandbox 执行器内部
    private onHostCallCompleted(result: StepResult): void {
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

    `search`、`sleep`、`system.captureConditionState`、`system.evaluateCondition` 等只读 host read 不是"步骤"，不产出 StepResult，不写入 event_log。它们是沙箱代码的信息获取或条件检查操作，不是 Bot 的物理动作。

    只有 `bot.*`、`chat.say` 与 `system.reportGoal` 这类写动作才产出 StepResult。

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

    代码任务统一经过静态预检、esbuild（构建转译器） 转译、isolated-vm（V8 隔离沙箱） 执行、host bridge 审批和 BotActor（机器人执行代理） 单写者动作入口。不得恢复 ConversationWorker（对话工作线程） 直接指定 skill（技能） 名与参数的在线快路径。

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
    2. 在语义 API（应用程序接口） 与 host bridge 中暴露最小函数。
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
    | `FacadeCallError` | host bridge 写动作执行失败（找不到路、挖不到矿等；类型名沿用历史实现） | 抛给沙箱代码的 catch，沙箱可处理 |
    | `AbortError` | 中断信号到达 | 沙箱执行终止，emit task.interrupted |
    | `UnhandledError` | 沙箱代码未捕获的 JS 运行时异常 | emit task.failed |

    TS（TypeScript） 代码任务终态由 BotWorker（机器人工作线程） 统一进入 `TaskResultReporter`（任务结果汇报器）。成功、失败、中断都必须生成一次结构化 `result_summary`（结果摘要）。`report(task)`（汇报任务） 的职责是提交 `runGoal`（目标运行） 产生的结构化 GoalResult（目标结果），不是让沙箱代码直接拼最终聊天文案；真正对外发送的终态文本由 `TaskResultReporter`（任务结果汇报器） 基于 `result_summary`（结果摘要） 生成。启用 `ReportLLM`（汇报大语言模型） 时，它只能在终态事实基础上润色表达，不能改事实、数量、世界、耗时、失败码、中断原因或完成状态；润色失败时必须回退到确定性模板。不得让代码任务失败沉默。

    ### 12.2 错误信息的传递

    所有错误信息都记录在 event_log 和 JSONL 中。`FacadeCallError` 是当前实现里 host call error 的历史类型名，必须额外携带结构化失败原因：

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

    - **skills/ 与 core-ports/skills**：底层动作能力只能依赖第 4.2 节语义函数到 host bridge 的映射,不得恢复旧在线命名空间执行面
    - **CONVERSATION_SPEC.md**：依赖第 8 节 LLM 代码生成约束、第 4 节顶层语义 API 与内部 host bridge 契约（用于构造 system prompt）
    - **DATA_SPEC.md**：依赖第 11 节 JSONL 日志格式

    ---

    v0.2 完毕。你审一遍，没问题就继续下一个文档。
