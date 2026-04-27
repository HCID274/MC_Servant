# 当前任务握手区

【任务序号】: T-041
【当前状态】: 待开发

---

## 任务目标

T-041（任务四十一） 改为模块级集成任务：完成 Server Bridge（服务端桥接）双端最小闭环，把 TS Core（TypeScript 单核心）端 `/ws/server-bridge`（服务端桥接 WebSocket）接收、Fabric（模组加载器）端 `/svs`（游戏命令）最小命令、协议帧、token（令牌）校验、`ack/error`（确认 / 错误）响应与本地联调一次性交付。

目标验收口径：本地启动 TS Core（TypeScript 单核心）接收端后，Fabric mod（Fabric 模组）能连接、完成 `hello`（握手）与 `heartbeat`（心跳）；在游戏内执行 `/svs <内容>`（服务端女仆命令） 后，TS Core（TypeScript 单核心）能收到 `player_message`（玩家消息）帧并写入 replay（补拉）事件流。

本任务不做 EasyAuth（离线服认证模组）只读状态适配，不做复杂重连 / 版本协商策略，不要求接入真实 LLM（大语言模型）回复，也不得让 Server Bridge（服务端桥接）事件绕过 conversation（对话） / workers（工作线程） / BotActor（机器人执行代理）单写者路径直接驱动 Bot（机器人）。

---

## 上下文说明

