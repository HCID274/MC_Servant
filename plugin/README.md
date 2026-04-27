# MCServant — Fabric 服务端桥接 mod

本目录是 TS Core 的 Minecraft 服务端 mod 源码，目标平台为 **Fabric Loader 0.15.x+ / Fabric API 0.97.3+1.20.4 / MC 1.20.4 / Java 17**。历史 Paper / Bukkit / CommandAPI / DecentHolograms / AuthMe 入口已在 T-039 中全部移除，与生产服务器实际加载器（Fabric）保持一致。

## 🎯 mod 职责（Phase 1 范围）

- 在 Fabric 服务端启动时加载并输出可观测日志，证明 mod 已生效。
- 提供 `ServerBridgeTransport`（服务端桥接传输）接口与 OkHttp（网络客户端）实现，作为 mod（模组） 与 TS Core（TypeScript 单核心） 通信的统一出入口。业务代码只能依赖该接口，OkHttp（网络客户端） 细节被实现类封死。
- 提供 `ServerBridgeConfig`（桥接配置）模型，含 `enabled`（启用） / `url`（地址） / `accessToken`（访问令牌） / `heartbeatIntervalSeconds`（心跳间隔秒数） 等字段；默认 `enabled=false`（禁用），禁止未配置时误连。
- WebSocket（全双工通信协议） 打开后发送应用层 `hello`（握手）帧，并按配置周期发送 `heartbeat`（心跳）帧；`access token`（访问令牌） 只进入 `Authorization`（授权）请求头，不进入消息体或普通日志。
- 注册 `/svs <message>`（服务端女仆命令）：将玩家原始消息封装为 `player_message`（玩家消息）协议帧并通过 `ServerBridgeTransport` 发送；权限优先用 `fabric-permissions-api`（节点 `mcservant.svs.use`），缺席时回退原版 op level 2。

T-041（任务四十一） 已交付 mod ↔ TS Core 双端最小闭环（含 `/svs` 与 TS Core `/ws/server-bridge` 接收端）；T-042（任务四十二） 已让 TS Core 默认 `pnpm start`（启动命令） 可通过 `SERVER_BRIDGE_ACCESS_TOKEN`（服务端桥接访问令牌） 直接启用接收端，并复用 EasyAuth（离线服认证模组） `/login <secret>`（登录命令） 在线手测口径。稳定性补强与 LLM（大语言模型） 主线接入留给 T-043 / T-044。

## 🔧 技术栈

- **Java 17**
- **Fabric Loader** 0.15.7
- **Fabric API** `0.97.3+1.20.4`（事件、命令、网络等）
- **fabric-permissions-api** 0.3.1（LuckPerms 软依赖；自动回退原版 op 等级判定）
- **OkHttp** 4.12.0（mod（模组） → TS Core（TypeScript 单核心） 外部 WebSocket（全双工通信协议）；OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库） 运行时依赖均由 Loom（Fabric 构建插件） `include`（嵌入） 机制打包进 mod jar（模组产物））
- **Gradle Wrapper** 8.7 + **Fabric Loom** 1.6-SNAPSHOT（当前解析为 1.6.12，构建工具链）

## 🏗️ 关键源码

- `com.mcservant.MCServantMod` — Fabric mod 入口（`DedicatedServerModInitializer`），仅服务端加载；负责装配桥接与注册 `/svs` 命令。
- `com.mcservant.bridge.ServerBridgeTransport` — 桥接传输接口（连接 / 断开 / 发送 / 状态查询 / `sendPlayerMessage`）。
- `com.mcservant.bridge.OkHttpServerBridgeTransport` — OkHttp（网络客户端） WebSocket（全双工通信协议）实现，负责 `hello`（握手）/ `heartbeat`（心跳）/ `player_message`（玩家消息）三类协议帧。
- `com.mcservant.bridge.ServerBridgeConfig` — 桥接配置 record（记录类型），提供本地默认值与 runtime（运行时）覆盖读取。
- `com.mcservant.command.SvsCommand` — `/svs <message>`（服务端女仆命令）注册器，使用 Fabric API（命令）+ Brigadier（命令库）+ fabric-permissions-api（权限接口）。
- `plugin/scripts/ws-debug-server.py` — 本地 WebSocket（全双工通信协议）联调假服务，只用于观察 mod（模组）侧帧；T-041 起 TS Core 也提供真实 `/ws/server-bridge` 接收端（见 `ts-core/README.md`）。

