# TS Core

TS Core 是当前主线的 TypeScript 单核心工程骨架。

当前仓库已经提供一个最小本地在线入口：`src/main.ts`（可执行入口） 会启动真实 Redis（缓存） / PostgreSQL（关系型数据库） / BullMQ（任务队列） / Fastify（接口网关） / Mineflayer（Minecraft 协议客户端），并通过 ConversationWorker（对话工作线程） 把 `POST /api/message`（消息提交接口） 的文本回复写入 Minecraft（我的世界） 聊天频道。若已配置 `LLM_BASE_URL`（大语言模型基础地址） / `LLM_API_KEY`（接口密钥） / `LLM_MODEL`（模型名），普通闲聊会走一次真实 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 调用。

同时，默认入口已经支持通过 `SERVER_BRIDGE_*`（服务端桥接） 环境变量启用 `/ws/server-bridge`（服务端桥接 WebSocket），用于 Fabric mod（Fabric 模组） `/svs`（服务端女仆命令） 到 TS Core（TypeScript 单核心） `/api/replay`（补拉接口） 的实服烟测；显式设置 `SERVER_BRIDGE_CONVERSATION_ENABLED=true`（服务端桥接对话启用） 后，`/svs` 玩家消息会进入 ConversationWorker（对话工作线程） 主链路并通过 BotActor（机器人执行代理） 写回 MC（Minecraft，我的世界） 聊天。仓库也提供可被后续消息链路复用的真实 PostgreSQL（关系型数据库） / Redis（缓存） 资源工厂、BullMQ（任务队列） 三队列运行时工厂、Fastify（接口网关） 服务器骨架，以及 Drizzle（数据库工具） migration（迁移） 执行入口。

## 开发命令

- 安装依赖：`pnpm install`
- 类型检查：`pnpm typecheck`
- lint：`pnpm lint`
- 格式化：`pnpm format`
- 测试：`pnpm test`
- 开发：`pnpm dev`
- 构建：`pnpm build`
- 运行构建产物：`pnpm start`
- 生成迁移：`pnpm db:generate`
- 执行迁移：`pnpm db:migrate`
- 预检：`bash scripts/pre_review.sh`

## 当前范围

- 提供单进程、单容器的最小在线启动入口与纯装配摘要。
- 已包含 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂、统一关闭边界和 Drizzle（数据库工具） migration（迁移） 入口。
- 默认入口会自动启动 HTTP（超文本传输协议） / BullMQ（任务队列） / Mineflayer（Minecraft 协议客户端） / ConversationWorker（对话工作线程） / BotWorker（机器人工作线程） 最窄链路。
- 普通闲聊已支持最小 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 回包；确定性 `goTo`（前往坐标） 命令仍优先直达执行队列。

## 最小本地启动

1. 复制样例环境变量：参考 `.env.example`（环境变量样例） 准备本地 `.env`（环境变量文件）。
2. 将环境变量导入当前 `shell`（命令行）：`set -a && source .env && set +a`
3. 安装依赖：`pnpm install`
4. 开发态查看启动摘要：`pnpm dev`
5. 构建后运行：`pnpm build && pnpm start`

启动后会打印：

- PostgreSQL（关系型数据库） / Redis（缓存） 基础设施就绪日志
- Fastify（接口网关） 监听地址
- Mineflayer（Minecraft 协议客户端） 上线用户名
- ConversationWorker（对话工作线程） 消费的 `msg:{botId}` 队列

默认会读取 `TS_CORE_BOT_ID`（机器人标识），未设置时回退到 `local-bot`。

## Server Bridge（服务端桥接） 长期运行联调（T-044）

