# 当前任务握手区

【任务序号】: T-040
【当前状态】: 待开发

---

## 任务目标

T-040（任务四十） 启动 T-Fabric-Bridge-02（Fabric 服务端桥接第二步）：在 T-039（任务三十九） 已完成的 Fabric mod（Fabric 模组）工程基线上，补齐 OkHttp（网络客户端）真实 WebSocket（全双工通信协议）连接、应用层 handshake（握手）、heartbeat（心跳）与本地联调脚本。

本任务只推进 `plugin/`（服务端插件源码）侧桥接传输可联调能力，不实现 TS Core（TypeScript 单核心）正式 `server-bridge`（服务端桥接）接收服务，不实现 `/svs`（游戏命令）体系，不把 Java（编程语言）侧 OkHttp（网络客户端）细节泄漏到 TS Core（TypeScript 单核心）代码。

---

## 上下文说明

- T-039（任务三十九） 已通过：`plugin/`（服务端插件源码） 已从 Paper（服务端插件平台） / Maven（构建工具）切换为 Fabric Loom（Fabric 构建插件）工程，最终 `mcservant-0.4.0.jar`（模组产物） 能构建，并已嵌入 OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库）运行时依赖。
- `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节已锁定：
  - mod（模组）到 TS Core（TypeScript 单核心）的外部通信使用 OkHttp（网络客户端） WebSocket（全双工通信协议）。
  - OkHttp（网络客户端）必须封装在 `ServerBridgeTransport`（服务端桥接传输）接口之后。
  - `fabric-networking-api-v1`（Fabric 内部网络接口）只允许用于 MC（Minecraft，我的世界）客户端 ↔ MC 服务端 packet（数据包），严禁用于 mod（模组） ↔ TS Core（TypeScript 单核心）外部进程通信。
- 本任务的联调脚本只承担本地假服务端职责，用于验证 Fabric mod（Fabric 模组）侧发送的握手 / 心跳帧格式与连接生命周期；它不是 TS Core（TypeScript 单核心）正式实现。
- 本任务不触碰 LLM（大语言模型）链路，因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 2.6.1 节
- `ts-core/src/interfaces/server-bridge/contracts.ts`（只读参考现有 TS Core（TypeScript 单核心）桥接事件边界，不允许修改）
- `plugin/settings.gradle`
- `plugin/build.gradle`
- `plugin/gradle.properties`
- `plugin/src/main/resources/fabric.mod.json`
- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/**`
- `plugin/README.md`
- `plugin/BUILD.md`

Coder（编码代理） 本轮允许新增 / 修改：

- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/**`
- `plugin/src/main/resources/fabric.mod.json`（仅当需要补说明性元信息；不得引入无关依赖）
- `plugin/build.gradle`、`plugin/gradle.properties`（仅当测试或脚本确需补最小依赖 / 版本字段）
- `plugin/src/test/java/com/mcservant/bridge/**`（可选，用于 Java（编程语言）侧纯逻辑测试）
- `plugin/scripts/**`（允许新增本地 WebSocket（全双工通信协议）联调脚本）
- `plugin/README.md`
- `plugin/BUILD.md`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `ts-core/src/**`
- `ts-core/package.json`
- `ts-core/pnpm-lock.yaml`
- `AGENTS.md`
- `backend/**`
- `docs/legacy-*.md`
- 任何真实密钥、生产地址或个人本地路径。

---

## 核心逻辑要求

1. `OkHttpServerBridgeTransport`（OkHttp 桥接传输）必须在 WebSocket（全双工通信协议） `onOpen`（打开）后发送明确的应用层 `hello`（握手）JSON（结构化文本）帧，至少包含协议版本、mod（模组）标识、mod 版本、连接时间戳和本地实例标识；不得把 access token（访问令牌）写入消息体或日志。
2. 传输层必须实现应用层 heartbeat（心跳）帧或等价可观测心跳机制；OkHttp（网络客户端）底层 `pingInterval`（探活间隔）可以保留，但不能替代协议层可审计心跳。heartbeat（心跳）失败或连接失败时必须进入清晰状态并输出脱敏日志。
3. 新增本地 WebSocket（全双工通信协议）联调脚本，能接收连接、打印收到的 `hello`（握手）和 `heartbeat`（心跳）帧，并可向 mod（模组）返回最小 `ack`（确认）帧；脚本必须不依赖真实 TS Core（TypeScript 单核心）服务。
4. 桥接配置必须支持本地开发覆盖：至少能通过 system property（系统属性）或 environment variable（环境变量）启用桥接、覆盖 URL（地址）、access token（访问令牌）和 heartbeat interval（心跳间隔）；默认仍必须 `enabled=false`（禁用），避免未配置时误连。
5. 业务入口仍只能依赖 `ServerBridgeTransport`（服务端桥接传输）接口；不得在 `MCServantMod`（模组入口）之外扩散 OkHttp（网络客户端）具体类型，不得引入 `fabric-networking-api-v1`（Fabric 内部网络接口）做外部通信。

---

## 验收标准

1. `cd plugin && ./gradlew build --no-daemon` 必须通过，最终 mod jar（模组产物） 仍包含 OkHttp（网络客户端）运行时依赖闭包。
2. 本地联调脚本可启动，并有文档化命令能观察到 `hello`（握手）与至少一次 `heartbeat`（心跳）帧；如果当前环境无法加载真实 Fabric（模组加载器）服务端，必须提供最短人工手测步骤和预期日志。
3. access token（访问令牌）不得出现在普通日志、联调输出或异常摘要中；日志只能显示脱敏值或是否已配置。
4. `ServerBridgeTransport`（服务端桥接传输）接口边界保持稳定，OkHttp（网络客户端）细节不泄漏到 TS Core（TypeScript 单核心）源码；本任务不得修改 `ts-core/src/**`。
5. `plugin/README.md` 与 `plugin/BUILD.md` 必须同步说明桥接启用方式、本地联调脚本用法、默认禁用策略和故障排查命令。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-040（任务四十），并确认不是继续修改 T-039（任务三十九）。
- [ ] 已读取 `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节，确认 OkHttp（网络客户端）必须封装在 `ServerBridgeTransport`（服务端桥接传输）之后。
- [ ] 已实现 `hello`（握手）与 heartbeat（心跳）帧，并保证 access token（访问令牌）不进入消息体或普通日志。
- [ ] 已提供本地 WebSocket（全双工通信协议）联调脚本和最短运行说明。
- [ ] 已确认默认配置仍为 `enabled=false`（禁用），只有显式本地配置才发起连接。
- [ ] 已执行 `cd plugin && ./gradlew build --no-daemon` 并记录结果。
- [ ] 已检查最终 mod jar（模组产物） 的 `META-INF/jars/` 仍包含 OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库）运行时依赖。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过。

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

【回填序号】: T-040（任务四十）

（待 Coder（编码代理） 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-041**: T-Fabric-Bridge-03（Fabric 服务端桥接第三步） TS Core（TypeScript 单核心）端 `server-bridge`（服务端桥接） WebSocket（全双工通信协议）接收骨架、token（令牌）校验、协议解析与 replay（补拉）事件接入。
- **T-042**: T-Fabric-Bridge-04（Fabric 服务端桥接第四步） Fabric（模组加载器）端 `/svs`（游戏命令）命令体系、权限检查、玩家消息帧发送与 TS Core（TypeScript 单核心）接收端联调。
- **T-043**: T-Fabric-Bridge-05（Fabric 服务端桥接第五步） EasyAuth（离线服认证模组）只读状态适配、端到端 MC（Minecraft，我的世界）服务器实测与部署手册收口。
