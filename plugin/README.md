# MCServant — Fabric 服务端桥接 mod

本目录是 TS Core 的 Minecraft 服务端 mod 源码，目标平台为 **Fabric Loader 0.15.x+ / Fabric API 0.97.3+1.20.4 / MC 1.20.4 / Java 17**。历史 Paper / Bukkit / CommandAPI / DecentHolograms / AuthMe 入口已在 T-039 中全部移除，与生产服务器实际加载器（Fabric）保持一致。

## 🎯 mod 职责（Phase 1 范围）

- 在 Fabric 服务端启动时加载并输出可观测日志，证明 mod 已生效。
- 提供 `ServerBridgeTransport`（服务端桥接传输）接口与 OkHttp（网络客户端）实现，作为 mod（模组） 与 TS Core（TypeScript 单核心） 通信的统一出入口。业务代码只能依赖该接口，OkHttp（网络客户端） 细节被实现类封死。
- 提供 `ServerBridgeConfig`（桥接配置）模型，含 `enabled`（启用） / `url`（地址） / `accessToken`（访问令牌） / `heartbeatIntervalSeconds`（心跳间隔秒数） 等字段；默认 `enabled=false`（禁用），禁止未配置时误连。
- WebSocket（全双工通信协议） 打开后发送应用层 `hello`（握手）帧，并按配置周期发送 `heartbeat`（心跳）帧；`access token`（访问令牌） 只进入 `Authorization`（授权）请求头，不进入消息体或普通日志。

T-040 不实现 TS Core（TypeScript 单核心） 正式 `server-bridge`（服务端桥接）接收服务、`/svs`（游戏命令）链路与 EasyAuth（离线服认证模组）对接 —— 这些由后续 T-Fabric-Bridge-03 / 04 / 05 任务交付。

## 🔧 技术栈

- **Java 17**
- **Fabric Loader** 0.15.7
- **Fabric API** `0.97.3+1.20.4`（事件、命令、网络等）
- **fabric-permissions-api** 0.3.1（LuckPerms 软依赖；自动回退原版 op 等级判定）
- **OkHttp** 4.12.0（mod（模组） → TS Core（TypeScript 单核心） 外部 WebSocket（全双工通信协议）；OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库） 运行时依赖均由 Loom（Fabric 构建插件） `include`（嵌入） 机制打包进 mod jar（模组产物））
- **Gradle Wrapper** 8.7 + **Fabric Loom** 1.6-SNAPSHOT（当前解析为 1.6.12，构建工具链）

## 🏗️ 关键源码

- `com.mcservant.MCServantMod` — Fabric mod 入口（`DedicatedServerModInitializer`），仅服务端加载。
- `com.mcservant.bridge.ServerBridgeTransport` — 桥接传输接口（连接 / 断开 / 发送 / 状态查询）。
- `com.mcservant.bridge.OkHttpServerBridgeTransport` — OkHttp（网络客户端） WebSocket（全双工通信协议）实现，负责 `hello`（握手）与 `heartbeat`（心跳）。
- `com.mcservant.bridge.ServerBridgeConfig` — 桥接配置 record（记录类型），提供本地默认值与 runtime（运行时）覆盖读取。
- `plugin/scripts/ws-debug-server.py` — 本地 WebSocket（全双工通信协议）联调假服务，只用于观察 mod（模组）侧帧。

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