- TS Core 端在 `interfaces/server-bridge`（服务端桥接接口） 内提供 `registerServerBridgeWsRoute`（路由注册），可挂在已有 Fastify（接口网关） 实例上，端点固定为 `/ws/server-bridge`。
- token（令牌） 必须由调用方注入；缺失或不匹配的 `Authorization: Bearer`（授权头） 请求会在握手阶段被 401 拒绝，不会进入消息处理流程，也不会写入 replay（补拉） 事件。
- 默认 `src/main.ts`（可执行入口） 已支持环境变量装配：设置 `SERVER_BRIDGE_ACCESS_TOKEN`（访问令牌） 后自动启用；设置 `SERVER_BRIDGE_ENABLED=false`（禁用） 后强制关闭；设置 `SERVER_BRIDGE_ENABLED=true`（启用） 但缺少 token（令牌） 会启动失败。
- 可选 `SERVER_BRIDGE_PATH`（服务端桥接路径） 默认是 `/ws/server-bridge`。
- 可选 `SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS`（心跳超时毫秒数） 默认是 `90000`，超时后会关闭连接并写入 `server_bridge.heartbeat_timeout`（服务端桥接心跳超时） 与 `server_bridge.disconnected`（服务端桥接断开） 诊断事件。
- 可选 `SERVER_BRIDGE_CONVERSATION_ENABLED`（服务端桥接对话启用） 默认是 `false`：默认只写 `server_bridge.player_message`（服务端桥接玩家消息） 到 replay（补拉）；显式 `true` 时只把 `player_message`（玩家消息） 入 `msg:{botId}`（消息队列），`hello`（握手）/ `heartbeat`（心跳）/ lifecycle（生命周期） 诊断不会入队。
- 启动入口 `startAppOnlineRuntime` 仍支持 `dependencies.serverBridge` 注入：传入 `{ accessToken: "...", path?: "...", heartbeatTimeoutMs?: 90000, conversationEnabled?: true|false, enabled?: true|false }` 后，hello / heartbeat / player_message 帧会按 `server_bridge.<type>` 写入 `/api/replay`（补拉接口）；`conversationEnabled=true` 时额外写入 `task.accepted`（任务已接受） 诊断并进入 ConversationWorker（对话工作线程）。任何 `access token`（访问令牌） 都不会出现在 ack（确认） / error（错误） 帧、replay（补拉） 事件或日志中。
- mod 端 `/svs <message>` 与 TS Core 端联调步骤：mod 启动时配置 `mcservant.bridge.url=ws://<ts-core-host>:<port>/ws/server-bridge` 与 `mcservant.bridge.accessToken=<同 TS Core 注入值>`；游戏内执行 `/svs hello` 后，默认 TS Core `/api/replay` 应出现 `server_bridge.player_message` 事件；若同时启用 `SERVER_BRIDGE_CONVERSATION_ENABLED=true` 与 `LLM_*`（大语言模型配置），还应出现 `task.accepted`（任务已接受） 与 `chat.reply`（聊天回复），且游戏内能看到 Bot（机器人） 回复。
- 协议策略：连接后必须先收到 `hello`（握手），再接受 `heartbeat`（心跳） 与 `player_message`（玩家消息）；重复 `hello`（握手）会返回 `duplicate_hello`（重复握手），重复 `message_id`（消息标识）会返回 `duplicate_message_id`（重复消息标识），协议版本不匹配会返回 `protocol_version_mismatch`（协议版本不匹配） 并关闭连接。

## MC 实服烟测：Server Bridge（服务端桥接） + EasyAuth（离线服认证模组）

TS Core（TypeScript 单核心） 最小环境变量清单：

```bash
TS_CORE_BOT_ID=local-bot
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=ts_core
PG_USER=ts_core
PG_PASSWORD=<postgres-password>
REDIS_URL=redis://127.0.0.1:6379
MC_HOST=127.0.0.1
MC_PORT=25565
MC_USERNAME=test_bot01
MC_VERSION=1.20.4
MC_EXTERNAL_AUTH_REQUIRED=true
MC_EXTERNAL_AUTH_SECRET=<bot-easyauth-password>
SERVER_BRIDGE_ACCESS_TOKEN=<local-bridge-token>
SERVER_BRIDGE_PATH=/ws/server-bridge
SERVER_BRIDGE_HEARTBEAT_TIMEOUT_MS=90000
SERVER_BRIDGE_CONVERSATION_ENABLED=true
LLM_BASE_URL=http://127.0.0.1:8045/v1
LLM_API_KEY=sk-local-dev
LLM_MODEL=bl-auto
```

