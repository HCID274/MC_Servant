# RUNTIME_SPEC.md — BotActor 运行时规格

> v0.1 | 2026.04 | 依赖 ARCHITECTURE.md v0.2

---

## 0. 本文档的职责边界

本文档定义 BotActor 的完整行为规格：状态机、中断协议、反射系统、任务执行流、Worker 生命周期。

**本文档不涉及**：沙箱内部实现（见 SANDBOX_SPEC.md）、Facade API 签名（见 SANDBOX_SPEC.md）、具体 skill 行为契约（见 SKILL_CATALOG.md）、LLM 调用与 conversation 逻辑（见 CONVERSATION_SPEC.md）。

---

## 1. BotActor 核心定位

BotActor 是整个系统中**唯一拥有 Bot 写操作权力的对象**。它不是一个"执行器"——它是 Bot 在 TS Core 中的法定代理人。

### 1.1 BotActor 拥有的能力

- 驱动 Mineflayer 执行物理动作（移动、挖掘、攻击、装备）
- 创建和销毁 AbortController
- 执行脊髓反射动作
- 读取 observation 缓存（只读）
- 向 event_log 写入状态变化事件

### 1.2 BotActor 不拥有的能力

- 不调用 LLM（这是 ConversationWorker 和 BrainWorker 的事）
- 不决定"下一步做什么"（这是 ConversationWorker 的规划产出）
- 不主动向用户发消息（它只产出事件，由 interfaces 层的 Socket.io 负责广播）
- 不管理队列（BullMQ Worker 壳负责取 job，BotActor 只执行）

### 1.3 单实例约束

Phase 1 一主一 Bot，系统内只有**一个** BotActor 实例。它在进程启动时创建，进程退出时销毁。不存在动态创建/销毁 BotActor 的场景。

未来一机多 Bot（Phase 2）时，每个 Bot 对应一个独立的 BotActor 实例，各自持有独立的状态机、AbortController、Mineflayer 连接。彼此之间零交互。

---

## 2. 状态机完整定义

### 2.1 状态枚举

```typescript
enum BotActorState {
  INITIALIZING = 'initializing',  // Mineflayer 连接中、外部认证流程处理中
  IDLE         = 'idle',          // 等待任务
  EXECUTING    = 'executing',     // 正在执行沙箱代码或 skill
  REFLEXING    = 'reflexing',     // 正在执行脊髓反射动作
  DEAD         = 'dead',          // Bot 游戏内死亡，等待重生
  SHUTDOWN     = 'shutdown',      // 进程正在关闭
}
```

### 2.2 状态转换图

```
                          进程启动
                            │
                            ▼
                    ┌───────────────┐
                    │ INITIALIZING  │
                    │ Mineflayer连接 │
                    │ 外部认证流程  │
                    └───────┬───────┘
                            │ 连接成功 + 认证完成
                            │ [emit: bot.ready]
                            ▼
              ┌────────────────────────────┐
              │                            │
              │           IDLE             │◄──────────────────┐
              │   等待 exec 队列下一个 job  │                   │
              │                            │                   │
              └─────────┬──────────────────┘                   │
                        │                                      │
                        │ 取出 job                              │
                        │ epoch 校验通过                         │
                        │ snapshot 校验通过                      │
                        │ [emit: task.started]                  │
                        ▼                                      │
              ┌──────────────────┐                             │
              │    EXECUTING     │                             │
              │ AbortController  │                             │
              │ 已创建并激活      │                             │
              └────┬─────┬───┬──┘                             │
                   │     │   │                                 │
          ┌────────┘     │   └────────┐                        │
          ▼              ▼            ▼                        │
       正常完成       中断信号       执行异常                    │
          │              │            │                        │
          │              │            │ [emit: task.failed]     │
          │              │            ├────────────────────────►│
          │              │            │                         │
          │              ▼            │                         │
          │     需要反射？             │                         │
          │     ┌───┴───┐            │                         │
          │     ▼       ▼            │                         │
          │    是      否            │                         │
          │     │       │            │                         │
          │     ▼       │            │                         │
          │  ┌──────┐   │            │                         │
          │  │REFLEX│   │            │                         │
          │  │ING   │   │            │                         │
          │  └──┬───┘   │            │                         │
          │     │       │            │                         │
          │     │ 反射完成│            │                         │
          │     │[emit:  │            │                         │
          │     │reflex. │            │                         │
          │     │done]   │            │                         │
          │     │       │ [emit:      │                         │
          │     │       │ task.       │                         │
          │     │       │interrupted] │                         │
          │     ▼       ▼            │                         │
          │     └───┬───┘            │                         │
          │         │                │                         │
          │ [emit:  │                │                         │
          │ task.   │                │                         │
          │completed│                │                         │
          │]        │                │                         │
          └─────────┴────────────────┘─────────────────────────┘

                特殊转换（任何状态均可触发）：

                Bot 游戏内死亡
                    │
                    ▼
              ┌──────────┐
              │   DEAD   │
              │ 等待重生  │
              └────┬─────┘
                   │ 重生完成
                   │ [emit: bot.respawned]
                   ▼
                 IDLE

                进程收到 SIGTERM/SIGINT
                    │
                    ▼
              ┌──────────┐
              │ SHUTDOWN  │
              │ 清理资源   │
              │ 断开连接   │
              └──────────┘
```

