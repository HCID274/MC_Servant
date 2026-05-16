# TS Core

TypeScript 单核心 Minecraft Bot Agent。一主一 Bot,基础技能 + 轻面板。

主入口 `src/main.ts` 启动 Redis / PostgreSQL / BullMQ / Fastify / Mineflayer,
ConversationWorker 消费网页与 `/svs` 消息,闲聊直接回复,任务统一规划为 TS 代码任务后推入 BotWorker 串行执行。
配置 `LLM_*` 后,闲聊、分诊、规划与可选任务汇报润色走真实 OpenAI 兼容 `chat.completions`;
配置 `SERVER_BRIDGE_ACCESS_TOKEN` 后,启用 `/ws/server-bridge`(Fabric mod `/svs` → TS Core)。

## 当前执行模型

- 在线 Plan 只产出 `{ "code": "..." }`;简单任务和复杂任务都走同一条 TS 代码沙箱生命周期。
- 沙箱内只暴露顶层语义 API:`reply`、`runGoal`、`ensure`、`until`、`mine`、`cutTree`、`craft`、`place`、`equip`、`collect`、`goTo`、`report`、`search`、`sleep`、`owner`。
- 旧 `api.bot` / `api.chat` / `SkillCall` 只允许留在 `legacy` 或负向测试中,不得进入在线主路径。
- `mine`、`cutTree` 等资源动作必须以真实背包增量或结构化完成证明为准;复杂目标通过 `ensure(action, until.xxx(...))` 做最终条件检查。
- 运行时传输层按稳定能力目录化:`transport/mining/` 负责采矿规划与执行,`transport/terrain/` 负责地形动作路由,`transport/world/` 负责世界读取、资源刷新与观测输入。

## 命令

| 用途 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 类型检查 / lint / 测试 | `pnpm typecheck` / `pnpm lint` / `pnpm test` |
| 开发 / 构建 / 启动 | `pnpm dev` / `pnpm build` / `pnpm start` |
| 迁移 | `pnpm db:generate` / `pnpm db:migrate` |
| 预检 (Coder 自检) | `bash scripts/pre_review.sh` |

## 启动

开发模式只用 Docker Compose（编排）启动 PostgreSQL（数据库）+ Redis（缓存）,
TS Core（TypeScript 核心）在本机 Node.js（运行时）中运行:

```bash
./dev-infra.sh
cd ts-core
pnpm install
set -a && source .env && set +a
pnpm dev
```

需要同一终端停在 TS Core（TypeScript 核心）日志输出上时:

```bash
./dev-infra.sh run
```

验收模式从仓库根目录使用 Docker Compose（编排）启动 app（应用）+
PostgreSQL（数据库）+ Redis（缓存）:

```bash
./start-ts-core.sh
./stop-ts-core.sh
```

Compose 配置位于仓库根目录 `compose.yaml`。env 文件固定为 `ts-core/.env`,
脚本通过 `docker compose --env-file ./ts-core/.env -f compose.yaml ...` 加载;
如文件不存在,启动脚本会从 `ts-core/.env.example` 创建。

纯本地直跑(不使用 Docker（容器）infra（基础设施）时自行准备 PostgreSQL（数据库）/ Redis（缓存）):

```bash
cp .env.example .env       # 编辑 .env
set -a && source .env && set +a
pnpm install
pnpm dev                   # 或: pnpm build && pnpm start
```

启动日志按序打印:PostgreSQL / Redis 就绪 → Fastify 监听地址 → Mineflayer 上线用户名 → ConversationWorker 消费的 `msg:{botId}` 队列。

