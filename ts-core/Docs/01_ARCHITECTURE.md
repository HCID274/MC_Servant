# ARCHITECTURE.md — TS Core 系统架构设计

> v0.2 | 2026.04 | Phase 1 基线

---

## 0. 项目定位与设计动机

TS Core 是一套以 TypeScript 为唯一执行核心的 Minecraft Bot Agent 系统。它彻底替代旧系统的 Python + JS + Java 三核心架构。

**推倒重建的三个不可调和的矛盾：**

1. **延迟**：Python ↔ JS 跨进程桥接，每个 Bot 动作至少额外 50-200ms IPC 开销。LLM 响应本身已经 3-10 秒，桥接延迟让体验雪上加霜。
2. **臃肿**：Python 进程 + Node.js 进程 + Java MC Server，三个运行时各自占内存，GC 行为不可协调，单机承载上限极低。
3. **并发天花板**：旧系统的 Python GIL + 同步阻塞模型无法抗住多用户并发访问。

**TS 单核心的根本优势**：Node.js 异步非阻塞 I/O 天然适配两类最重的等待——LLM API 网络往返和 Minecraft 游戏包收发。一个进程、一个事件循环、一套类型系统，消灭所有跨语言桥接。

---

## 1. 五条不可破坏的约束

这五条是架构的宪法。任何设计决策如果与之冲突，必须让步。

| # | 约束 | 含义 | 违反后果 |
|---|------|------|----------|
| 1 | **单写者** | 任意时刻只有 BotActor 拥有操作 Bot 的权力。其他模块只能观察、分析、建议、请求中断。 | 并发写入导致 Bot 状态撕裂 |
| 2 | **聊天驱动** | 游戏端与网页端统一通过消息流驱动系统，消息是唯一的用户意图入口。 | 多入口导致意图冲突 |
| 3 | **双端同步** | 网页/游戏消息、Bot 回复、执行进度全量同步广播。 | 两端状态不一致 |
| 4 | **本地执行闭环** | Bot 物理动作在本地完成。禁止"本地 → 云 LLM → 本地执行"的同步阻塞绕路。 | 网络抖动导致 Bot 僵死 |
| 5 | **最小闭环优先** | Phase 1 只做一主一 Bot 与"木头 → 工具链 → 石镐 → 铁矿"Agent 闭环；craft/place/equip/mine 仅按 06_AGENTIC_MINE_IRON_SPEC.md 的最小边界启用。不做通用百科、复杂 UI、多 Bot、多 Owner。 | 范围膨胀 |

---

## 2. 七层技术架构

```
┌─────────────────────────────────────────────────────────┐
│  ⓪ 组合根         src/app/（应用装配，不参与业务执行）   │
├─────────────────────────────────────────────────────────┤
│  ① 运行时基座     Node.js + TypeScript (strict)         │
├─────────────────────────────────────────────────────────┤
│  ② API 网关       Fastify + Zod                         │
├─────────────────────────────────────────────────────────┤
│  ③ 实时推送       Socket.io（仅服务端→客户端推送）       │
├─────────────────────────────────────────────────────────┤
│  ④ 任务队列       Redis + BullMQ（三队列模型）           │
├─────────────────────────────────────────────────────────┤
│  ⑤ 执行核心       BotActor 状态机 + TS 沙箱             │
│                   + Mineflayer                           │
├─────────────────────────────────────────────────────────┤
│  ⑥ Server Bridge  自定义 JAR 插件双通道                  │
├─────────────────────────────────────────────────────────┤
│  ⑦ 持久化         PostgreSQL + Drizzle ORM              │
│                   + pgvector + JSONL 冷存储              │
└─────────────────────────────────────────────────────────┘

横切基础层（不属于上述纵向分层，被多层单向依赖）：
  ▸ src/domain/      共享类型、不变量、只读辅助（与业务流程无关）
  ▸ src/core-ports/  跨模块共享端口契约（打断 runtime ↔ skills/observation/diagnostics/data 循环）
```

**组合根 `src/app/` 与横切层 `src/core-ports/` 的定位（v0.3 修订，2026-04-26 由代码反向审计追认）**：

- `src/app/`（应用装配）不属于七层纵向分层中的任何一层，而是位于纵向分层之上的**组合根**。它的唯一职责是装配 `interfaces` / `workers` / `runtime` / `db` / `data` / `sandbox` / `diagnostics` 的公开契约，集中管理依赖注入、启停顺序与失败逆序清理，不承载任何业务执行逻辑。其他模块**禁止反向依赖** `src/app/`。
- `src/core-ports/`（核心端口层）与 `src/domain/`（领域） 一样，是被多模块单向依赖的**横切基础契约层**：沉淀跨模块共享的端口类型（如 `BotActorRuntimePort`、`SkillName`、`ExecutionTaskKind`、`SandboxBotMethodName` 等），让上层模块面向端口编程而非面向具体实现。`core-ports` 不得反向 import `runtime`（运行时）、`skills`（技能）、`observation`（观测）、`diagnostics`（诊断）、`data`（数据层） 的实现文件。该层于 T-028 引入，用于打断 `runtime` ↔ `skills`/`observation`/`diagnostics`/`data` 间的循环依赖；当前 `pre_review.sh`（评审前预检脚本）经 `madge`（依赖图工具） 守门，全仓零循环。

`src/domain/`（领域） 不属于新的第八个业务执行层，而是跨上述七层复用的**横切基础契约层**：只沉淀核心类型、基础不变量校验、通用只读辅助等与业务流程无关的公共边界。其他模块可以单向依赖 `domain`，但 `domain` 不得反向 import（导入） `runtime`（运行时）、`interfaces`（接口边界）、`app`（应用装配）、`db`（数据库） 等上层实现，从而维持依赖方向清晰与模块解耦。

### 各层选型理由

**① 运行时基座 — Node.js + TypeScript (strict)**

异步非阻塞天然契合 LLM I/O 和游戏包收发。`strict` 模式 + Zod 运行时校验形成双重类型安全网。Mineflayer 是 Node.js 原生库，零桥接。

**② API 网关 — Fastify + Zod**

Fastify 路由性能是 Express 的 3-5 倍。Zod schema 在路由层强制校验请求体，脏数据不进系统。Phase 1 只需三个端点：

- `POST /api/message` — 网页端发消息（入队，返回 202）
- `GET /api/status` — Bot 当前状态（从 Redis 缓存读）
- `GET /api/health` — 健康检查