### 2.3 转换规则详表

| 起始状态 | 触发条件 | 目标状态 | 守卫条件 | 副作用 |
|---------|---------|---------|---------|--------|
| INITIALIZING | Mineflayer 连接成功 + 外部认证完成 | IDLE | — | emit `bot.ready` |
| INITIALIZING | 连接失败 / 超时 | INITIALIZING | 重试次数 < 3 | 等待 5s 重试 |
| INITIALIZING | 重试耗尽 | SHUTDOWN | — | 记录 fatal 错误，进程退出由 Docker 重启 |
| IDLE | exec 队列取出 job | EXECUTING | epoch ≥ 当前 epoch 且 snapshot 校验通过 | 创建 AbortController，emit `task.started` |
| IDLE | exec 队列取出 job | IDLE | epoch < 当前 epoch | 丢弃 job，emit `task.discarded`，继续取下一个 |
| IDLE | exec 队列取出 job | IDLE | snapshot 过期且环境显著变化 | 丢弃 job，推入 brain 队列触发重规划 |
| EXECUTING | 所有步骤完成 | IDLE | — | emit `task.completed` |
| EXECUTING | 步骤异常 | IDLE | — | emit `task.failed`，推入 brain 队列评估 |
| EXECUTING | 中断信号（control / 新意图覆盖） | IDLE | — | abort()，emit `task.interrupted` |
| EXECUTING | 中断信号（反射触发） | REFLEXING | — | abort()，emit `task.interrupted` + `reflex.triggered` |
| REFLEXING | 反射动作完成 | IDLE | — | emit `reflex.done` |
| 任何状态 | Bot 游戏内死亡 | DEAD | — | abort() if EXECUTING，emit `bot.died` |
| DEAD | 重生完成 | IDLE | — | emit `bot.respawned`，observation 刷新快照 |
| 任何状态 | SIGTERM / SIGINT | SHUTDOWN | — | abort() if EXECUTING，断开 Mineflayer，清理资源 |

### 2.4 状态转换的原子性保证

BotActor 内部使用一个简单的互斥标志（不是锁——单线程 Node.js 不需要锁），确保状态转换在同一个 microtask 内完成。在状态转换过程中到达的中断信号会被排队，等转换完成后处理。

```typescript
class BotActor {
  private state: BotActorState = BotActorState.INITIALIZING
  private transitioning = false
  private pendingInterrupts: InterruptSignal[] = []

  private transition(to: BotActorState, event: EventPayload): void {
    if (this.transitioning) {
      throw new Error(`Reentrant transition: ${this.state} → ${to}`)
    }
    this.transitioning = true
    const from = this.state
    this.state = to
    this.emitEvent({ type: 'state.transition', from, to, ...event })
    this.transitioning = false
    this.drainPendingInterrupts()
  }
}
```

---

## 3. 中断协议详细规格

### 3.1 InterruptSignal 类型定义

```typescript
interface InterruptSignal {
  source: InterruptSource
  reason: string
  payload?: Record<string, unknown>
}

type InterruptSource =
  | { type: 'control'; command: 'interrupt' | 'cancel' }
  | { type: 'reflex'; threat: ThreatAssessment }
  | { type: 'triage'; intent_epoch: number }
  | { type: 'system'; cause: 'death' | 'shutdown' | 'stalled' }
```

### 3.2 中断处理流程

```
InterruptSignal 到达 botActor.interrupt(signal)
    │
    ├─ 当前状态是 IDLE？
    │   → 忽略（无需中断，Bot 没在做任何事）
    │   → 但如果 signal.source.type === 'reflex'，直接进入 REFLEXING 执行反射
    │
    ├─ 当前状态是 REFLEXING？
    │   → 排队（反射是原子操作，不可被打断，信号等反射完成后处理）
    │
    ├─ 当前状态是 EXECUTING？
    │   → 执行中断序列（见 3.3）
    │
    ├─ 当前状态是 INITIALIZING？
    │   → 排队（连接建立中，等进入 IDLE 后处理）
    │
    └─ 当前状态是 DEAD 或 SHUTDOWN？
        → 忽略
```

### 3.3 死亡事件：独立处理路径

Bot 游戏内死亡不走通用中断路径，而是走独立的死亡处理路径。死亡事件的优先级高于一切中断信号。

