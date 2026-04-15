# TS Core

TS Core 是当前主线的 TypeScript 单核心工程骨架。

当前仓库已经提供一个最小本地启动骨架：`src/main.ts`（可执行入口） 只消费纯 `app`（应用装配） 结果，输出可读的启动摘要，不自动连接真实 Redis（缓存） / PostgreSQL（关系型数据库） / BullMQ（任务队列） / Fastify（接口网关） / Socket.io（实时推送） / Mineflayer（Minecraft 协议客户端）。

同时，仓库现在已经提供可被后续消息链路复用的真实 PostgreSQL（关系型数据库） / Redis（缓存） 资源工厂、BullMQ（任务队列） 三队列运行时工厂、Fastify（接口网关） 服务器骨架，以及 Drizzle（数据库工具） migration（迁移） 执行入口；默认启动摘要仍不会主动连接这些外部资源。

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

- 提供单进程、单容器的最小启动骨架与纯装配摘要。
- 已包含 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂、统一关闭边界和 Drizzle（数据库工具） migration（迁移） 入口。
- 默认入口仍不自动启动 HTTP（超文本传输协议） / BullMQ（任务队列） / Mineflayer（Minecraft 协议客户端）；这些真实运行时句柄需通过 `app`（应用装配） 层的组合工厂显式创建。

## 最小本地启动

1. 复制样例环境变量：参考 `.env.example`（环境变量样例） 准备本地 `.env`（环境变量文件） 或直接导出环境变量。
2. 安装依赖：`pnpm install`
3. 开发态查看启动摘要：`pnpm dev`
4. 构建后运行：`pnpm build && pnpm start`

启动后会打印：

- `INITIALIZING`（初始化） 初始状态
- `external_auth`（外部认证） 装配结果
- 启动 / 关闭阶段顺序
- 当前仍处于 `bootstrap_only`（仅装配摘要） 边界，未连接真实 IO（输入输出）

默认会读取 `TS_CORE_BOT_ID`（机器人标识），未设置时回退到 `local-bot`。

## 外部认证环境变量

- `MC_EXTERNAL_AUTH_REQUIRED`：是否要求外部认证，默认 `false`
- `MC_EXTERNAL_AUTH_ENTRYPOINT`：受控认证入口，当前只支持 `game_chat_command`
- `MC_EXTERNAL_AUTH_SECRET`：部署时注入的认证明文密钥，不要写入真实值

## 容器骨架

项目已包含 `Dockerfile`（容器镜像构建文件） 与 `.dockerignore`（容器忽略文件），镜像只构建并运行 `ts-core`（TypeScript 单核心） 自身，不打包 Redis（缓存）、PostgreSQL（关系型数据库）、Minecraft（我的世界） 服务端或外部认证库文件。

常用命令：

- 构建镜像：`docker build -t ts-core-local .`
- 运行镜像：`docker run --rm --env-file .env.example ts-core-local`

当前容器启动后同样只输出启动摘要，不开放真实 HTTP（超文本传输协议） / Socket.io（实时推送） 端口。

## 数据库迁移

1. 准备 PostgreSQL（关系型数据库） 相关环境变量：`PG_HOST`、`PG_PORT`、`PG_DATABASE`、`PG_USER`、`PG_PASSWORD`
2. 生成 migration（迁移） 文件：`pnpm db:generate`
3. 执行 migration（迁移）：`pnpm db:migrate`

`drizzle.config.ts`（迁移配置） 与 `src/db/migrate.ts`（迁移执行入口） 会复用和运行时装配相同的 PostgreSQL（关系型数据库） 配置解析逻辑，避免命令行与应用侧各自维护一套连接参数。