网关的唯一职责是「接收、校验、入队、立即返回」。绝不在这一层等待任何业务执行结果。

**③ 实时推送 — Socket.io**

Socket.io 提供 Room/Namespace 抽象、自动重连、ACK 机制。严格限定角色：**Socket.io 只做服务端→客户端的推送通道**，不作为消息入口。网页端发消息走 HTTP POST，游戏端消息走 Mineflayer 事件监听。

Socket.io 默认交付语义为 at-most-once。短暂断线（秒级）复用 Socket.io 内建的 connection state recovery（单机内存 adapter 下有效）。长断线走 event_log 补拉（见第 8 节 Event Protocol）。

**④ 任务队列 — Redis + BullMQ**

Redis 的根本任务是消灭并发冲突，将用户并发指令强制拍平为有序单列队伍。BullMQ 自带 Job Priority、Progress、Lifecycle 事件。Redis 仅作为队列引擎和短时缓存，不承担业务持久化。

**⑤ 执行核心 — BotActor + isolated-vm + Mineflayer**

BotActor 是唯一的 Bot 写操作者。LLM 生成的 TS 代码片段经 `esbuild.transform()` 转成 JS（< 1ms），在 `isolated-vm` V8 隔离沙箱中执行。沙箱内代码只能调用顶层语义 API；语义 API 通过 host bridge 向 BotActor 发起受控请求，BotActor 审批并驱动 Mineflayer 执行物理动作。

沙箱安全防线：isolated-vm 设 `memoryLimit: 128`（MB），超限时 isolate 自行终止，不拖进程下水。进程级兜底由 Docker restart policy（`restart: unless-stopped`）守护，崩溃后自动重启。

**⑥ Server Bridge — 自定义 JAR 插件**

TS Core 与 MC Server 之间存在**双通道**信息架构：

```
┌────────────────────────────────────┐
│  MC Java Server                    │
│                                    │
│   ┌──────────────────────┐         │
│   │  自定义 JAR 插件      │◄───────┼── 服务端视角：全局实体、
│   │  (Server-side)       │         │   超视距数据、事件钩子
│   └──────────┬───────────┘         │
│              │ 自定义通信协议       │
│              │ (WebSocket/TCP)     │
├──────────────┼─────────────────────┤
│   Minecraft 协议层                 │
└──────────────┼─────────────────────┘
               │
     ┌─────────┴──────────┐
     │   标准 MC 协议       │
     ▼                     ▼
┌────────────────────────────────────┐
│  TS Core                           │
│                                    │
│   Mineflayer  ← 客户端视角          │
│       +                            │
│   JAR Bridge  ← 服务端视角          │
│       ↓                            │
│   observation 模块融合两路数据      │
└────────────────────────────────────┘
```

- **客户端视角（Mineflayer）**：视距内的方块、实体、自身状态、背包——等价于普通玩家客户端
- **服务端视角（JAR 插件）**：全地图实体位置、超视距方块数据、服务端事件钩子、自定义命令注册、外部认证模组 / 反作弊兼容适配

observation 模块融合两路数据源写入缓存快照。核心约束不变：observation 仍然是纯读、纯写缓存的，不触发任何 Bot 写操作。

#### 2.6.1 Server Bridge 平台与依赖选型（v0.4 修订，2026-04-27 由 T-039 决策追加）

历史上 `plugin/`（服务端插件源码） 以 Paper API（`io.papermc.paper:paper-api`） 为目标，依赖 `commandapi-paper-shade`、`decentholograms`、`authme` 等 Paper / Bukkit 生态库；但当前生产 MC（Minecraft，我的世界） 服务器已全面迁移到 Fabric（模组加载器），跑的是 `fabric-loader` + `fabric-api` + `easyauth`，**Paper 插件无法被 Fabric 服务器加载**。

T-039（任务三十九） 已确认走 **方案 Y（捆绑串行）**：把 `plugin/` 全面重写为 Fabric mod，并与 TS Core（TypeScript 单核心） 端 `server-bridge`（服务端桥接） 通信落地一起在同一批次完成。下表为已锁定的依赖选型，作为未来 T-Fabric-Bridge 系列任务派发的硬约束：

| 需求 | 锁定选型 | 理由 |
|------|---------|------|
| Mod Loader（模组加载器） | **Fabric Loader** 0.15.x+ | Fabric 唯一加载器 |
| 构建插件 | **Fabric Loom**（Gradle 插件） | Fabric 官方构建链；不再使用 Maven |
| 事件 / 生命周期 / 服务端命令 | **Fabric API** `0.97.3+1.20.4` + Brigadier + `fabric-command-api-v2` | 与生产 `mods/` 已装版本对齐；不引入 CommandAPI |
| 外部 WebSocket 客户端（→ TS Core） | **OkHttp** | 当前 mod ↔ TS Core 同机 localhost；选 OkHttp 是为未来跨机部署（如 TS Core 迁出 Fukuoka 主机）保留连接池 / 自动重连 / 网络抖动韧性能力，避免后续返工 |
| JSON | **Gson** | 已在 MC 类路径，零额外依赖；安全口碑显著优于 fastjson2；在握手 / 心跳 / observation patch（观测补丁） 等结构化低频负载下性能远过剩 |
| 权限 | **`fabric-permissions-api`**（LuckPerms 软依赖） | lucko 出品社区事实标准；`Permissions.check(src, perm, 4)` 自动回退原版 op 等级判定；`fabric.mod.json`（模组元信息） 不把 LuckPerms 写为强依赖 |
| 全息 / 文字显示 | **MC 1.20.4 原生 `text_display` 实体** | 1.19.4+ 原生支持；不引入 DecentHolograms 等第三方全息库 |
| MC 内部网络包 | **`fabric-networking-api-v1`** | ⚠️ 仅用于 MC 客户端 ↔ MC 服务端发自定义 payload；**严禁** 误用为 mod ↔ TS Core 外部进程通信通道（这是 Fabric 新人最常见误用之一，T-Fabric-Bridge 派发文档必须显式警告） |

**Transport 隔离约束**：mod 端 OkHttp 客户端必须封装在一个明确的 `ServerBridgeTransport`（服务端桥接传输） 接口后面，未来如需切换到 `java.net.http.WebSocket`、原生 Netty 或其他实现，业务代码不需要修改。这是文档第 15 节"模块解耦原则"在 mod 端的对应实现。

