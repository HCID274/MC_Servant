# MC_WSL_servant

> 一个跑在 WSL2 上的 Minecraft Bot Agent 系统:**TypeScript 单核心 + Fabric 服务端 mod**。
> 一主一 Bot,聊天驱动,LLM 生成代码 → 沙箱执行 → Mineflayer 物理动作。

---

## 这个项目是什么

在 Minecraft 里养一个能听懂人话的 Bot:

- 你在 **网页**(`POST /api/message`)或 **游戏内**(`/svs <消息>`)发一句话
- LLM 判断这是闲聊还是任务,生成回复或 TS 代码片段
- 代码在 isolated-vm 沙箱里跑,只调用顶层语义 API,再经 host bridge 交给 BotActor 单写者执行(走路、砍树、挖矿……)
- 全程双端同步:网页和游戏聊天栏看到的是同一份输出

整个系统是 **单进程、单写者、聊天驱动** 的——任意时刻只有一个 BotActor 拥有操作 Bot 的权力,其他模块只能观察、建议、请求中断。

---

## 仓库结构

```
MC_WSL_servant/
├── ts-core/              # ⭐ 主核心:TypeScript 单进程,装下系统的 99% 业务
│   ├── src/
│   │   ├── app/          # 组合根:依赖装配、启停顺序
│   │   ├── core-ports/   # 横切端口契约(打断模块循环依赖)
│   │   ├── domain/       # 领域类型与不变量
│   │   ├── runtime/      # BotActor 状态机 + 中断协议 + Mineflayer 适配
│   │   ├── conversation/ # 意图分诊 + LLM 客户端 + 回复/规划
│   │   ├── workers/      # ConversationWorker / BotWorker / BrainWorker
│   │   ├── sandbox/      # isolated-vm + 顶层语义 API + host bridge + esbuild
│   │   ├── skills/       # goTo / mine / cutTree / collect / craft / place / equip + ensure
│   │   ├── observation/  # 环境快照 + 威胁检测(纯读)
│   │   ├── world-model/  # minecraft-data 确定性查询
│   │   ├── interfaces/   # Fastify API + Socket.io + game-chat + server-bridge
│   │   ├── diagnostics/  # JSONL 日志 + LLM transcript
│   │   ├── data/         # 数据契约
│   │   └── db/           # Drizzle schema + PG 连接
│   ├── Docs/             # 设计文档(架构/运行时/沙箱/对话/数据/eval)
│   └── README.md         # 启动方式、环境变量、手测口径
│
├── plugin/               # Fabric 服务端 mod(Java 17)
│   ├── src/main/java/com/mcservant/
│   │   ├── MCServantMod.java              # mod 入口
│   │   ├── bridge/ServerBridgeTransport   # 桥接接口(隔离 OkHttp)
│   │   ├── bridge/OkHttpServerBridge*     # WebSocket 实现
│   │   └── command/SvsCommand.java        # /svs <message> 注册器
│   └── README.md         # mod 配置、构建、部署
│
├── compose.yaml          # PostgreSQL + Redis + ts-core 容器编排
├── dev-infra.sh          # 只起 PG + Redis,本机 pnpm dev 跑 ts-core
├── start-ts-core.sh      # 全 Docker 启动(验收模式)
└── stop-ts-core.sh
```

---

## 架构一图流

```
玩家
 │
 ├── 网页 ──► POST /api/message ──┐
 │                                │
 └── 游戏 /svs <msg> ──► Fabric mod ──WS──► /ws/server-bridge
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ msg:{botId} 队列     │ (BullMQ)
                       └──────────┬───────────┘
                                  ▼
                      ┌────────────────────────┐
                      │ ConversationWorker     │
                      │ LLM 分诊 / 回复 / 规划   │
                      └────┬───────────┬───────┘
                           │           │
                       闲聊回复      生成 TS 代码片段
                           │           │
                           │           ▼
                           │   bot:{botId}:exec 队列(严格串行)
                           │           │
                           │           ▼
                           │   ┌────────────────────┐
                           │   │ BotWorker          │
                           │   │ BotActor 状态机     │
                           │   │ isolated-vm 沙箱    │
                           │   │ 语义 API / host bridge│
                           │   │        └─► Mineflayer │
                           │   └────────┬───────────┘
                           │            │ 每步 yield
                           │            ▼
                           │     event_log + Socket.io 广播
                           │            │
                           ▼            ▼
                     ┌─────────────────────────┐
                     │ brain 队列              │
                     │ BrainWorker:任务卡入库 │
                     │ 摘要、记忆候选提拔       │
                     └─────────────────────────┘

                 数据真理源:PostgreSQL(+ pgvector + JSONL 冷日志)
                 队列 / 缓存:Redis
```