Fabric mod（Fabric 模组） 启动参数清单：

```bash
java \
  -Dmcservant.bridge.enabled=true \
  -Dmcservant.bridge.url=ws://127.0.0.1:3000/ws/server-bridge \
  -Dmcservant.bridge.accessToken=<local-bridge-token> \
  -Dmcservant.bridge.heartbeatSeconds=2 \
  -Dmcservant.bridge.reconnectInitialSeconds=5 \
  -Dmcservant.bridge.reconnectMaxSeconds=60 \
  -Dmcservant.bridge.instanceId=local-fabric-01 \
  -jar fabric-server-launch.jar nogui
```

最短手测步骤：

1. 启动 PostgreSQL（关系型数据库） 与 Redis（缓存），确认 TS Core（TypeScript 单核心） `.env`（环境变量文件） 已导入当前 shell（命令行）：`set -a && source .env && set +a`。
2. 在 `ts-core/` 下运行：`pnpm build && pnpm start`。
3. 启动 Fabric server（Fabric 服务端），并使用上面的 `mcservant.bridge.*`（服务端桥接） 参数。
4. 观察 MC（Minecraft，我的世界） 服务端日志：bot（机器人） 应上线；如果 EasyAuth（离线服认证模组） 要求登录，TS Core 会通过 BotActor（机器人执行代理） 单写者路径发送 `/login <secret>`（登录命令），公开状态只显示 `/login <redacted>`（脱敏登录命令）。
5. 在游戏内用有权限的玩家执行 `/svs hello`。
6. 查询状态：`curl "http://127.0.0.1:3000/api/status?bot_id=local-bot"`。
7. 查询补拉事件：`curl "http://127.0.0.1:3000/api/replay?bot_id=local-bot&after_seq=0&limit=10"`，未设置 `SERVER_BRIDGE_CONVERSATION_ENABLED=true` 时预期只出现 `server_bridge.player_message`（服务端桥接玩家消息） 事件；启用后预期还会出现 `task.accepted`（任务已接受） 与 `chat.reply`（聊天回复），payload（载荷） 中包含 `content:"hello"` 且原始桥接事件仍保留 `runtime_effect:"observe_only"`（仅观测）。

常见失败排查：

- token（令牌） 不匹配：Fabric mod（Fabric 模组） 侧会连接失败或收到握手拒绝，TS Core（TypeScript 单核心） 不会写入 replay（补拉） 事件；检查 `SERVER_BRIDGE_ACCESS_TOKEN` 与 `mcservant.bridge.accessToken` 是否完全一致。
- TS Core（TypeScript 单核心） 重启或短断网：Fabric mod（Fabric 模组） 会进入 `RECONNECTING`（重连中） 并按 `mcservant.bridge.reconnectInitialSeconds` 到 `mcservant.bridge.reconnectMaxSeconds` 指数退避；`/svs`（服务端女仆命令） 会提示“桥接正在重连 TS Core”。
- 协议版本错误：TS Core（TypeScript 单核心） 会返回 `protocol_version_mismatch`（协议版本不匹配） 并关闭连接；Fabric mod（Fabric 模组） 会进入 `PROTOCOL_INCOMPATIBLE`（协议不兼容），需要升级 TS Core 或 mod 后重启服务端。
- 心跳超时：TS Core（TypeScript 单核心） 会在 `/api/replay`（补拉接口） 中写入 `server_bridge.heartbeat_timeout`（服务端桥接心跳超时） 与 `server_bridge.disconnected`（服务端桥接断开）；Fabric mod（Fabric 模组） 会按退避策略重连。
- EasyAuth（离线服认证模组） 密码错误：MC（Minecraft，我的世界） 侧通常会提示登录失败；检查 `MC_EXTERNAL_AUTH_SECRET`，TS Core 日志与 `/api/status` 不会显示明文。
- bot（机器人） 未 spawn（生成）：`/api/status` 中 `mineflayer.world_ready` 会是 `false`，世界交互技能不会放行；先看 MC 服务端是否允许该用户名进入世界。
- Redis（缓存） / PostgreSQL（关系型数据库） 不可达：`pnpm start`（启动命令） 会在基础设施阶段失败；先确认连接参数、容器端口和用户密码。