**TS Core 端对接约束**：`interfaces/server-bridge/`（服务端桥接接口） 当前仅有 `contracts.ts`（契约） + `index.ts`（导出）；T-Fabric-Bridge 系列任务对接时，TS Core 端只增加协议契约 / 接收端骨架 / 解析适配，**禁止把 OkHttp 或任何 Java 侧细节渗漏到 TS Core 代码**。两端共享的只有 JSON 协议形态。

**⑦ 持久化 — PostgreSQL + Drizzle ORM + pgvector + JSONL**

PG 是唯一业务真理源。Drizzle ORM 提供轻量 SQL 生成，无性能黑盒。pgvector 作为 PG 原生插件提供向量检索能力。高频执行日志走 JSONL 本地文件追加，PG 存任务卡（B 层 `task_events`）、A.5 滚动摘要、C 层资产（USER/MEMORY/SKILL）、候选池与审计流水（按 bot_id 隔离）；JSONL 只存原始执行轨迹,通过 `log_ref` 指针关联（不绑死本地路径语义）。

---

## 3. 三队列异步架构

### 3.1 队列划分

| 队列名 | Worker 类型 | 职责 | 并发模型 |
|--------|------------|------|----------|
| `msg:{botId}` | ConversationWorker | 意图分析、优先级判定、回复生成、代码规划 | 可并发（LLM I/O 等待不阻塞事件循环） |
| `bot:{botId}:exec` | BotWorker | 沙箱执行、Mineflayer 物理动作 | **严格串行**（单写者独占） |
| `brain` | BrainWorker | 任务卡入库（B 层）、A.5 滚动摘要维护、C 层资产候选识别与自动提拔 | 全局池 |

### 3.2 全链路数据流

```
消息到达（HTTP POST / 游戏内 /svs 指令）
    │
    ├─ message_id 去重（重复 → 丢弃）
    │
    ├─ 精确匹配 control 指令？
    │   → 是："停" / "别动" / "取消" → botActor.interrupt() → Socket.io 广播 → done
    │   → 否：继续 ↓
    │
    └─ 推入 msg:{botId} 队列（返回 HTTP 202 + jobId）
                    │
                    ▼
         ┌──────────────────────┐
         │  ConversationWorker  │
         │  意图分析 + 优先级    │
         └──────────┬───────────┘
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
        闲聊      任务        中断指令
          │         │          │
          │         │          │ botActor.interrupt()
          ▼         ▼          ▼
     LLM 生成    LLM 生成   BotActor 立即
     回复文本    TS 代码片段  中止当前任务
          │         │
          │         │ 推入 bot:{botId}:exec
          │         │ （带 priority + intent_epoch）
          │         ▼
          │   ┌──────────────┐
          │   │  BotWorker   │ ← 串行取出，epoch 校验
          │   │  BotActor    │
          │   │  沙箱执行     │
          │   └──────┬───────┘
          │          │
          │          │ 每步 yield → event_log + Socket.io 广播
          │          │
          │          │ 任务完成 → 推入 brain 队列
          │          ▼
          │   ┌──────────────────┐
          │   │ BrainWorker      │ ← 全局池
          │   │ 任务卡入库 + A.5   │
          │   │ 滚动摘要 + 候选提拔│
          │   └──────┬───────┘
          │          │
          │          ▼
          └────►  Socket.io 广播到 Room
                 PG 写入关键状态
```

### 3.3 消息入口 Control 快路径规则

快路径只覆盖 control 类指令，且必须**精确匹配**。消息内容多一个字即不命中，走 LLM。

```typescript
const CONTROL_COMMANDS: Map<string, ControlAction> = new Map([
  ['停', 'interrupt'],
  ['别动', 'interrupt'],
  ['取消', 'cancel'],
])

function tryControlFastPath(msg: string): ControlAction | null {
  return CONTROL_COMMANDS.get(msg.trim()) ?? null
}
```

Phase 1 此表只有 3-5 个词条。宁少勿多——误命中快路径比多走一次 LLM 的代价大得多。所有 query 类（"你在哪"、"背包里有什么"）和 task 类消息全部走 LLM，保证沉浸感。

### 3.4 Phase 1 部署模型

三种 Worker 跑在同一个 Node.js 进程里（三个 BullMQ Worker 实例）。单进程，单容器。进程由 Docker restart policy 守护。

本地全部署：全部服务在 WSL2 中通过 Docker Engine（原生安装，非 Docker Desktop）+ Docker Compose 管理。TS Core、Redis、PostgreSQL 为容器；MC Server 已直接运行在 WSL2 宿主中。同机零网络延迟。

**单进程限定声明**：本架构为单服务器单进程设计。中断机制（AbortController 直调）、Socket.io（内存 adapter）、Worker 间通信（直接函数调用）均基于同进程假设。如未来确需扩展，中断需升级为 Redis command channel，Socket.io 需切换 Redis adapter。但 Phase 1 及可预见的 Phase 2（一机多 Bot，3-5 个）不需要这些改动。

---

## 4. 三层响应模型：脊髓 → 丘脑 → 皮层

Bot Agent 需要同时处理三种完全不同速度的决策。

### 4.1 分层概览

```
        层级      响应速度      决策者             触发源
        ──────   ──────────   ─────────────────  ───────────────
        脊髓      < 200ms     硬编码规则表         游戏事件
        丘脑      1-5s        LLM 轻量判断        玩家消息
        皮层      5-30s       LLM 深度推理        BrainWorker 异步
```

### 4.2 第一层：脊髓反射（Reflex）

observation 模块持续监听 Mineflayer 游戏事件 + JAR Bridge 推送，维护环境缓存快照。当检测到威胁条件满足时，observation 向 BotActor 发出带类型的中断信号。BotActor 内置一组硬编码反射动作，中止当前任务后立即执行。

**单写者原则未被打破**：observation 不直接操作 Bot，只发中断信号。BotActor 自己决定怎么反应，自己执行反射动作。

**Phase 1 反射规则表：**

| 触发条件 | 威胁等级 | 反射动作 |
|---------|---------|---------|
| 敌对生物 ≥ 4 只，距离 < 16 格 | flee | 朝远离方向冲刺 + 跳跃 |
| 敌对生物 1-3 只，距离 < 16 格，持有武器 | fight | 面向最近敌人，攻击 |
| 敌对生物 1-3 只，距离 < 16 格，无武器 | flee | 朝远离方向冲刺 |
| 自身着火 | emergency | 寻找最近水源 / 原地跳跃 |
| 生命值 < 4（2颗心） | emergency | 脱离战斗，进食（如有食物） |
| 坠落中（Y 轴速度异常） | emergency | 无操作（避免干扰物理引擎） |