```
Mineflayer 'death' 事件到达
    │
    ├─ 当前状态是 EXECUTING？
    │   → abort() 当前 AbortController
    │   → 等待沙箱返回（最多 500ms，同 3.4 的清理超时）
    │   → emit task.interrupted { reason: 'bot_death' }
    │   → transition(DEAD)
    │   → emit bot.died { cause, killer, position }
    │
    ├─ 当前状态是 REFLEXING？
    │   → 强制停止反射动作（反射已无意义，Bot 已经死了）
    │   → transition(DEAD)
    │   → emit bot.died
    │
    ├─ 当前状态是 IDLE？
    │   → transition(DEAD)
    │   → emit bot.died
    │
    └─ 其他状态？
        → transition(DEAD)
        → emit bot.died

DEAD 状态下：
    - 清空 pendingInterrupts 队列（死亡后所有中断信号失去意义）
    - 等待 Mineflayer 'spawn' / 'respawn' 事件
    - 重生后：observation 刷新快照 → transition(IDLE) → emit bot.respawned
```

**死亡 vs 中断的本质区别**：中断是"停下手里的活"，Bot 仍然活着。死亡是"游戏实体不存在了"，所有进行中的物理操作已经从服务端失效，不需要也不可能做优雅中止——只需记录事件、清理状态、等待重生。

### 3.4 EXECUTING 状态的中断序列

```
1. this.currentAbortController.abort(signal)
       │
       │  沙箱内所有 await 点收到 AbortError
       │  AsyncGenerator 的 for-await 循环退出
       │  Mineflayer 动作被取消（pathfinder.stop() 等）
       │
2. 等待沙箱执行函数返回（try/catch/finally 清理完成）
       │
       │  超时保护：如果 500ms 内沙箱未返回，
       │  强制终止 isolate（isolate.dispose()）
       │
3. 记录被中断任务的最终状态
       │  emit task.interrupted { reason, last_step, signal }
       │
4. 判断是否需要反射
       │
       ├─ signal.source.type === 'reflex'
       │   → transition(REFLEXING)
       │   → 执行反射动作（见第 4 节）
       │   → 反射完成 → transition(IDLE)
       │
       └─ 其他来源
           → transition(IDLE)
           → 继续从 exec 队列取下一个 job
```

### 3.4 AbortController 生命周期

每个任务独占一个 AbortController，生命周期与任务执行严格绑定：

```
task 取出 → new AbortController() → signal 穿入沙箱
                                        │
                              执行中：signal.throwIfAborted() 每步检查
                                        │
                              完成 or 中断 or 异常
                                        │
                              AbortController 置 null
                                        │
                              下一个 task → new AbortController()
```

**约束**：任意时刻 BotActor 最多持有**一个** AbortController。IDLE 状态下 AbortController 为 null。如果在 AbortController 为 null 时收到中断信号，说明没有正在执行的任务，无需 abort。

### 3.5 signal 穿透深度

AbortSignal 必须一路穿透到 Mineflayer 的实际 I/O 操作，不能在中间某层被吞掉：

```
BotActor.executeTask(job, signal)
  └─ sandbox.run(code, facadeAPI, signal)
       └─ facadeAPI.bot.mine(target, count, signal)
            └─ skill/mine.execute(target, count, signal)
                 └─ mineflayer.bot.dig(block, signal)
                      └─ pathfinder.goto(goal, { signal })
```

每一层的函数签名都必须接受 `signal: AbortSignal` 参数。这是强制约定，SKILL_CATALOG.md 中所有 skill 的签名都将包含此参数。

---

## 4. 脊髓反射系统

### 4.1 系统架构

```
observation 模块                         BotActor
─────────────                           ──────────
Mineflayer 事件 ──┐
                  ├─► ThreatDetector ──► botActor.interrupt({
JAR Bridge 推送 ──┘    (纯函数)            source: { type: 'reflex', threat },
                       无副作用             reason: '4 zombies within 16 blocks'
                       无 Bot 写操作       })
```

**ThreatDetector 是一个纯函数**，输入是 observation 缓存快照的子集，输出是 `ThreatAssessment | null`。它不持有状态，不订阅事件（事件由 observation 模块的监听器触发后调用它），不操作 Bot。

### 4.2 ThreatAssessment 类型

```typescript
interface ThreatAssessment {
  level: 'flee' | 'fight' | 'emergency'
  action: ReflexAction
  entities?: Entity[]
  reason: string
}

type ReflexAction =
  | { type: 'flee'; direction: Vec3 }
  | { type: 'fight'; target: Entity }
  | { type: 'eat'; item: string }
  | { type: 'seek_water'; nearest: Vec3 | null }
  | { type: 'no_op'; reason: string }
```

### 4.3 反射规则表

