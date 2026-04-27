# MCServant Fabric mod 构建指南

## 平台 & 工具链

- **目标 MC 版本**：1.20.4
- **Java**：17（Fabric Loom 1.6-SNAPSHOT，当前解析为 1.6.12 + JDK 17 工具链；MC 1.20.4 服务端运行也要求 Java 17）
- **构建工具**：Gradle Wrapper 8.7 + Fabric Loom 1.6-SNAPSHOT（当前解析为 1.6.12）
- **依赖锁定来源**：`gradle.properties`（与 `ts-core/Docs/01_ARCHITECTURE.md` §2.6.1 一致）

## 快速编译

```bash
cd plugin
./gradlew build
```

仓库已提交 Gradle Wrapper（`gradlew` / `gradlew.bat` / `gradle/wrapper/**`），验收与本地复测统一使用：

```bash
cd plugin
./gradlew build
```

## 输出产物

构建成功后，最终 mod jar 位于：

```
plugin/build/libs/mcservant-0.4.0.jar
```

同目录还会产出 `mcservant-0.4.0-sources.jar`（源码包，可选）。

## 部署到 Fabric 服务器

```bash
cp plugin/build/libs/mcservant-0.4.0.jar /path/to/server/mods/
```

重启 Fabric 服务端（不能 `/reload`，Fabric 不支持热重载 mod）。日志应出现：

```
[MCServant] Fabric mod 已加载 — 服务端桥接就绪 (T-040)
[MCServant] /svs 命令已注册（权限节点 mcservant.svs.use / op level 2）
```

## 本地 WebSocket 联调

桥接默认 `enabled=false`（禁用），未显式配置时不会连接 TS Core（TypeScript 单核心）或本地假服务。先在仓库根目录启动本地 WebSocket（全双工通信协议）调试服务：

```bash
python3 plugin/scripts/ws-debug-server.py
```

脚本默认监听：

```
ws://127.0.0.1:8765/ws/server-bridge
```

再启动 Fabric（模组加载器）服务端，并通过 system property（系统属性）启用桥接：

```bash
java \
  -Dmcservant.bridge.enabled=true \
  -Dmcservant.bridge.url=ws://127.0.0.1:8765/ws/server-bridge \
  -Dmcservant.bridge.accessToken=local-dev-token \
  -Dmcservant.bridge.heartbeatSeconds=2 \
  -Dmcservant.bridge.instanceId=local-fabric-01 \
  -jar fabric-server-launch.jar nogui
```

也可以用 environment variable（环境变量）覆盖：

```bash
MCSERVANT_BRIDGE_ENABLED=true \
MCSERVANT_BRIDGE_URL=ws://127.0.0.1:8765/ws/server-bridge \
MCSERVANT_BRIDGE_ACCESS_TOKEN=local-dev-token \
MCSERVANT_BRIDGE_HEARTBEAT_SECONDS=2 \
MCSERVANT_BRIDGE_INSTANCE_ID=local-fabric-01 \
java -jar fabric-server-launch.jar nogui
```

预期调试服务输出包含：

```text
[bridge-debug] authorization_present=True
[bridge-debug] frame type=hello body={...}
[bridge-debug] frame type=heartbeat body={...}
```

T-041 起 mod ↔ TS Core 双端最小闭环可直接对接 TS Core `/ws/server-bridge` 真实接收端。
T-042 起默认 `pnpm start`（启动命令） 可通过 `SERVER_BRIDGE_ACCESS_TOKEN`（服务端桥接访问令牌） 直接启用接收端，
无需 `ws-debug-server.py`：TS Core 侧 `SERVER_BRIDGE_ACCESS_TOKEN` 与 mod 端 `mcservant.bridge.accessToken` 必须完全一致，
mod 启动后即可看到 `hello` / `heartbeat` 进入 `/api/replay` 的 `server_bridge.*` 事件流。

游戏内执行 `/svs hello`（op 或 `mcservant.svs.use` 权限）后，TS Core 侧 `/api/replay`
应出现 `server_bridge.player_message` 事件；脚本侧若仍接 `ws-debug-server.py`，
会看到 `[bridge-debug] frame type=player_message body={...}` 输出。

`access token`（访问令牌）不会出现在 mod（模组）普通日志、联调脚本输出或 JSON（结构化文本）消息体中；脚本只打印是否收到 `Authorization`（授权）请求头。

## 服务器侧前置依赖

`mods/` 目录中必须同时存在：

- `fabric-api-0.97.3+1.20.4.jar`（或更高同 MC 版本兼容版）
- 可选：`fabric-permissions-api-v0-0.3.1.jar`（如需 LuckPerms 集成；不装则自动回退 op 等级）

如缺少 `fabric-api`，Fabric Loader 会因 `fabric.mod.json` 中的 `depends.fabric-api` 拒绝加载本 mod。

## 常见排错

- **`./gradlew` 提示找不到 wrapper jar**：确认 `plugin/gradle/wrapper/gradle-wrapper.jar` 已随仓库同步。
- **`Could not resolve net.fabricmc.fabric-api:fabric-api`**：检查 Maven 镜像 / 网络代理；`build.gradle` 已声明 `https://maven.fabricmc.net/`。
- **运行时 `NoClassDefFoundError: okhttp3/...` / `okio/...` / `kotlin/...`**：确认构建产物为 Loom（Fabric 构建插件） `include`（嵌入） 处理后的 `mcservant-*.jar`，而不是 `dev` jar（开发产物）；OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库） 运行时依赖应同时嵌入。
- **未看到联调服务连接**：确认启动 Fabric（模组加载器）服务端时已显式设置 `mcservant.bridge.enabled=true` 或 `MCSERVANT_BRIDGE_ENABLED=true`，默认禁用策略不会自动连接。
- **只看到 hello（握手）没有 heartbeat（心跳）**：把 `mcservant.bridge.heartbeatSeconds` 或 `MCSERVANT_BRIDGE_HEARTBEAT_SECONDS` 临时设为 `2`，等待至少一个心跳周期。
- **连接失败或握手失败**：先确认 `python3 plugin/scripts/ws-debug-server.py` 已监听目标地址，再检查 `mcservant.bridge.url` / `MCSERVANT_BRIDGE_URL` 是否与脚本输出一致。

---

*最后更新：2026-04-27（T-042 Server Bridge 默认入口装配：`pnpm start` + `/svs` 实服烟测）*