**反射后原任务处置：abort and forget。** 反射执行完毕后，BotActor 回到 idle。被中断的任务标记为 `interrupted`，原因记录为反射触发类型（如 `threat:flee`）。被中断的任务不会自动恢复。如果用户的原始意图仍然有效，BrainWorker 会基于当前状态异步评估是否需要重新规划，以新任务的形式推入 exec 队列。

脊髓反射永远不会被删掉。即使未来 LLM 能力再强，200ms 的生存决策不能等 LLM。

### 4.3 第二层：丘脑过滤（Triage）

消息进入 ConversationWorker 后，LLM 不只判断"闲聊还是任务"，还输出一个紧迫度信号：

```typescript
interface MessageTriage {
  intent: 'chat' | 'task' | 'cancel'
  priority: 'interrupt' | 'urgent' | 'normal' | 'background'
  reason: string
}
```

priority 映射到 BullMQ Job 优先级（四档，数字越小越优先）：

| priority | 行为 | BullMQ priority 值 |
|----------|------|-------------------|
| interrupt | 直接调 `botActor.interrupt()`，中止当前任务 | — |
| urgent | 插队到 exec 队列前面 | 1 |
| normal | 正常入队 | 5 |
| background | 低优先级入队 | 10 |

四档不再细分。

### 4.4 第三层：大脑皮层（Deliberation）

BrainWorker 异步消化的重决策：

- 脊髓反射逃跑后，评估是否应该回去继续原任务
- 多个任务摘要积累后，生成更高层策略建议
- 基于历史记忆做 RAG 检索，为下一次规划提供上下文

这一层的输出以新任务的形式推入 exec 队列。Bot 不需要等它。

### 4.5 三层关系

三层的执行入口全部收口在 BotActor：

- 脊髓：`botActor.interrupt(signal)` → 立即反射
- 丘脑：`execQueue.add(job, { priority })` → BotActor 按优先级取出执行
- 皮层：`execQueue.add(newPlan, { priority })` → 同上

**单写者原则始终未被打破。**

---

## 5. 中断协议：AbortController + AsyncGenerator

### 5.1 核心机制

中断的本质是让一个正在执行的异步流程在下一个安全点停下来。Node.js 内置的 AbortController 是原生答案。

BotActor 每次开始执行一个任务时，创建一个新的 AbortController。signal 穿过整条执行链：

```
BotActor
  └─ AbortController.signal
       └─ 沙箱执行入口
            └─ 顶层语义 API / host bridge 每个动作调用
                 └─ Mineflayer pathfinder / dig / collect
```

### 5.2 沙箱内的步骤推进

```typescript
async function* executePlan(steps: Step[], signal: AbortSignal) {
  for (const step of steps) {
    signal.throwIfAborted()
    const result = await runStep(step, signal)
    yield { step, result }
  }
}
```

### 5.3 中断信号来源

无论来自哪个入口，最终收口为一个调用：`botActor.interrupt(reason)`。

| 来源 | 路径 |
|------|------|
| 玩家网页端发"停" | 精确匹配 → 直接调 botActor.interrupt() |
| 玩家游戏内发"/svs 停" | 精确匹配 → 同上 |
| observation 检测到威胁 | 直接调 botActor.interrupt({ type: 'threat', ... }) |
| ConversationWorker 判定 priority=interrupt | 调 botActor.interrupt() |

### 5.4 特性

- **零外部依赖**：不需要 Redis pub/sub 侧通道
- **零延迟**：同进程同步调用
- **天然安全**：AbortError 走标准 try/catch/finally
- **单进程限定**：此机制仅在同进程内有效（见 3.4 节声明）

---

## 6. 执行核心：BotActor 状态机

### 6.1 状态定义

```
        ┌──────────┐
        │  idle    │ ← 初始 / 任务完成 / 反射完成
        └────┬─────┘
             │ 从 exec 队列取出任务（epoch 校验通过）
             ▼
        ┌──────────┐
        │executing │ ← 沙箱执行中，持有 AbortController
        └────┬─────┘
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
 完成     中断      失败
     │       │        │
     │       ▼        ▼
     │  ┌─────────┐  标记 failed
     │  │reflexing│  推入 brain 队列
     │  └────┬────┘
     │       │
     └───────┘
             │
             ▼
        ┌──────────┐
        │  idle    │
        └──────────┘
```

### 6.2 关键约束

- idle 状态下 BotActor 主动从 exec 队列拉取下一个任务（pull 模式）
- 取出 job 时先校验 `intent_epoch`：若 job.epoch < 当前 bot 的 epoch，直接丢弃，取下一个
- 取出 job 时校验 `snapshot_ts`：若 `now() - snapshot_ts > 30s`（可配置），observation 先刷新快照，对比关键字段（位置、生命值、背包），有显著变化则丢弃 job，推入 brain 队列触发重规划
- executing 状态下不取新任务，中断是唯一打断方式
- reflexing 状态下执行硬编码反射动作，不接受新中断（反射动作是原子的、极短的）
- 任何状态转换都写入 event_log

---

## 7. TS 代码沙箱

### 7.1 选型：isolated-vm

| 方案 | 隔离级别 | 安全性 | 结论 |
|------|---------|--------|------|
| `node:vm` | 同进程共享堆 | 官方 "not for security" | 淘汰 |
| `isolated-vm` | V8 Isolate 独立堆 | 内存/CPU 限制开箱即用 | **选用** |
| `quickjs-emscripten` | WASM 隔离 | 性能不够 | 淘汰 |

已知风险：isolated-vm 处于 maintenance mode。V8 OOM/灾难性错误可能带崩宿主进程。防线：`memoryLimit: 128`（MB）拦截 90% OOM，进程级由 Docker restart policy 兜底。沙箱调用集中在 `sandbox/` 模块内，不散落到其他模块，未来如需替换实现只改一个目录。

### 7.2 执行流程

```
LLM 输出 TS 代码片段
    → esbuild.transform(code, { loader: 'ts' })   // < 1ms
    → isolate.compileScript(jsCode)
    → script.run(contextWithSemanticApi, { timeout: 30_000 })
```

### 7.3 语义 API 与 host bridge 是 BotActor 的代理