三条主轴撑起整个系统:

1. **三队列模型** — `msg`(可并发,LLM I/O 不阻塞)、`exec`(严格串行,单写者独占)、`brain`(全局池,异步消化)
2. **三层响应** — 脊髓反射 (<200ms 硬编码) → 丘脑分诊 (1-5s LLM 轻判断) → 皮层皮质 (5-30s LLM 深推理)
3. **AbortController 中断协议** — `botActor.interrupt(reason)` 是所有中断信号的唯一收口,signal 穿透到沙箱每一步

---

## 技术栈

### TS Core (`ts-core/`)

| 类别 | 选型 | 备注 |
|---|---|---|
| 运行时 | Node.js + TypeScript (strict, NodeNext) | 异步 I/O 天然适配 LLM 与 MC 协议 |
| API 网关 | Fastify + Zod | 路由 + 运行时校验 |
| 实时推送 | Socket.io | 仅服务端→客户端 |
| 任务队列 | Redis + BullMQ | 三队列、优先级、stalled 检测 |
| 代码沙箱 | isolated-vm + esbuild | LLM 生成 TS → JS → V8 隔离堆执行 |
| Bot 控制 | Mineflayer (+ pathfinder) | 客户端视角 |
| 数据库 | PostgreSQL + Drizzle ORM | 业务真理源 |
| 向量检索 | pgvector | 历史记忆混合 RAG |
| MC 常识 | minecraft-data | 配方/方块/掉落确定性查询 |
| 日志 | JSONL 本地文件 + PG `log_ref` 指针 | 冷热分离 |
| 包管理 / Lint / Test | pnpm + Biome + Vitest | |

### Fabric Mod (`plugin/`)

| 类别 | 选型 | 备注 |
|---|---|---|
| 平台 | MC 1.20.4 / Fabric Loader 0.15.7 / Fabric API 0.97.3+1.20.4 / Java 17 | 与生产服一致 |
| 构建 | Gradle Wrapper 8.7 + Fabric Loom 1.6 | |
| 桥接传输 | OkHttp 4.12 WebSocket(封装在 `ServerBridgeTransport` 接口背后) | mod ↔ TS Core 跨进程 |
| JSON | Gson(MC 类路径自带) | |
| 命令 | Brigadier + fabric-command-api-v2 | `/svs <message>` |
| 权限 | fabric-permissions-api(LuckPerms 软依赖,缺席回退原版 op) | |

> **硬约束**:`fabric-networking-api-v1` 只能用于 MC 客户端 ↔ MC 服务端的内部 packet,**严禁** 误用作 mod ↔ TS Core 外部进程通道。业务代码不得直接 import OkHttp / Netty,必须经过 `ServerBridgeTransport` 接口。

---

## 快速开始

### 0. 准备环境

- WSL2 + Docker Engine(原生,**不要** Docker Desktop)
- Node.js 20+,pnpm(由 Corepack 管理)
- Java 17(仅构建 mod 时需要)
- 一个跑着 Fabric 1.20.4 的 MC 服务端(在 WSL2 宿主裸跑即可)

### 1. 启动基础设施 + TS Core(开发模式)

```bash
./dev-infra.sh                 # 只起 PostgreSQL + Redis 容器
cd ts-core
pnpm install
cp .env.example .env           # 编辑 LLM_*, MC_*, SERVER_BRIDGE_* 等
set -a && source .env && set +a
pnpm db:migrate                # 首次需要
pnpm dev                       # tsx watch src/main.ts
```

启动日志按序打印:PostgreSQL / Redis 就绪 → Fastify 监听地址 → Mineflayer 上线用户名 → ConversationWorker 开始消费 `msg:{botId}` 队列。

### 2. 验收模式(全 Docker)

```bash
./start-ts-core.sh             # PG + Redis + ts-core 一起起
./stop-ts-core.sh
```

### 3. 闲聊手测

```bash
curl -X POST http://127.0.0.1:3000/api/message \
  -H 'content-type: application/json' \
  -d '{"bot_id":"local-bot","message_id":"msg-1","content":"你今天心情怎么样"}'
```

预期:控制台输出 LLM 调用摘要,游戏内 Bot 在聊天栏回复。

### 4. 构建并部署 Fabric mod

```bash
cd plugin
./gradlew build
# 产物:plugin/build/libs/mcservant-0.4.0.jar
# 复制到 MC 服务端的 mods/ 目录,与 fabric-api / fabric-permissions-api 同级
```

启动 MC 服务端时注入桥接配置:

