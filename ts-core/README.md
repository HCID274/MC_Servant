# TS Core

TypeScript 单核心 Minecraft Bot Agent。一主一 Bot,基础技能 + 轻面板。

主入口 `src/main.ts` 启动 Redis / PostgreSQL / BullMQ / Fastify / Mineflayer,
ConversationWorker 把 `POST /api/message` 文本回复写入 MC 聊天。
配置 `LLM_*` 后,闲聊走真实 OpenAI 兼容 `chat.completions`;
配置 `SERVER_BRIDGE_ACCESS_TOKEN` 后,启用 `/ws/server-bridge`(Fabric mod `/svs` → TS Core)。

## 命令

| 用途 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 类型检查 / lint / 测试 | `pnpm typecheck` / `pnpm lint` / `pnpm test` |
| 开发 / 构建 / 启动 | `pnpm dev` / `pnpm build` / `pnpm start` |
| 迁移 | `pnpm db:generate` / `pnpm db:migrate` |
| 预检 (Coder 自检) | `bash scripts/pre_review.sh` |

## 启动

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
docker build -t ts-core-local .
docker run --rm --env-file .env ts-core-local
```

镜像只打包 ts-core 自身,不含 PostgreSQL / Redis / MC 服务端 / EasyAuth。