TS（TypeScript）代码通过语义化全局函数发起动作,执行器把调用映射到 host bridge 后再交给 BotActor（机器人执行代理） 全权审批。在线沙箱不暴露旧 `api.bot` / `api.chat` 命名空间：

```
TS 代码内 mine('stone', 5)
    → 跨 isolate Reference 回调
    → host bridge: bot.mine({ target: 'stone', count: 5 }, signal)
    → BotActor 单写者执行
    → Mineflayer 执行
    → 结果返回 TS 代码任务
```

安全边界：沙箱内代码无法访问文件系统、网络、进程管理。所有与 Bot 的交互必须通过顶层语义 API 与 host bridge。执行超时自动终止。

---

## 8. Event Protocol

### 8.1 任务生命周期六态

全系统统一的任务事件协议。任何任务从受理到结束，必须经过且仅经过以下状态：

```
accepted → started → progress* → completed
                               → failed
                               → interrupted
```

| 状态 | 含义 | 触发点 |
|------|------|--------|
| accepted | 消息已入队，尚未开始执行 | msg 队列入队时 |
| started | BotWorker 已取出任务，开始执行 | BotActor 进入 executing 状态 |
| progress | 执行中间步骤完成 | 沙箱每步 yield |
| completed | 任务正常完成 | 所有步骤执行完毕 |
| failed | 任务执行失败 | step 异常 + 不自动重试 |
| interrupted | 任务被中断 | control 指令 / 反射触发 / 新意图覆盖 |

前端、游戏端、队列层、Worker 必须统一使用这六种状态，不允许自定义额外状态。

### 8.2 append-only Event Log

所有细粒度事件（任务状态变化、step progress、聊天消息、中断原因、反射触发）写入 PG 独立的 append-only 事件表：

```sql
CREATE TABLE event_log (
  seq         BIGSERIAL PRIMARY KEY,
  bot_id      TEXT NOT NULL,
  session_id  TEXT,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_event_log_bot_seq ON event_log (bot_id, seq);
```

type 枚举示例：`task.accepted`、`task.started`、`step.progress`、`task.completed`、`task.failed`、`task.interrupted`、`chat.reply`、`reflex.triggered`、`intent.epoch_changed`。

### 8.3 断线重连协议

双层机制：

1. **短暂断线（秒级）**：复用 Socket.io 内建 connection state recovery（单机内存 adapter 下有效）
2. **长断线**：客户端重连时携带 `last_seen_seq`，服务端从 event_log 补拉：

```
GET /api/replay?bot_id={botId}&after_seq={lastSeenSeq}&limit=50
```

返回：当前 Bot 状态快照 + `last_seen_seq` 之后的最近 50 条事件。足够用户理解断线期间发生了什么。

---

## 9. Ingress Idempotency

### 9.1 message_id 去重

每条进入系统的消息在入口层分配全局唯一 `message_id`。msg 队列入队时以 `message_id` 作为 BullMQ 的 `jobId`。同一 `message_id` 的重复消息（用户双击、HTTP 重试、游戏端重复触发）自动去重。

### 9.2 intent_epoch

每个 bot session 维护一个单调递增的 `intent_epoch`（Redis `INCR bot:{botId}:intent_epoch`）。

- 每当用户发出新消息，epoch 自增
- ConversationWorker 产出的任何计划都携带当前 epoch
- BotWorker 从 exec 队列取出 job 时，先校验 `job.epoch >= 当前 epoch`；过期计划直接丢弃

epoch 解决的问题：LLM 响应有快有慢，旧计划可能晚于新计划到达 exec 队列。epoch 保证只有最新意图对应的计划被执行。

**epoch 不丢历史。** 每个任务无论成功、失败、被中断、被 epoch 丢弃，都写入 PG 任务历史表和 event_log。当用户说"把之前没干完的活干完"时，ConversationWorker 的 LLM 可以从 PG 查到完整的任务历史，理解上下文后生成新计划。

### 9.3 消息分类

入口层将消息分为两类：

| 类型 | 识别方式 | 走向 |
|------|---------|------|
| control | 精确匹配极小关键词表（3-5 个词条） | 直接执行，不入队 |
| 其余一切 | 不匹配 | 推入 msg 队列 → ConversationWorker（LLM） |

control 快路径只做精确匹配（`Map.get(msg.trim())`），消息多一个字即不命中。所有需要理解语义、需要沉浸感回复的消息一律走 LLM。

---

## 10. Execution Contract

### 10.1 step 后状态必须可观测

任何 step 执行后（无论成功、失败、中断），observation 模块必须能采集到一致的环境快照。这是重规划的前提——如果系统不知道当前状态，就无法基于当前状态做决策。

每个语义动作在返回前，必须等待 Mineflayer 状态稳定（背包同步完成、实体位置更新完成）并产出真实完成证明后再返回结果。不允许"动作发出但状态未同步"的中间态泄露到上层。

### 10.2 snapshot_version 校验

ConversationWorker 生成计划时从 observation 获取最新快照，计划携带 `snapshot_ts`。BotWorker 取出 job 时：

- 若 `now() - snapshot_ts > 30s`（可配置阈值），observation 先刷新快照
- 对比关键字段（Bot 位置、生命值、背包内容）
- 有显著变化 → 丢弃旧计划，推入 brain 队列触发重规划
- 无显著变化 → 继续执行

### 10.3 长任务心跳

follow、持续采矿、巡逻等长时任务，利用 BullMQ 内建的 stalled job 检测机制：

- `stalledInterval: 30_000` — Worker 必须每 30 秒续约一次 job lock
- `maxStalledCount: 0` — stalled 的 job 直接标记为 failed，不自动重试

BotWorker 在执行长任务时，BullMQ 会自动在后台续约。如果进程崩溃，续约停止，30 秒后 job 被标记为 failed（`stalled`），不会在 PG 中留下永不结束的僵尸任务。

---

## 11. Failure & Recovery Semantics

### 11.1 核心原则：不自动重试，基于当前状态重规划

Bot 物理动作有不可逆副作用——"挖了一半的矿"不能通过重试变成"没挖过"。BullMQ 的 retry 机制假设 job 幂等，但 Bot 动作天然不幂等。

因此：

- BullMQ job 设 `attempts: 1`（不重试）
- 失败任务保留最近 100 条记录：`removeOnFail: { count: 100 }`（保证 jobId 去重仍有效）
- 失败后由 BrainWorker 异步评估：基于当前 observation 快照决定是否重新规划
- 重规划产出的是**新任务**（新 jobId、新 epoch），不是旧任务的重试