## 最小闲聊手测

1. 在 `.env`（环境变量文件） 中至少配置以下项：
   `LLM_BASE_URL=http://127.0.0.1:8045/v1`
   `LLM_API_KEY=sk-local-dev`
   `LLM_MODEL=bl-auto`
2. 启动本地 OpenAI（开放人工智能） 兼容网关、Redis（缓存）、PostgreSQL（关系型数据库） 和 Minecraft（我的世界） 服务端。
3. 运行 `pnpm build && pnpm start`。
4. 确认控制台出现：
   `TS Core LLM chat ok: model=... message_id=... log_ref=...`
5. 通过 HTTP（超文本传输协议） 发送一条普通闲聊消息：

```bash
curl -X POST http://127.0.0.1:3000/api/message \
  -H 'content-type: application/json' \
  -d '{"bot_id":"local-bot","message_id":"msg-demo-chat","content":"今天过得怎么样"}'
```

6. 预期结果：
   - `ConversationWorker`（对话工作线程） 会调用一次真实 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全）；
   - 控制台会输出一条 `LLM`（大语言模型） 诊断摘要；
   - Minecraft（我的世界） 游戏内能看到机器人把闲聊回复发回聊天栏。

## Minecraft 连接环境变量

- `MC_HOST`：Minecraft（我的世界） 服务器地址，默认 `localhost`
- `MC_PORT`：Minecraft（我的世界） 服务器端口，默认 `25565`
- `MC_USERNAME`：Mineflayer（Minecraft 协议客户端） 登录用户名，默认使用 `TS_CORE_BOT_ID`
- `MC_VERSION`：可选协议版本，留空由 Mineflayer（Minecraft 协议客户端） 自动处理
- `MC_AUTH`：可选认证模式，留空由 Mineflayer（Minecraft 协议客户端） 默认处理

## 外部认证环境变量

- `MC_EXTERNAL_AUTH_REQUIRED`：是否要求外部认证，默认 `false`
- `MC_EXTERNAL_AUTH_ENTRYPOINT`：受控认证入口，当前只支持 `game_chat_command`
- `MC_EXTERNAL_AUTH_SECRET`：部署时注入的认证明文密钥，不要写入真实值

## 容器骨架

项目已包含 `Dockerfile`（容器镜像构建文件） 与 `.dockerignore`（容器忽略文件），镜像只构建并运行 `ts-core`（TypeScript 单核心） 自身，不打包 Redis（缓存）、PostgreSQL（关系型数据库）、Minecraft（我的世界） 服务端或外部认证库文件。

常用命令：

- 构建镜像：`docker build -t ts-core-local .`
- 运行镜像：`docker run --rm --env-file .env.example ts-core-local`

当前容器启动后会尝试连接 `.env`（环境变量文件） 指定的 PostgreSQL（关系型数据库） / Redis（缓存） / Minecraft（我的世界） 服务器，并开放 HTTP（超文本传输协议） 端口。

## 数据库迁移

1. 准备 PostgreSQL（关系型数据库） 相关环境变量：`PG_HOST`、`PG_PORT`、`PG_DATABASE`、`PG_USER`、`PG_PASSWORD`
2. 生成 migration（迁移） 文件：`pnpm db:generate`
3. 执行 migration（迁移）：`pnpm db:migrate`

`drizzle.config.ts`（迁移配置） 与 `src/db/migrate.ts`（迁移执行入口） 会复用和运行时装配相同的 PostgreSQL（关系型数据库） 配置解析逻辑，避免命令行与应用侧各自维护一套连接参数。