规则按优先级从高到低排列。**第一条命中的规则生效，后续规则不再评估。**

```typescript
interface ReflexRule {
  id: string
  priority: number          // 数字越小优先级越高
  condition: (snapshot: ThreatSnapshot) => boolean
  assess: (snapshot: ThreatSnapshot) => ThreatAssessment
  cooldown_ms: number       // 同一规则连续触发的最小间隔
}
```

**Phase 1 规则表：**

| id | priority | 条件 | 动作 | cooldown |
|----|----------|------|------|----------|
| `fall_protect` | 10 | Y 轴速度 < -10 | no_op（不干扰物理引擎） | 0ms |
| `critical_hp` | 20 | 生命值 < 4 | eat（背包中最优食物）或 flee | 5000ms |
| `on_fire` | 30 | 自身着火 | seek_water 或 no_op | 3000ms |
| `mob_swarm` | 40 | 敌对生物 ≥ 4，距离 < 16 | flee（远离质心方向） | 2000ms |
| `mob_solo_armed` | 50 | 敌对 1-3，距离 < 16，持有武器 | fight（最近目标） | 1000ms |
| `mob_solo_unarmed` | 60 | 敌对 1-3，距离 < 16，无武器 | flee | 2000ms |

### 4.4 cooldown 机制

反射规则需要 cooldown，否则每个 game tick 都会触发中断，Bot 在"逃跑→重取任务→逃跑"的循环里抽搐。

```typescript
class ReflexCooldownTracker {
  private lastTriggered: Map<string, number> = new Map()

  canTrigger(ruleId: string, cooldown_ms: number): boolean {
    const last = this.lastTriggered.get(ruleId) ?? 0
    return Date.now() - last >= cooldown_ms
  }

  markTriggered(ruleId: string): void {
    this.lastTriggered.set(ruleId, Date.now())
  }
}
```

### 4.5 反射动作执行

反射动作由 BotActor 在 REFLEXING 状态下执行。反射动作**不经过沙箱**，不经过队列，直接调用 Mineflayer API。

```typescript
class BotActor {
  private async executeReflex(assessment: ThreatAssessment): Promise<void> {
    this.transition(BotActorState.REFLEXING, { assessment })

    switch (assessment.action.type) {
      case 'flee':
        await this.mineflayer.navigate(assessment.action.direction, {
          sprint: true,
          timeout: 3000,  // 反射动作硬超时 3 秒
        })
        break
      case 'fight':
        await this.mineflayer.attack(assessment.action.target, {
          timeout: 5000,
        })
        break
      case 'eat':
        await this.mineflayer.eat(assessment.action.item, {
          timeout: 3000,
        })
        break
      case 'seek_water':
        if (assessment.action.nearest) {
          await this.mineflayer.navigate(assessment.action.nearest, {
            sprint: true,
            timeout: 5000,
          })
        }
        break
      case 'no_op':
        break
    }

    this.transition(BotActorState.IDLE, { reflex_done: assessment.action.type })
  }
}
```

**反射动作的硬超时**：每个反射动作有独立的超时时间（3-5 秒级别）。超时后强制停止，回到 IDLE。反射动作不能变成一个长时间占用 Bot 的操作——它的目的是保命，不是解决问题。

### 4.6 反射规则的扩展策略

Phase 1 的规则表是硬编码的。扩展路径：

1. **Phase 1**：规则定义在 `runtime/reflex/rules.ts` 中，代码级修改
2. **Phase 2**：规则表改为 JSON/YAML 配置文件，热加载，无需重启进程
3. **Phase 3（远期）**：BrainWorker 基于历史战斗数据，动态调整规则的阈值参数（如"几只怪算需要逃跑"从硬编码 4 变成动态值）

无论哪个阶段，**规则的执行引擎不变**：纯函数评估 + BotActor 独占执行。变的只是规则数据的来源。

---

## 5. 任务执行流

### 5.1 BotWorker 与 BotActor 的关系

BotWorker 是 BullMQ Worker 的壳。它的唯一职责是从 `bot:{botId}:exec` 队列取 job，交给 BotActor 执行，然后汇报结果。BotWorker 本身不持有任何业务状态。

任务终态汇报由 `TaskResultReporter`（任务结果汇报器） 完成：它只消费 BotWorker 产出的 `task.completed` / `task.failed` / `task.interrupted` 终态任务卡，按模板生成一次性自然语言结果，并同步写入 game chat（游戏聊天） 与 realtime（实时推送） `chat.reply`。BotActor 仍只负责执行与产出事件，不决定终态文案；汇报器按 `bot_id + message_id + status` 去重，避免重复刷屏。