```bash
java \
  -Dmcservant.bridge.enabled=true \
  -Dmcservant.bridge.url=ws://127.0.0.1:3000/ws/server-bridge \
  -Dmcservant.bridge.accessToken=<与 SERVER_BRIDGE_ACCESS_TOKEN 相同> \
  -Dmcservant.bridge.heartbeatSeconds=2 \
  -Dmcservant.bridge.instanceId=local-fabric-01 \
  -jar fabric-server-launch.jar nogui
```

游戏内执行 `/svs hello`:

- 桥接已连接,聊天栏灰色回显原文
- TS Core 侧 `/api/replay` 出现 `server_bridge.player_message` 事件
- 若 `SERVER_BRIDGE_CONVERSATION_ENABLED=true`,接着出现 `task.accepted` + `chat.reply`,Bot 在游戏聊天回复

---

## 关键约束(读代码前先看这五条)

1. **单写者** — 任意时刻只有 BotActor 操作 Bot,其他模块只能发中断信号
2. **聊天驱动** — 消息是唯一意图入口(网页 HTTP / 游戏 `/svs`)
3. **双端同步** — 消息、回复、执行进度全量广播
4. **本地执行闭环** — Bot 物理动作不绕道云端 LLM
5. **最小闭环优先** — Phase 1 只做"木头 → 工具链 → 石镐 → 铁矿"这一条主线

---

## 文档导航

设计文档全部在 `ts-core/Docs/`,按依赖顺序阅读:

| 序号 | 文档 | 内容 |
|---|---|---|
| 0 | `agent.md` | 新 Agent 入口,先读这个 |
| 1 | `01_ARCHITECTURE.md` | 七层架构、三队列、不可破坏约束、模块边界 |
| 2 | `02_RUNTIME_SPEC.md` | BotActor 状态机、中断协议、单写者执行模型 |
| 3 | `03_SANDBOX_SPEC.md` | isolated-vm 集成、语义 API、host bridge、安全边界 |
| 4 | `04_CONVERSATION_SPEC.md` | 意图分类、Prompt 设计、代码生成约束 |
| 5 | `05_DATA_SPEC.md` | Drizzle schema、JSONL、pgvector、冷热分离 |
| 6 | `06_AGENTIC_MINE_IRON_SPEC.md` | 挖铁闭环、阶梯 BFS、技能沉淀 |
| 7 | `07_EVAL_SPEC.md` | LLM 离线 eval + 生产指标 JSONL 契约 |
| - | `WORKFLOW.md` | Planner A / Coder B / Reviewer C 三角色协作 |
| - | `ENGINEERING_PRINCIPLES.md` | 高内聚 / 低耦合 / DRY / SOLID 评审标准 |
| - | `PROGRESS.md` | 已完成任务索引 |

mod 端文档见 `plugin/README.md` 与 `plugin/BUILD.md`。

---

## 常用命令速查

### TS Core(在 `ts-core/` 下)

| 用途 | 命令 |
|---|---|
| 安装 | `pnpm install` |
| 类型 / Lint / 测试 | `pnpm typecheck` / `pnpm lint` / `pnpm test` |
| 开发 / 构建 / 启动 | `pnpm dev` / `pnpm build` / `pnpm start` |
| 迁移 | `pnpm db:generate` / `pnpm db:migrate` |
| 循环依赖检查 | `pnpm dep:cycles` |
| Coder B 自检 | `bash scripts/pre_review.sh` |
| LLM eval | `pnpm eval:llm` |
| 生产指标汇总 | `pnpm metrics:summary` |

### Fabric Mod(在 `plugin/` 下)

| 用途 | 命令 |
|---|---|
| 构建 | `./gradlew build` |
| 本地联调假服务 | `python3 scripts/ws-debug-server.py` |

---

## 失败排查速查

| 现象 | 检查 |
|---|---|
| 握手被拒 | `SERVER_BRIDGE_ACCESS_TOKEN` 与 mod `mcservant.bridge.accessToken` 是否完全一致 |
| 协议不兼容 (`PROTOCOL_INCOMPATIBLE`) | TS Core 与 mod 双方升级后重启 |
| 心跳超时 | replay 出现 `server_bridge.heartbeat_timeout`,mod 自动按退避重连 |
| EasyAuth 登录失败 | `MC_EXTERNAL_AUTH_SECRET` 是否正确 |
| `world_ready=false` | MC 服务端是否允许该用户名进入世界 |
| 启动期 PG / Redis 失败 | 端口、密码、容器健康状态 |
| Bot 不动但日志正常 | 检查是否被 `intent_epoch` 校验丢弃(新意图覆盖了旧计划) |