### 11.2 反射后恢复

反射触发后，原任务标记为 `interrupted`（reason: `reflex:{type}`）。BotActor 回到 idle。

被中断的任务不会自动恢复。BrainWorker 异步评估：

- 查看 PG 任务历史：被中断的任务是什么？
- 查看当前快照：Bot 现在安全吗？环境变了吗？
- 决策：推入新计划（可能是继续原目标，也可能是完全不同的行动），或者不做任何事情（等待用户下一步指令）

### 11.3 进程崩溃恢复

进程崩溃 → Docker 自动重启容器 → Mineflayer 重连 MC Server → observation 采集当前快照 → BotActor 回到 idle → 等待队列中的下一个任务或用户新指令。

PG 中 `status = started` 的任务通过 BullMQ stalled 检测自动标记为 failed。event_log 记录崩溃事件。不需要手动干预。

### 11.4 任务修改

统一降级为 cancel + new。不做旧计划与新计划的 diff。cancel 当前任务（interrupt），然后基于当前状态生成新计划。简单、可预测、无状态残留。

---

## 12. 双轨 RAG 与记忆系统

### 12.1 两种知识，两种武器

| 知识类型 | 检索方式 | 数据源 | 延迟 |
|---------|---------|--------|------|
| MC 常识（配方、方块属性、生物数据） | 确定性 API 调用 | 本地 `minecraft-data` npm 包 | < 1ms |
| 历史记忆（"上周我们在哪挖的矿"） | pgvector 混合检索 | PostgreSQL 本地表 | < 10ms |

MC 常识绝不走向量检索。`minecraft-data` 是本地 JSON 字典，命中率 100%，无幻觉。

### 12.2 历史记忆：pgvector 混合 RAG

pgvector 是 PG 原生插件。`CREATE EXTENSION vector;` 即启用，不引入外部向量数据库。

- 摘要表加列：`embedding vector(1024)`
- 写入时：BrainWorker 生成摘要 → Embedding API（Qwen3-Embedding-8B text-embedding-v4，1024 维） → 文本 + 向量写入 PG
- 召回时：用户提问 → Embedding API → PG 余弦距离匹配 → Top-N

混合检索 = 全文搜索 (tsvector) + 向量搜索 (pgvector)，两路结果合并排序。

---

## 13. 日志存储与冷热分离

| 数据类型 | 存储位置 | 格式 | 用途 |
|---------|---------|------|------|
| 每步执行日志 | 本地文件系统 | JSONL | 高频追加，极低频读取 |
| LLM 原始 I/O | 本地文件系统 | JSONL | 调试回溯 |
| 摘要索引 | PostgreSQL | 结构化行 + `log_ref` 指针 | 检索、RAG |
| 事件流 | PostgreSQL event_log | append-only 行 | 断线补拉、审计 |

每个任务开一个 `fs.createWriteStream('T-001.jsonl')`，每步追加一行极简 JSON。写入微秒级，不消耗 DB 连接池。

---

## 14. 数据与持久化边界

| 存储 | 角色 | 边界 |
|------|------|------|
| **PostgreSQL** | 唯一业务真理源 | 聊天上下文、owner 绑定、执行历史、摘要索引、向量嵌入、event_log |
| **Redis** | 队列引擎 + 短时缓存 | BullMQ 队列、intent_epoch 计数器、BotActor 状态缓存 |
| **JSONL 文件** | 冷日志存储 | 执行日志、LLM 原始 I/O |

Phase 1 全本地部署。

---

## 15. 模块划分