```typescript
// workers/bot-worker.ts
const botWorker = new Worker(`bot:${botId}:exec`, async (job) => {
  await botActor.executeTask(job)
}, {
  connection: redis,
  concurrency: 1,           // 严格串行
  stalledInterval: 30_000,  // 30 秒心跳
  maxStalledCount: 0,       // stalled 直接 fail
})
```

### 5.2 任务执行主流程

```
BotWorker 取出 job
    │
    ▼
╔══════════════════════════════════════╗
║  BotActor.executeTask(job)           ║
╠══════════════════════════════════════╣
║                                      ║
║  1. 前置校验                          ║
║     ├─ epoch 校验                     ║
║     │   job.epoch < 当前 epoch?       ║
║     │   → 丢弃, emit task.discarded  ║
║     │                                ║
║     ├─ snapshot 校验                  ║
║     │   now() - job.snapshot_ts > 30s?║
║     │   → observation 刷新快照        ║
║     │   → 关键字段显著变化?            ║
║     │     → 丢弃, 推 brain 队列重规划  ║
║     │                                ║
║     └─ 状态校验                       ║
║         当前状态 !== IDLE?            ║
║         → 异常（不应该发生）           ║
║                                      ║
║  2. 准备执行环境                      ║
║     ├─ 创建 AbortController           ║
║     ├─ transition(EXECUTING)          ║
║     ├─ emit task.started              ║
║     └─ 构造 Facade API 实例           ║
║         （注入 signal + mineflayer）   ║
║                                      ║
║  3. 判定执行路径                      ║
║     ├─ job.type === 'skill_call'?     ║
║     │   → 直接调用 skill 函数         ║
║     │                                ║
║     └─ job.type === 'sandbox_code'?   ║
║         → esbuild 转译               ║
║         → isolated-vm 执行            ║
║                                      ║
║  4. 执行循环（AsyncGenerator）        ║
║     for await (const result of gen) { ║
║       emit step.progress              ║
║       job.updateProgress(...)         ║
║     }                                ║
║                                      ║
║  5. 执行完成                          ║
║     ├─ AbortController 置 null        ║
║     ├─ transition(IDLE)               ║
║     ├─ emit task.completed            ║
║     └─ 推入 brain 队列（摘要压缩）    ║
║                                      ║
╚══════════════════════════════════════╝
```

### 5.3 两种 Job 类型

ConversationWorker 产出的 job 分两种，BotActor 根据 `job.type` 走不同执行路径：

```typescript
type ExecJob =
  | {
      type: 'skill_call'
      skill: string            // 'goTo' | 'mine' | 'follow' | ...
      params: Record<string, unknown>
      intent_epoch: number
      snapshot_ts: number
      message_id: string
    }
  | {
      type: 'sandbox_code'
      code: string             // LLM 生成的 TS 代码
      intent_epoch: number
      snapshot_ts: number
      message_id: string
    }
```

**skill_call**：快路径产出，或 ConversationWorker 判断意图可直接映射到已注册 skill 时产出。BotActor 直接调用 skill 函数，不经过沙箱。

**sandbox_code**：LLM 生成的 TS 代码片段。BotActor 通过 isolated-vm 在沙箱中执行。

两种路径最终都通过 AsyncGenerator yield 步骤结果，从 BotActor 的角度看行为一致。

### 5.4 AsyncGenerator 执行模型

无论是 skill 还是沙箱代码，执行过程统一封装为 AsyncGenerator：

```typescript
interface StepResult {
  step_index: number
  action: string
  target?: string
  status: 'success' | 'partial' | 'error'
  detail: Record<string, unknown>
  timestamp: number
}

// skill 路径
async function* executeSkill(
  skill: SkillFunction,
  params: Record<string, unknown>,
  signal: AbortSignal
): AsyncGenerator<StepResult> {
  yield* skill(params, signal)
}

// 沙箱路径
async function* executeSandbox(
  code: string,
  facadeAPI: FacadeAPI,
  signal: AbortSignal
): AsyncGenerator<StepResult> {
  // esbuild 转译 + isolated-vm 执行
  // 沙箱内每次 Facade API 调用完成后 yield 一个 StepResult
}
```

BotActor 消费 generator：

```typescript
async executeTaskLoop(gen: AsyncGenerator<StepResult>, job: Job): Promise<void> {
  let stepIndex = 0
  try {
    for await (const result of gen) {
      // 1. 写入 event_log
      this.emitEvent({
        type: 'step.progress',
        step_index: stepIndex,
        ...result,
      })

      // 2. 更新 BullMQ job progress
      await job.updateProgress({
        percent: Math.round((stepIndex / (job.data.estimatedSteps ?? 10)) * 100),
        detail: result,
      })

      // 3. 写入 JSONL 日志
      this.diagnostics.appendStep(job.id, result)

      stepIndex++
    }
  } catch (error) {
    if (error instanceof AbortError) {
      // 中断导致的退出，不视为异常
      return
    }
    throw error  // 真正的执行异常，上层捕获后 emit task.failed
  }
}
```