- T-039（任务三十九） 已完成 Fabric mod（Fabric 模组）工程基线，T-040（任务四十） 已完成 Fabric mod（Fabric 模组）侧 OkHttp（网络客户端） WebSocket（全双工通信协议）连接、应用层 `hello`（握手）与 `heartbeat`（心跳）。
- `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节已锁定：
  - mod（模组）到 TS Core（TypeScript 单核心）的外部通信使用 OkHttp（网络客户端） WebSocket（全双工通信协议）。
  - TS Core（TypeScript 单核心）侧只共享 JSON（结构化文本）协议形态，不得出现 Java（编程语言） / OkHttp（网络客户端）实现细节。
  - `fabric-networking-api-v1`（Fabric 内部网络接口）只允许用于 MC（Minecraft，我的世界）客户端 ↔ MC 服务端 packet（数据包），严禁用于 mod（模组） ↔ TS Core（TypeScript 单核心）外部进程通信。
- 现有 `interfaces/server-bridge/contracts.ts`（服务端桥接契约） 已声明 `runtime_effect: "observe_only"`（运行时影响：仅观测）。本任务可以新增 `player_message`（玩家消息）帧，但默认仍只进入 replay（补拉）事件流；是否转入真实对话主线由后续任务单独授权。
- 本任务不触碰 LLM（大语言模型）调用链路、Prompt（提示词）、parser（解析器） 或 online entrypoint（在线入口装配）的 LLM（大语言模型）部分，因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；但必须做真实本地 WebSocket（全双工通信协议） I/O（输入输出）联调测试。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/WF_需求变更索引.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 2.6.1 节
- `ts-core/src/interfaces/server-bridge/contracts.ts`
- `ts-core/src/interfaces/server-bridge/index.ts`
- `ts-core/src/interfaces/server.ts`
- `ts-core/src/interfaces/realtime.ts`
- `ts-core/src/interfaces/api.ts`
- `ts-core/src/interfaces/errors.ts`
- `ts-core/src/interfaces/index.ts`
- `ts-core/src/app/bootstrap/services.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/__tests__/interfaces-server-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `plugin/build.gradle`
- `plugin/gradle.properties`
- `plugin/src/main/resources/fabric.mod.json`
- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/**`
- `plugin/scripts/ws-debug-server.py`
- `plugin/README.md`
- `plugin/BUILD.md`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/src/interfaces/server-bridge/**`
- `ts-core/src/interfaces/server.ts`
- `ts-core/src/interfaces/index.ts`
- `ts-core/src/app/bootstrap/services.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/src/app/entrypoint.ts`（仅允许把 server-bridge（服务端桥接）接收端接入 replay（补拉）事件流；不得改 LLM（大语言模型）链路）
- `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`（可新增）
- `ts-core/src/__tests__/interfaces-server-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/package.json` 与 `ts-core/pnpm-lock.yaml`（仅当必须新增 `@fastify/websocket`（Fastify WebSocket 插件） 或等价最小 WebSocket（全双工通信协议）依赖；不得顺手升级无关依赖）
- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/**`
- `plugin/src/main/java/com/mcservant/command/**`（可新增）
- `plugin/src/main/resources/fabric.mod.json`（仅当命令或依赖声明需要最小调整）
- `plugin/src/test/java/com/mcservant/**`（可选）
- `plugin/README.md`
- `plugin/BUILD.md`
- `ts-core/README.md`（可选，仅补最短本地联调说明）
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `AGENTS.md`
- `ts-core/src/runtime/**`
- `ts-core/src/workers/**`
- `ts-core/src/conversation/**`
- `ts-core/src/skills/**`
- `ts-core/src/sandbox/**`
- 任何真实密钥、生产地址或个人本地路径。

---

## 核心逻辑要求

1. TS Core（TypeScript 单核心）端在 `interfaces/server-bridge`（服务端桥接接口）内定义协议模型与解析函数，至少覆盖：
   - `hello`（握手）：`protocol_version`（协议版本）、`mod_id`（模组标识）、`mod_version`（模组版本）、`connected_at`（连接时间）、`instance_id`（实例标识）。
   - `heartbeat`（心跳）：`protocol_version`（协议版本）、`instance_id`（实例标识）、`sequence`（序号）、`timestamp`（时间戳）、`state`（状态）。
   - `player_message`（玩家消息）：`protocol_version`（协议版本）、`instance_id`（实例标识）、`message_id`（消息标识）、`player_uuid`（玩家 UUID）、`player_name`（玩家名）、`content`（内容）、`timestamp`（时间戳）。
   - `ack`（确认） / `error`（错误）响应：返回 `type`、`ack_type`（确认类型）或错误码、`timestamp`（时间戳），不得回显 token（令牌）。
2. TS Core（TypeScript 单核心）端在 Fastify（接口网关）接入 `/ws/server-bridge`（服务端桥接 WebSocket）端点：
   - 支持 `Authorization: Bearer <token>`（授权头）校验。
   - token（令牌）从本地配置 / 依赖注入进入，不得硬写真实值；测试可用 `local-dev-token`（本地开发令牌）。
   - 缺失或错误 token（令牌）必须被拒绝，且不得写入 replay（补拉）事件。
3. 成功解析的 `hello`（握手）、`heartbeat`（心跳）与 `player_message`（玩家消息）必须转换为 `ServerBridgeEventEnvelope`（服务端桥接事件信封） 或等价 replay（补拉）事件，并通过现有 `appendRealtimeEvent`（追加实时事件）路径进入 replay（补拉）事件流；事件必须保持 `runtime_effect: "observe_only"`（运行时影响：仅观测）。
4. Fabric mod（Fabric 模组）端新增 `/svs <message>`（服务端女仆命令）最小命令：
   - 使用 Fabric API（Fabric 应用程序接口） / Brigadier（命令库）命令注册，不引入 CommandAPI（命令接口库） 或 Paper（服务端插件平台）依赖。
   - 权限检查使用已有 `fabric-permissions-api`（Fabric 权限接口） 或原版 op（管理员）等级回退；普通玩家无权限时返回明确提示。
   - 命令将玩家输入封装为 `player_message`（玩家消息）帧，经 `ServerBridgeTransport`（服务端桥接传输）发送，不直接调用 TS Core（TypeScript 单核心） HTTP（超文本传输协议）接口。
5. 双端协议字段必须稳定、脱敏且可审计：
   - access token（访问令牌）只允许出现在 WebSocket（全双工通信协议）请求头中，不得进入 JSON（结构化文本）帧、日志、异常摘要或 replay（补拉）事件。
   - 无效 JSON（结构化文本）、未知 `type`（类型）、协议版本不匹配、字段缺失或字段类型错误必须返回明确 `error`（错误）帧或关闭连接，不得抛出未捕获异常，不得污染 replay（补拉）事件。
6. 本任务不得让 `player_message`（玩家消息）直接进入 conversation（对话）队列、exec（执行）队列或 BotActor（机器人执行代理）写入口；本轮只证明 Fabric（模组加载器）命令能通过 Server Bridge（服务端桥接）到达 TS Core（TypeScript 单核心）观测流。
7. 文档必须给出最短本地联调步骤：启动 TS Core（TypeScript 单核心）接收端、配置 Fabric mod（Fabric 模组）桥接参数、启动 Fabric（模组加载器）服务端、执行 `/svs hello`（服务端女仆命令）、查看 replay（补拉）事件。

---

## 验收标准

1. `bash ts-core/scripts/pre_review.sh` 必须全部通过；如果新增依赖，`ts-core/package.json` 与 `ts-core/pnpm-lock.yaml` 必须一致，且不得升级无关依赖。
2. `cd plugin && ./gradlew build --no-daemon` 必须通过，最终 mod jar（模组产物） 仍包含 OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库）运行时依赖闭包。
3. TS Core（TypeScript 单核心）本地 WebSocket（全双工通信协议）集成测试必须覆盖：正确 token（令牌）连接 `/ws/server-bridge`，发送 `hello`（握手）、`heartbeat`（心跳）、`player_message`（玩家消息）后收到 `ack`（确认），并能从 replay（补拉）事件源读到对应 `server_bridge.*`（服务端桥接）事件。
4. 错误 token（令牌）或缺失 token（令牌）必须被拒绝，且 replay（补拉）事件源无新增事件；日志、错误响应、测试快照中不得出现 token（令牌）原文。
5. 无效帧测试必须覆盖至少三类：非法 JSON（结构化文本）、未知 `type`（类型）、缺失必填字段；三者都不得导致进程崩溃或写入 replay（补拉）。
6. Fabric mod（Fabric 模组）侧必须有最小命令注册测试或可复核实现，证明 `/svs <message>`（服务端女仆命令） 会调用 `ServerBridgeTransport.send()`（发送）发出 `player_message`（玩家消息）帧，并在未连接时给出明确失败提示。
7. 文档必须包含最短人工手测清单与预期日志；如果当前环境没有真实 Fabric（模组加载器）服务端，Coder（编码代理）必须在反馈区明确说明未做现场加载，并给出用户可执行步骤。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-041（任务四十一），并确认本轮是合并后的 Server Bridge（服务端桥接）双端最小闭环，不是旧窄版 TS Core（TypeScript 单核心）接收端任务。
- [ ] 已读取 `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节，确认 TS Core（TypeScript 单核心）侧只共享 JSON（结构化文本）协议形态，不引入 Java（编程语言） / OkHttp（网络客户端）细节。
- [ ] 已实现 `/ws/server-bridge`（服务端桥接 WebSocket）接收端、token（令牌）校验、`hello`（握手） / `heartbeat`（心跳） / `player_message`（玩家消息）解析、`ack`（确认） / `error`（错误）响应。
- [ ] 已实现 Fabric mod（Fabric 模组） `/svs <message>`（服务端女仆命令）最小命令、权限检查和 `player_message`（玩家消息）发送。
- [ ] 已确认 server-bridge（服务端桥接）事件只进入 replay（补拉）或实时观测流，不进入 conversation（对话）队列、exec（执行）队列或 BotActor（机器人执行代理）写入口。
- [ ] 已覆盖正确 token（令牌）、错误 token（令牌）、非法 JSON（结构化文本）、未知类型、缺失字段、未连接命令发送失败测试。
- [ ] 已确认本任务未触碰 LLM（大语言模型）链路，因此无需真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- [ ] 已执行 `cd plugin && ./gradlew build --no-daemon` 并记录结果。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过。

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-042**: EasyAuth（离线服认证模组）只读状态适配、机器人登录状态手测口径、端到端 MC（Minecraft，我的世界）服务器实测。
- **T-043**: Server Bridge（服务端桥接）稳定性补强：双端重连、心跳超时、版本协商、断线诊断与部署文档收口。
- **T-044**: 将 `player_message`（玩家消息） 从 observe_only（仅观测）灰度接入 conversation（对话）主线，形成 `/svs`（服务端女仆命令）到 LLM（大语言模型）回复的可控闭环。
