# MCServant — Fabric 服务端桥接 mod

本目录是 TS Core 的 Minecraft 服务端 mod 源码，目标平台为 **Fabric Loader 0.15.x+ / Fabric API 0.97.3+1.20.4 / MC 1.20.4 / Java 17**。历史 Paper / Bukkit / CommandAPI / DecentHolograms / AuthMe 入口已在 T-039 中全部移除，与生产服务器实际加载器（Fabric）保持一致。

## 🎯 mod 职责（Phase 1 范围）

- 在 Fabric 服务端启动时加载并输出可观测日志，证明 mod 已生效。
- 提供 `ServerBridgeTransport`（服务端桥接传输）接口与 OkHttp 实现骨架，作为 mod 与 TS Core 单核心通信的统一出入口。业务代码只能依赖该接口，OkHttp 细节被实现类封死。
- 提供 `ServerBridgeConfig`（桥接配置）模型，含 `enabled` / `url` / `accessToken` / `heartbeatIntervalSeconds` 字段；默认值仅供本地开发占位，禁止写入真实密钥。

T-039 不实现真实握手、心跳、`/svs` 命令链路与 EasyAuth 对接 —— 这些由后续 T-Fabric-Bridge-02 / 03 / 04 任务交付。

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
- `com.mcservant.bridge.OkHttpServerBridgeTransport` — OkHttp WebSocket 骨架实现，业务代码不可直接 import。
- `com.mcservant.bridge.ServerBridgeConfig` — 桥接配置 record，提供 `localDevDefaults()` 占位默认值。

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
[MCServant] Fabric mod 已加载 — 服务端桥接骨架就绪 (T-039 基线)
```

## ⚠️ 选型硬约束

- 严禁把 `fabric-networking-api-v1` 误用为 mod ↔ TS Core 外部进程通信通道。该 API 仅用于 MC 客户端 ↔ MC 服务端自定义 packet。
- 业务代码不得直接 import OkHttp / Netty 等具体实现类，必须经过 `ServerBridgeTransport` 接口。
- 默认配置只能使用本地开发占位值，禁止把真实密钥或生产地址写入仓库。