### 5.5 执行超时

每个 job 有一个总超时时间，防止无限执行：

```typescript
const JOB_TIMEOUT_MS = {
  skill_call: 60_000,     // skill 最多 60 秒
  sandbox_code: 120_000,  // 沙箱代码最多 120 秒
}
```

超时通过包装 AbortController 实现：

```typescript
const controller = new AbortController()
const timeoutId = setTimeout(
  () => controller.abort({ type: 'system', cause: 'timeout' }),
  JOB_TIMEOUT_MS[job.data.type]
)

try {
  await this.executeTaskLoop(gen, job)
} finally {
  clearTimeout(timeoutId)
}
```

---

## 6. Worker 生命周期

### 6.1 启动序列

```
进程启动（Docker 容器启动）
    │
    ▼
1. 加载配置（环境变量、data/ 目录配置文件）
    │
2. 连接 Redis
    │
3. 连接 PostgreSQL
    │
4. 创建 BotActor（进入 INITIALIZING）
    │  BotActor 内部：
    │  ├─ 创建 Mineflayer Bot 实例
    │  ├─ 连接 MC Server
    │  ├─ 等待 spawn 事件
    │  ├─ 执行外部认证流程（如需要，通过聊天命令、服务端桥接或其他受控入口）
    │  └─ 初始化 observation 模块（开始监听事件、采集首次快照）
    │
5. BotActor 进入 IDLE
    │
6. 启动三个 BullMQ Worker：
    │  ├─ ConversationWorker（消费 msg:{botId}）
    │  ├─ BotWorker（消费 bot:{botId}:exec）
    │  └─ BrainWorker（消费 brain）
    │
7. 启动 Socket.io 服务
    │
8. 启动 Fastify 服务
    │
9. emit bot.ready → Socket.io 广播
    │
10. 系统就绪，等待用户消息
```

### 6.2 关闭序列

```
收到 SIGTERM / SIGINT
    │
    ▼
1. BotActor.interrupt({ source: { type: 'system', cause: 'shutdown' } })
    │  如果正在执行任务，等待 abort 完成（最多 1 秒）
    │
2. BotActor transition(SHUTDOWN)
    │
3. 关闭三个 BullMQ Worker（停止接收新 job，等待当前处理完成）
    │
4. 关闭 Fastify 服务（停止接收新请求，等待进行中请求完成）
    │
5. 关闭 Socket.io（广播 bot.offline，断开所有连接）
    │
6. 断开 Mineflayer 连接
    │
7. 关闭 Redis 连接
    │
8. 关闭 PostgreSQL 连接池
    │
9. process.exit(0)
```

### 6.3 崩溃恢复序列

```
进程崩溃（OOM / 未捕获异常 / isolated-vm 灾难性错误）
    │
    ▼
Docker 检测到容器退出
    │ 等待 2 秒
    ▼
重新执行启动序列（6.1）
    │
    ▼
特殊处理：
    │
    ├─ BullMQ stalled 检测自动将崩溃时正在执行的 job 标记为 failed
    │  （stalledInterval: 30s, maxStalledCount: 0）
    │
    ├─ event_log 中可能有一条 task.started 没有对应的 completed/failed/interrupted
    │  → 启动时扫描：SELECT ... WHERE type = 'task.started'
    │     AND NOT EXISTS (SELECT ... WHERE type IN ('task.completed', 'task.failed', 'task.interrupted'))
    │  → 补写一条 task.failed { reason: 'process_crash_recovery' }
    │
    └─ observation 重新采集完整快照
       BotActor 进入 IDLE，从干净状态开始
```

---

## 7. intent_epoch 运行时行为

### 7.1 epoch 存储

```typescript
// Redis key
const EPOCH_KEY = `bot:${botId}:intent_epoch`

// 递增（消息入口层调用）
async function incrementEpoch(botId: string): Promise<number> {
  return await redis.incr(`bot:${botId}:intent_epoch`)
}

// 读取当前值（BotActor 校验时调用）
async function getCurrentEpoch(botId: string): Promise<number> {
  return parseInt(await redis.get(`bot:${botId}:intent_epoch`) ?? '0', 10)
}
```

### 7.2 epoch 生命周期

```
用户发消息 "去挖矿"
    │
    ├─ 入口层：epoch = incrementEpoch() → 返回 7
    │
    ├─ 推入 msg 队列（携带 epoch: 7）
    │
    ▼
ConversationWorker 取出消息
    │
    ├─ LLM 意图分析 + 代码生成（耗时 3 秒）
    │
    ├─ 产出 exec job（携带 epoch: 7）
    │
    ▼
推入 exec 队列
    │
    ▼
BotActor 取出 job
    │
    ├─ 读取当前 epoch = getCurrentEpoch() → 返回 ?
    │
    ├─ 如果当前 epoch 仍然是 7 → 校验通过，执行
    │
    └─ 如果当前 epoch 已经是 9（用户在这 3 秒内又发了两条消息）
        → job.epoch(7) < currentEpoch(9) → 丢弃
```