| 模块 | 职责 | 边界约束 |
|------|------|----------|
| `runtime/` | BotActor 状态机、AbortController、反射规则表 | 唯一允许操作 Bot 的层 |
| `conversation/` | 意图分析、优先级判定、回复生成、代码规划 | 不直接接触 Bot |
| `skills/` | goTo、mine、cutTree、collect、craft、place、equip 与 toolchain ensure 的语义动作实现 | 通过 BotActor 代理调用 Mineflayer；只依赖所需窄端口 |
| `observation/` | Mineflayer 事件 + JAR Bridge 推送监听、快照缓存、威胁检测 | **纯读、纯写缓存**，只能向 BotActor 发中断信号 |
| `world-model/` | minecraft-data 确定性查询、资源画像、cluster 缓存 | query 与 refresh 分离 |
| `interfaces/` | Fastify 路由、Socket.io 推送、游戏聊天适配器、**server-bridge/** | 不参与 Bot 执行逻辑 |
| `diagnostics/` | JSONL 日志、LLM transcript、run event | LLM 原始 I/O 必须本地文件可见 |
| `sandbox/` | isolated-vm 集成、顶层语义 API 注入、host bridge、结果事实聚合、esbuild 转译 | 沙箱内代码无法逃逸到宿主；旧 Facade 只在 legacy/test-only |
| `workers/` | ConversationWorker、BotWorker、BrainWorker 入口 | 每个 Worker 只消费自己的队列 |
| `db/` | Drizzle schema、migrations、PG 连接池 | 不承载业务逻辑 |
| `data/` | resource_profiles、词汇映射、配置 | 不承载 MC 事实真源 |
| `core-ports/` | 跨模块共享端口契约（v0.3 追认，T-028 引入） | 横切层，禁止反向 import `runtime` / `skills` / `observation` / `diagnostics` / `data` 实现 |
| `app/` | 组合根：装配 `interfaces` / `workers` / `runtime` / `db` / `data` / `sandbox` / `diagnostics`，集中管理依赖注入与启停顺序（v0.3 追认） | 不承载业务执行逻辑；其他模块禁止反向依赖 `app/` |

**模块解耦原则**：模块间只通过队列、事件和类型接口通信，不允许直接 import 其他模块的内部实现。方便未来再设计、再修改、重构。

**模块组织口径**：目录代表已经稳定的抽象边界，文件代表边界内的具体角色。是否建目录优先取决于职责边界和依赖方向，而不是文件行数；边界未稳定、能力很小或只有 1-2 个文件时允许平铺。barrel 只能作为出口聚合，不承载业务逻辑、兼容判断、fallback 或错误转换。

---

## 16. 目录结构

> v0.4 修订（2026-05-16）：本节按 T-083 至 T-102 后的代码组织同步。目录代表稳定抽象边界；barrel 入口只做 re-export，不承载业务逻辑、兼容判断、fallback 或错误转换。

```
ts-core/
├── src/
│   ├── app/                          # 组合根（v0.3 追认；不属于七层之内）
│   │   ├── bootstrap/                # 装配子职责：config / env / resources / services / ...
│   │   │   ├── config.ts
│   │   │   ├── env.ts
│   │   │   ├── directories.ts
│   │   │   ├── external-auth.ts
│   │   │   ├── process.ts
│   │   │   ├── resources.ts
│   │   │   ├── runtime-core.ts
│   │   │   ├── services.ts
│   │   │   ├── contract.ts
│   │   │   └── types.ts
│   │   ├── contracts.ts
│   │   ├── entrypoint.ts             # 在线运行时启动入口（含 startAppOnlineRuntime）
│   │   └── smoke.ts                  # 无 MC 冒烟装配
│   ├── core-ports/                   # 横切端口层（v0.3 追认；T-028 引入）
│   │   ├── foundation.ts             # 基础共享类型
│   │   ├── runtime.ts                # 运行时端口（BotActor、broadcast、interrupt）
│   │   ├── skills.ts                 # 技能公共契约兼容 barrel
│   │   ├── skill-adapters.ts         # 技能执行适配器
│   │   ├── skill-catalog.ts          # 技能目录
│   │   ├── skill-results.ts          # 技能结果与完成证明
│   │   ├── skill-toolchain.ts        # ensure / until / 工具链契约
│   │   ├── observation.ts            # 观测端口
│   │   ├── tasking.ts                # exec 任务 / 优先级端口
│   │   ├── events.ts                 # 跨模块事件端口
│   │   └── sandbox.ts                # 沙箱端口
│   ├── domain/                       # 横切领域基础（共享不变量、只读辅助）
│   ├── runtime/                      # BotActor、状态机、中断协议、反射规则
│   │   ├── actor.ts
│   │   ├── state-machine.ts
│   │   ├── contracts.ts
│   │   ├── events.ts
│   │   ├── tasking.ts
│   │   └── transport/                # Mineflayer 适配按职责拆分
│   │       ├── runtime.ts            # Mineflayer transport 组合根
│   │       ├── lifecycle.ts
│   │       ├── pathfinder.ts
│   │       ├── go-to.ts
│   │       ├── collect.ts
│   │       ├── craft.ts
│   │       ├── placement.ts
│   │       ├── equip.ts
│   │       ├── naming.ts
│   │       ├── mining/               # 采矿入口、BFS 规划、执行、方块事实、工具策略
│   │       ├── terrain/              # 地形路由、动作执行、本地移动、自放置记忆
│   │       ├── world/                # world_key、资源刷新、观测输入、世界状态重置
│   │       ├── facts/                # registry / block / toolchain facts
│   │       └── types.ts
│   ├── conversation/                 # 意图分析 / 分诊 / 回复 / 规划
│   │   ├── contracts.ts
│   │   ├── triage.ts                 # 含 ConversationCompositeTriage（T-032）
│   │   ├── chat.ts
│   │   ├── planning.ts
│   │   └── llm/                      # LLM 客户端 / 配置 / 解析 / 模板
│   │       ├── client.ts
│   │       ├── config.ts
│   │       ├── http.ts
│   │       ├── stage.ts              # executeStage 三段调用模板
│   │       ├── messages.ts
│   │       ├── parsers.ts
│   │       ├── types.ts
│   │       ├── errors.ts
│   │       ├── diagnostics.ts
│   │       ├── skill-plan-table.ts
│   │       └── prompts/              # Prompt 模板独立组织
│   │           ├── triage.ts
│   │           ├── chat.ts
│   │           └── plan.ts
│   ├── skills/                       # 语义动作、结果证明、toolchain ensure
│   │   └── toolchain-ensure/         # 条件检查、恢复规划、能力执行、失败归因
│   ├── observation/                  # 快照缓存、威胁评估
│   ├── world-model/                  # minecraft-data 查询、ResourceService 资源簇、世界模型缓存
│   ├── interfaces/                   # API / 实时推送 / 游戏聊天 / 服务端桥接
│   │   ├── api.ts                    # Fastify 路由
│   │   ├── realtime.ts               # Socket.io 推送契约与广播适配
│   │   ├── server.ts
│   │   ├── contracts.ts
│   │   ├── errors.ts
│   │   ├── game-chat/                # Mineflayer chat 适配
│   │   └── server-bridge/            # Fabric mod WebSocket 桥接协议与路由
│   ├── diagnostics/                  # JSONL 日志、LLM transcript、run events
│   ├── sandbox/                      # isolated-vm + 语义 API + host bridge + 结果事实
│   │   └── legacy/                   # 旧 Facade/test-only 兼容入口
│   ├── workers/                      # ConversationWorker / BotWorker / BrainWorker
│   │   ├── bot-worker.ts
│   │   ├── brain-worker.ts           # T-033 引入
│   │   ├── bullmq.ts
│   │   ├── queues.ts
│   │   ├── contracts.ts
│   │   └── conversation-worker/
│   │       ├── runtime.ts
│   │       ├── events.ts
│   │       ├── types.ts
│   │       ├── plan-exec/            # context / continuation / planner / job / dispatch / metrics
│   │       └── handlers/
│   │           ├── chat-reply.ts
│   │           ├── plan-exec.ts
│   │           └── cancel-interrupt.ts
│   ├── db/                           # Drizzle schema、migrations、PG / Redis 连接
│   ├── data/                         # 数据契约
│   │   └── contracts/                # T-029 拆分：tables / event-log / persistence / ...
│   │       ├── tables.ts
│   │       ├── event-log.ts
│   │       ├── persistence.ts
│   │       ├── task-history.ts
│   │       ├── config.ts
│   │       ├── config-types.ts
│   │       └── utils.ts
│   ├── __tests__/                    # 按行为场景目录化；legacy/test-only 与主路径分离
│   ├── index.ts
│   └── main.ts                       # 进程可执行入口
├── logs/                             # JSONL runtime logs (gitignored)
├── scripts/                          # CLI tools，含 pre_review.sh
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
└── vitest.config.ts
```

其中 `domain/`（领域） 与 `core-ports/`（核心端口） 作为横切基础层，只承载可被多模块复用的核心类型、基础校验、只读辅助与跨模块端口契约，不直接承载业务流程、队列装配或外部 I/O（输入输出） 逻辑。`app/`（应用装配） 作为组合根，集中处理依赖装配与生命周期，不承载业务执行。

**barrel 入口约定**：当一级模块文件被拆入子目录后（如 `conversation/llm.ts`、`workers/conversation-worker/index.ts`、`app/bootstrap/index.ts`、`data/contracts/index.ts`），barrel 只能做 `export *` 或类型 re-export。**新代码应优先 import 稳定目录入口**；legacy/test-only 兼容出口必须显式命名并与在线主路径隔离。

### 16.1 命名约定

TS Core（TypeScript 单核心） 在跨边界数据上固定以下命名规则，避免协议字段与运行时变量混用：

- 对外协议、持久化字段、JSONL（结构化日志） 与 HTTP（超文本传输协议） 请求 / 响应统一使用 `snake_case`（下划线命名），例如 `bot_id`、`message_id`、`snapshot_ts`。
- 运行时 JS（JavaScript） / TS（TypeScript） 内部变量、局部参数与函数参数统一使用 `camelCase`（驼峰命名），例如 `botId`、`messageId`、`snapshotTs`。
- 跨边界转换必须由工厂函数或适配器集中处理，不允许在业务流程中散落手写字段桥接；典型桥接为 `bot_id`（机器人标识字段） ↔ `botId`（机器人标识变量）。
- 模块内若同时持有协议对象与内部对象，应通过类型名或函数名标明边界，例如 `MessageSubmissionRequest`（消息提交请求） 保留协议字段，`createMessageAcceptedResponse()`（创建消息接受响应） 负责输出字段投影。

---

## 17. 身份与交互模型

- 一主一 Bot 绑定，网页登录后直接进入聊天页
- 轻身份模式：账号密码 + 7 天 token 缓存
- 游戏内只承认主人消息，其他玩家不能控制 Bot
- 游戏内入口强制格式 `/svs ...`，避免误触发
- 所有文本输入统一建模为消息事件（含 source、ownerId、botId、channel、sessionId、message_id）
- 所有文本输出统一广播，网页端和游戏端保持完全一致

---

## 18. Phase 1 范围

### 必须完成

| # | 内容 | 对应模块 |
|---|------|----------|
| 1 | 项目基座：pnpm + TS strict + NodeNext + Biome + PG + Redis | 工具链 |
| 2 | runtime + conversation + interfaces 最小闭环 | 核心三件套 |
| 3 | BotActor 状态机 + AbortController 中断协议 | runtime |
| 4 | 三队列模型 + ConversationWorker / BotWorker / BrainWorker | workers |
| 5 | isolated-vm 沙箱 + 顶层语义 API + host bridge + esbuild 转译 | sandbox |
| 6 | 最小 skill 闭环（goTo + cutTree + collect + craft/place/equip/mine 最小工具链） | skills |
| 7 | observation 基础 + 脊髓反射规则表 | observation, runtime |
| 8 | world-model 基础（minecraft-data 集成） | world-model |
| 9 | diagnostics + JSONL 日志体系 | diagnostics |
| 10 | Event Protocol 基础（event_log 基础写入；增强补拉推迟） | db, interfaces |
| 11 | Ingress Idempotency（message_id + intent_epoch） | interfaces, workers |
| 12 | 扩充 cutTree / collect / equip | skills |
| 13 | 双轨 Worker + BrainWorker 长期记忆四层（A.5 滚动 / B 层任务卡 / C 层资产 / 候选提拔） | workers |
| 14 | 网页轻量聊天入口 + 双端消息同步基础 | interfaces |
| 15 | owner 与 bot 单绑定关系 | db, data |
| 16 | JAR 插件通信基础 | interfaces/server-bridge |

### 明确不做

- 继续修补旧系统 / 保留 Python 主线
- 多 Bot、多 Owner 权限体系、语音
- 通用 craft / place / drop 技能；当前只允许 06_AGENTIC_MINE_IRON_SPEC.md 定义的最小 craft/place/equip/mine 边界
- 复杂控制台、复杂 recovery 总线
- realtime / event_log / UI 增强（见 DEMO_DEBT.md）
- 云上部署、CDN、域名
- 预生成模板池（Phase 2 优化）

### 迁移原则

旧系统只是参考库。可复用：算法逻辑、数据结构、配置 shape、领域规则。禁止照搬：Python↔JS bridge 模式、sleep-based 状态同步、多模块直接碰 Bot 的旧模式。

---

## 19. 技术栈速查表

| 类别 | 选型 | 用途 |
|------|------|------|
| 运行时 | Node.js + TypeScript (strict) | 异步 I/O + 类型安全 |
| API 网关 | Fastify + Zod | 路由 + 运行时校验 |
| 实时推送 | Socket.io | 服务端→客户端广播 |
| 任务队列 | Redis + BullMQ | 三队列解耦 + 优先级 + 进度 |
| 执行核心 | BotActor 状态机 + Mineflayer | 单写者独占控制 |
| 代码沙箱 | isolated-vm + esbuild | LLM 代码安全执行 |
| 数据库 | PostgreSQL + Drizzle ORM | 业务真理源 |
| 向量搜索 | pgvector | 混合 RAG 记忆检索 |
| Embedding 模型 | Qwen3-Embedding-8B (text-embedding-v4) | 1024 维，质量/存储/索引最优平衡 |
| MC 常识 | minecraft-data | 确定性 API 查询 |
| 日志存储 | JSONL 本地文件 | 冷热分离 + PG 指针 |
| LLM SDK | @anthropic-ai/sdk 或 openai | 直接调用，无框架 |
| Server Bridge | 自定义 JAR 插件 | 服务端视角数据获取 |
| 代码规范 | Biome | Lint + Format |
| 包管理 | pnpm | 依赖管理 |
| 容器化 | WSL2 原生 Docker Engine + Compose | 轻量容器化，禁用 Docker Desktop |
| 进程守护 | Docker restart policy | 容器崩溃自动重启 |

---

## 20. 后续文档依赖

本文档是所有后续设计文档的根依赖。推进顺序：

1. **RUNTIME_SPEC.md** — BotActor 状态机完整定义、中断协议细节、反射规则表扩展策略
2. **SANDBOX_SPEC.md** — isolated-vm 集成方案、顶层语义 API、host bridge、安全边界细则

---

v0.2 完毕。你审一遍，没问题就进 RUNTIME_SPEC.md。