## 核心环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `TS_CORE_BOT_ID` | Bot 标识 | `local-bot` |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` | PostgreSQL | `127.0.0.1` / `5432` / `ts_core` / ... |
| `REDIS_URL` | Redis | `redis://127.0.0.1:6379` |
| `MC_HOST` / `MC_PORT` / `MC_USERNAME` / `MC_VERSION` | MC 连接 | `127.0.0.1` / `25565` / `test_bot01` / `1.20.4` |
| `MC_EXTERNAL_AUTH_REQUIRED` / `MC_EXTERNAL_AUTH_SECRET` | EasyAuth | `true` / `<secret>` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | LLM 网关 | `http://127.0.0.1:8045/v1` / `sk-local-dev` / `bl-auto` |
| `SERVER_BRIDGE_ACCESS_TOKEN` | Fabric 桥接 token (设置后启用) | `<token>` |
| `SERVER_BRIDGE_PATH` | WS 路径 (默认 `/ws/server-bridge`) | |
| `SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS` | 心跳超时毫秒 (默认 90000) | |
| `SERVER_BRIDGE_CONVERSATION_ENABLED` | 玩家消息进对话队列 (默认 false) | `true` |

密钥不入仓。`.env.example` 仅作样例。

## 闲聊手测

```bash
curl -X POST http://127.0.0.1:3000/api/message \
  -H 'content-type: application/json' \
  -d '{"bot_id":"local-bot","message_id":"msg-1","content":"今天过得怎么样"}'
```

预期:控制台输出 LLM 调用摘要,游戏内 Bot 回复聊天栏。

## Server Bridge 实服烟测

Fabric mod 启动:
```bash
java \
  -Dmcservant.bridge.enabled=true \
  -Dmcservant.bridge.url=ws://127.0.0.1:3000/ws/server-bridge \
  -Dmcservant.bridge.accessToken=<token> \
  -Dmcservant.bridge.heartbeatSeconds=2 \
  -Dmcservant.bridge.instanceId=local-fabric-01 \
  -jar fabric-server-launch.jar nogui
```

游戏内 `/svs hello` → `curl 'http://127.0.0.1:3000/api/replay?bot_id=local-bot&after_seq=0&limit=10'` 应见 `server_bridge.player_message`。
开 `SERVER_BRIDGE_CONVERSATION_ENABLED=true` 后还有 `task.accepted` + `chat.reply`,Bot 在游戏内回复。

token 不会出现在 ack / error / replay / 日志中。`/login <secret>` 在公开状态显示为 `/login <redacted>`。

## 失败排查速查

| 现象 | 检查 |
|---|---|
| 握手被拒 | `SERVER_BRIDGE_ACCESS_TOKEN` 与 mod `mcservant.bridge.accessToken` 一致 |
| 协议版本不匹配 (`PROTOCOL_INCOMPATIBLE`) | 升级 TS Core 或 mod 后重启 |
| 心跳超时 | replay 出现 `server_bridge.heartbeat_timeout`,mod 自动按退避重连 |
| EasyAuth 登录失败 | `MC_EXTERNAL_AUTH_SECRET` 是否正确 |
| `world_ready=false` | MC 服务端是否允许该用户名进入世界 |
| 启动期 PostgreSQL/Redis 失败 | 端口、密码、容器状态 |

## 数据库迁移

1. 准备 `PG_*` 环境变量
2. 生成 migration:`pnpm db:generate`
3. 执行 migration:`pnpm db:migrate`

`drizzle.config.ts` 与 `src/db/migrate.ts` 复用运行时同一份 PostgreSQL 配置解析。

## 容器

```bash
cd ..
docker compose --env-file ./ts-core/.env -f compose.yaml config
docker compose --env-file ./ts-core/.env -f compose.yaml up -d postgres redis
docker compose --env-file ./ts-core/.env -f compose.yaml up -d --build
```

根目录 Compose（编排）支持两种入口:`./dev-infra.sh` 只启动 PostgreSQL（数据库）+
Redis（缓存）,本地用 `pnpm dev` 跑 TS Core（TypeScript 核心）;
`./dev-infra.sh run` 会前台运行本地 TS Core（TypeScript 核心）并持续输出日志;
`./start-ts-core.sh`
启动 app（应用）+ PostgreSQL（数据库）+ Redis（缓存）,用于全 Docker（容器）
验收。MC 服务端仍由宿主机裸跑,
启动脚本只探活 `MC_HOST:MC_PORT` 并打印提示,不纳入 Compose。