### 7.3 中断指令与 epoch 的关系

control 快路径（"停"、"取消"）**不递增 epoch**。因为 control 不产出新任务，不需要让旧计划过期。control 直接调 `botActor.interrupt()`，效果是中止当前执行，已在队列中的后续任务仍然有效。

只有走 ConversationWorker 的消息才递增 epoch，因为它们可能产出新计划，需要让旧计划过期。

---

## 8. observation 与 BotActor 的交互契约

### 8.1 observation 可以做的事

- 监听 Mineflayer 事件（entitySpawn、blockUpdate、health、food、death 等）
- 监听 JAR Bridge 推送
- 更新内部缓存快照
- 调用 ThreatDetector 纯函数评估威胁
- 向 BotActor 发中断信号：`botActor.interrupt({ source: { type: 'reflex', ... } })`

### 8.2 observation 绝不能做的事

- 调用 Mineflayer 的任何写方法（bot.dig、bot.place、bot.navigate、bot.attack 等）
- 直接向 exec 队列推 job
- 修改 BotActor 的内部状态
- 向用户发消息（它只产出事件，由 interfaces 层广播）

### 8.3 快照采集频率

observation 不做定时轮询。它是**事件驱动**的：

- Mineflayer 事件触发时更新对应缓存字段
- JAR Bridge 推送到达时更新对应缓存字段
- BotActor 在执行前主动调用 `observation.getSnapshot()` 获取当前缓存的快照副本

ThreatDetector 的评估频率与 Mineflayer 的 `physicsTick` 事件绑定（默认每秒 20 次），但通过 cooldown 机制限制实际的中断发送频率。

### 8.4 快照结构（概要）

```typescript
interface EnvironmentSnapshot {
  timestamp: number
  bot: {
    position: Vec3
    health: number
    food: number
    experience: number
    is_on_fire: boolean
    is_in_water: boolean
    y_velocity: number
  }
  inventory: InventorySummary
  equipment: EquipmentSummary
  nearby_entities: EntitySummary[]
  nearby_blocks: BlockSummary[]
  // JAR Bridge 提供的扩展信息（可选）
  server_extended?: {
    global_entity_count: number
    chunk_loaded_count: number
    tps: number
  }
}
```

完整定义在 DATA_SPEC.md 中，此处只列出 runtime 需要的字段概要。

---

## 9. 诊断事件清单

BotActor 在每个状态转换和关键操作点 emit 事件，写入 event_log。

| 事件类型 | 触发时机 | payload 关键字段 |
|---------|---------|----------------|
| `bot.ready` | INITIALIZING → IDLE | `mc_server`, `bot_name` |
| `bot.died` | 任何 → DEAD | `cause`, `killer`, `position` |
| `bot.respawned` | DEAD → IDLE | `position` |
| `bot.offline` | → SHUTDOWN | `reason` |
| `state.transition` | 任何状态转换 | `from`, `to` |
| `task.started` | IDLE → EXECUTING | `job_id`, `type`, `epoch` |
| `task.discarded` | job epoch 过期 | `job_id`, `epoch`, `current_epoch` |
| `step.progress` | 执行中每步完成 | `job_id`, `step_index`, `action`, `status` |
| `task.completed` | 任务正常完成 | `job_id`, `total_steps`, `duration_ms`, `result_summary` |
| `task.failed` | 任务执行失败 | `job_id`, `error`, `last_step`, `result_summary` |
| `task.interrupted` | 任务被中断 | `job_id`, `interrupt_source`, `reason`, `result_summary` |
| `reflex.triggered` | observation 触发反射 | `rule_id`, `threat_level`, `entities` |
| `reflex.done` | 反射动作完成 | `rule_id`, `action_type`, `duration_ms` |
| `intent.epoch_changed` | epoch 递增 | `new_epoch`, `message_id` |

`result_summary`（结果摘要） 必须兼容统一 `SkillResultSummary`（技能结果摘要）：