## 🔌 桥接配置

桥接默认禁用。启用时可用 system property（系统属性）或 environment variable（环境变量）覆盖；system property（系统属性）优先级更高。

| 含义 | system property（系统属性） | environment variable（环境变量） | 默认值 |
|---|---|---|---|
| 是否启用 | `mcservant.bridge.enabled` | `MCSERVANT_BRIDGE_ENABLED` | `false` |
| WebSocket（全双工通信协议）地址 | `mcservant.bridge.url` | `MCSERVANT_BRIDGE_URL` | `ws://127.0.0.1:8765/ws/server-bridge` |
| access token（访问令牌） | `mcservant.bridge.accessToken` | `MCSERVANT_BRIDGE_ACCESS_TOKEN` | `REPLACE_WITH_LOCAL_DEV_TOKEN` |
| heartbeat（心跳）秒数 | `mcservant.bridge.heartbeatSeconds` | `MCSERVANT_BRIDGE_HEARTBEAT_SECONDS` | `30` |
| 本地实例标识 | `mcservant.bridge.instanceId` | `MCSERVANT_BRIDGE_INSTANCE_ID` | `local-dev` |

本地联调示例：

```bash
python3 plugin/scripts/ws-debug-server.py
```

另一个终端启动 Fabric（模组加载器）服务端时加入：

```bash
java \
  -Dmcservant.bridge.enabled=true \
  -Dmcservant.bridge.url=ws://127.0.0.1:8765/ws/server-bridge \
  -Dmcservant.bridge.accessToken=local-dev-token \
  -Dmcservant.bridge.heartbeatSeconds=2 \
  -Dmcservant.bridge.instanceId=local-fabric-01 \
  -jar fabric-server-launch.jar nogui
```

假服务日志应能看到 `hello`（握手）和至少一次 `heartbeat`（心跳）帧，并对每帧返回最小 `ack`（确认）帧。脚本只打印 `Authorization`（授权）是否存在，不打印 `access token`（访问令牌）值。

如需对接真实 TS Core 接收端：在 TS Core 侧设置 `SERVER_BRIDGE_ACCESS_TOKEN=<local-bridge-token>` 并运行 `pnpm build && pnpm start`，再将 `mcservant.bridge.url` 指向 TS Core 启动后暴露的 `ws://<host>:<port>/ws/server-bridge`，`mcservant.bridge.accessToken` 与 TS Core 注入的 token（令牌） 必须完全一致。

## 🎮 `/svs` 命令最短手测

1. 在游戏内以 op 身份（或被 `mcservant.svs.use` 授权的玩家）执行 `/svs hello`。
2. 桥接已连接：聊天框收到灰色提示 `[svs] 已转发到 TS Core`，TS Core 侧 `/api/replay` 出现 `server_bridge.player_message` 事件。
3. 桥接未连接：聊天框收到红色错误 `[svs] 桥接未连接，TS Core 无法接收消息`，无任何帧外发，无 replay（补拉） 事件写入。
4. 普通玩家执行：聊天框收到红色 `[svs] 没有权限使用此命令`，不会触发 player_message 帧。

## ⚙️ 编译

构建命令（见 `BUILD.md` 详细说明）：

```bash
cd plugin
./gradlew build
```

构建产物位于 `plugin/build/libs/mcservant-0.4.0.jar`。

## 🚀 部署

把构建产物复制到生产 Fabric 服务端的 `mods/` 目录（与 fabric-api / fabric-permissions-api 等同级）。重启服务端，应在日志中看到：

```
[MCServant] Fabric mod 已加载 — 服务端桥接就绪 (T-040)
```

## ⚠️ 选型硬约束

- 严禁把 `fabric-networking-api-v1` 误用为 mod ↔ TS Core 外部进程通信通道。该 API 仅用于 MC 客户端 ↔ MC 服务端自定义 packet。
- 业务代码不得直接 import OkHttp / Netty 等具体实现类，必须经过 `ServerBridgeTransport` 接口。
- 默认配置只能使用本地开发占位值，禁止把真实密钥或生产地址写入仓库。