- 成功：`skill_name`（技能名）、`status: "completed"`、`target`（目标）、`requested_count`（请求数量）、`completed_count`（完成数量）、`inventory_delta`（背包增量）、`world_key`（世界键）、`duration_ms`（耗时）、`diagnostics`（诊断短标签）。
- 失败 / 中断：除上述目标进度字段外，必须携带 `failure`（失败摘要），至少包含 `failure_code`（失败码）、`failure_stage`（失败阶段）、`message`（消息）、`recoverable`（是否可恢复）、`current_position`（当前位置）、`inventory_summary`（背包摘要）、`equipment_summary`（装备摘要）、`target_progress`（目标进度）。
- `operation`（操作名） 是历史兼容字段，语义等价于 `skill_name`；新消费方应优先读取 `skill_name` 与 `failure`，不得按技能私有返回结构猜测终态。
- `world_key` 只能由 currentWorld（当前世界） / ResourceService（资源服务） / runtime transport（运行时传输层） 上游透传，不允许为结果摘要重新解析维度或拼接世界名。
- Failure Capsule（失败胶囊） 只能由执行终态侧基于 `result_summary`（结果摘要） 确定性格式化产生。BotWorker / BotActor（机器人工作线程 / 机器人执行代理） 是执行事实 owner（所有者）；ConversationWorker（对话工作线程） 只能读取并渲染短胶囊,不得补造完整执行事实。

---

## 10. 错误分类

BotActor 执行过程中遇到的错误分三类，处置策略不同：

### 10.1 可观测业务失败

Bot 尝试执行动作但失败了（挖不到矿、找不到路、背包满了）。这不是系统错误，是游戏世界的正常反馈。

- **处置**：emit `task.failed`，错误信息和完整失败详情写入 event_log、diagnostics（诊断） 和 JSONL（结构化日志）。实时继续任务只通过短 Failure Capsule（失败胶囊） 暴露给 Plan（规划）；BrainWorker（大脑工作线程） 只做异步长期档案和经验沉淀。
- **BotActor 状态**：回到 IDLE。

### 10.2 沙箱执行异常

LLM 生成的代码有 bug（类型错误、无限循环被超时杀死、访问未定义变量）。

- **处置**：emit `task.failed`，错误堆栈和 LLM 原始代码写入 JSONL。推入 brain 队列。
- **BotActor 状态**：回到 IDLE。isolated-vm isolate 被 dispose 后重建。
- **不尝试修复代码**：Phase 1 不做"LLM 改 bug 重试"，直接当失败处理。

### 10.3 系统级灾难

进程 OOM、Mineflayer 连接断开、Redis 不可达、PG 不可达。

- **处置**：尽力 emit 错误事件（如果 PG 可达的话）。进程可能崩溃。
- **恢复**：由 Docker 重启容器，走崩溃恢复序列（6.3 节）。

---

## 11. 配置参数速查

所有可配置参数集中列出，Phase 1 使用默认值，通过环境变量覆盖：

| 参数 | 默认值 | 环境变量 | 说明 |
|------|--------|---------|------|
| `SNAPSHOT_STALE_THRESHOLD_MS` | 30000 | `SNAPSHOT_STALE_MS` | snapshot_ts 过期阈值 |
| `SKILL_TIMEOUT_MS` | 60000 | `SKILL_TIMEOUT_MS` | skill_call 执行总超时 |
| `SANDBOX_TIMEOUT_MS` | 120000 | `SANDBOX_TIMEOUT_MS` | sandbox_code 执行总超时 |
| `SANDBOX_MEMORY_LIMIT_MB` | 128 | `SANDBOX_MEM_MB` | isolated-vm 内存上限 |
| `REFLEX_HOSTILE_FLEE_COUNT` | 4 | `REFLEX_FLEE_COUNT` | 触发群体逃跑的敌对生物数量 |
| `REFLEX_HOSTILE_RANGE` | 16 | `REFLEX_RANGE` | 威胁检测半径（格） |
| `REFLEX_CRITICAL_HP` | 4 | `REFLEX_CRIT_HP` | 触发紧急进食/逃跑的生命值 |
| `STALLED_INTERVAL_MS` | 30000 | `STALLED_INTERVAL` | BullMQ stalled 检测间隔 |
| `ABORT_CLEANUP_TIMEOUT_MS` | 500 | `ABORT_CLEANUP_MS` | 中断后等待沙箱清理的最大时间 |
| `MINEFLAYER_RECONNECT_DELAY_MS` | 5000 | `MC_RECONNECT_MS` | Mineflayer 重连间隔 |
| `MINEFLAYER_MAX_RECONNECT` | 3 | `MC_MAX_RECONNECT` | 最大重连次数 |

---

## 12. 后续文档依赖

本文档定义了 BotActor 的完整运行时行为。以下文档依赖本文档：

- **SANDBOX_SPEC.md**：依赖第 3.5 节 signal 穿透约定、第 5.3 节 Job 类型定义、第 5.4 节 AsyncGenerator 模型
- **SKILL_CATALOG.md**：依赖第 3.5 节 signal 签名约定、第 5.3 节 skill_call Job 结构
- **CONVERSATION_SPEC.md**：依赖第 5.3 节 ExecJob 类型定义、第 7 节 epoch 行为

---

v0.1 完毕。你审一遍，没问题就进 SANDBOX_SPEC.md。
