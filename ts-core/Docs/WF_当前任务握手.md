# 当前任务握手区

【任务序号】: T-043
【当前状态】: 待开发

---

## 任务目标

T-043（任务四十三） 是 Server Bridge（服务端桥接）模块级批量任务：一次性收口 TS Core（TypeScript 单核心）接收端与 Fabric mod（Fabric 模组）客户端的稳定性，不再把同一桥接模块拆成多个小任务。

目标验收口径：`/ws/server-bridge`（服务端桥接 WebSocket）在真实服务端长期运行时具备可诊断、可恢复、可拒绝错误版本、可处理断线的基础能力；Fabric mod（Fabric 模组） 端在 TS Core（TypeScript 单核心）重启、网络短断、token（令牌）错误时行为明确，且不泄露 token（令牌）。

本任务仍保持 server-bridge（服务端桥接）为 `observe_only`（仅观测）入口，不把 `player_message`（玩家消息）接入 conversation（对话）主线，不调用 LLM（大语言模型），不触碰技能执行链路。

---

## 上下文说明

- T-041（任务四十一） 已完成双端最小闭环：Fabric mod（Fabric 模组） `/svs`（服务端女仆命令） 发送 `player_message`（玩家消息），TS Core（TypeScript 单核心） 写入 `/api/replay`（补拉接口）。
- T-042（任务四十二） 已完成默认入口装配：`pnpm start`（启动命令） 可通过 `SERVER_BRIDGE_ACCESS_TOKEN`（服务端桥接访问令牌） 启用 `/ws/server-bridge`（服务端桥接 WebSocket），并给出 MC（Minecraft，我的世界）实服手测说明。
- 当前缺口集中在同一模块内：重连、心跳超时、连接状态诊断、版本拒绝、断线事件、mod（模组）端退避重试和部署说明。按用户要求，这些同模块项本轮合并派发，避免后续重复握手消耗 token（文本配额）。
- T-043 不解决“玩家消息如何触发 LLM（大语言模型）回复”。那是后续 conversation（对话）模块任务，且触碰 LLM（大语言模型）时必须执行真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/WF_需求变更索引.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 2.6.1 节、第 3.2 节
- `ts-core/Docs/02_RUNTIME_SPEC.md` 第 1 节、第 2.1 节、第 2.3 节
- `ts-core/src/interfaces/server-bridge/contracts.ts`
- `ts-core/src/interfaces/server-bridge/protocol.ts`
- `ts-core/src/interfaces/server-bridge/route.ts`
- `ts-core/src/interfaces/server-bridge/index.ts`
- `ts-core/src/interfaces/api.ts`
- `ts-core/src/interfaces/server.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/main.ts`
- `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/interfaces-model.spec.ts`
- `ts-core/README.md`
- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/ServerBridgeConfig.java`
- `plugin/src/main/java/com/mcservant/bridge/ServerBridgeTransport.java`
- `plugin/src/main/java/com/mcservant/bridge/OkHttpServerBridgeTransport.java`
- `plugin/src/main/java/com/mcservant/command/SvsCommand.java`
- `plugin/README.md`
- `plugin/BUILD.md`
- `plugin/build.gradle`
- `plugin/gradle.properties`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/src/interfaces/server-bridge/**`
- `ts-core/src/app/entrypoint.ts`（仅允许 server-bridge（服务端桥接）状态投影、断线事件与 replay（补拉）装配）
- `ts-core/src/app/bootstrap/env.ts`（仅允许新增 server-bridge（服务端桥接）稳定性相关环境变量解析）
- `ts-core/src/main.ts`（仅允许把新增 server-bridge（服务端桥接）配置注入在线入口）
- `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/interfaces-model.spec.ts`
- `ts-core/README.md`
- `plugin/src/main/java/com/mcservant/MCServantMod.java`
- `plugin/src/main/java/com/mcservant/bridge/**`
- `plugin/src/main/java/com/mcservant/command/SvsCommand.java`（仅当稳定性反馈需要调整用户可见提示）
- `plugin/README.md`
- `plugin/BUILD.md`
- `plugin/build.gradle`
- `plugin/gradle.properties`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `AGENTS.md`
- `ts-core/src/conversation/**`
- `ts-core/src/workers/**`
- `ts-core/src/skills/**`
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`
- `ts-core/src/runtime/**`
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. TS Core（TypeScript 单核心）接收端必须具备连接生命周期诊断：
   - 成功连接、`hello`（握手）、`heartbeat`（心跳）、`player_message`（玩家消息）、正常关闭、异常断开、心跳超时都应有可测试的内部状态或 replay（补拉）诊断事件。
   - replay（补拉）事件仍必须携带 `runtime_effect: "observe_only"`（运行时影响：仅观测）。
   - token（令牌）不得进入 ack（确认）/ error（错误）帧、replay（补拉）事件、日志或测试快照。
2. 协议版本与握手顺序必须明确：
   - 不支持的 `protocol_version`（协议版本） 必须返回明确错误并关闭或拒绝后续处理。
   - 连接未完成 `hello`（握手）前收到 `heartbeat`（心跳）或 `player_message`（玩家消息） 时，必须有确定性处理策略：拒绝并给错误帧，或只接受 `heartbeat`（心跳）但不接受 `player_message`（玩家消息）。策略需写入测试和文档。
   - 重复 `hello`（握手）、重复 `message_id`（消息标识） 的行为必须确定：允许幂等、覆盖、拒绝三选一，不能隐式未定义。
3. 心跳与超时必须可配置且默认保守：
   - TS Core（TypeScript 单核心）端支持 server-bridge（服务端桥接）心跳超时配置，缺省值适合本地开发。
   - Fabric mod（Fabric 模组）端支持重连退避配置，TS Core（TypeScript 单核心）不可达时不应刷屏、不应阻塞服务器主线程。
   - 所有新增配置必须通过环境变量或 Java（编程语言）系统属性注入，不得硬编码真实部署值。
4. Fabric mod（Fabric 模组）端必须补强连接恢复：
   - TS Core（TypeScript 单核心）重启后能自动重连。
   - token（令牌）错误时给出明确但脱敏的日志或用户提示。
   - `/svs`（服务端女仆命令） 在未连接、正在重连、协议不兼容时返回明确提示，不吞消息、不假装已发送。
5. 本任务不得接入 LLM（大语言模型）或 conversation（对话）主线：
   - 不得把 `server_bridge.player_message`（服务端桥接玩家消息） 写入 `msg:{botId}`（消息队列）或调用 ConversationWorker（对话工作线程）。
   - 若误触碰 LLM（大语言模型）链路、Prompt（提示词）、parser（解析器）或 conversation（对话）路由，必须立刻补真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收，否则不得回填完成。

---

## 验收标准

1. TS Core（TypeScript 单核心）测试覆盖：正常 `hello` / `heartbeat` / `player_message`、未握手消息、协议版本不匹配、重复消息、断线或心跳超时、token（令牌）脱敏，且 replay（补拉）保持 `observe_only`（仅观测）。
2. Fabric mod（Fabric 模组）构建通过，且代码层能说明重连退避、未连接 `/svs` 提示、token（令牌）错误脱敏、协议不兼容提示的行为；如无 Java（编程语言）单测框架，至少用结构化代码路径和 README（说明文档）手测清单覆盖。
3. `pnpm start`（启动命令）路径可配置新增 server-bridge（服务端桥接）稳定性参数；默认值不要求用户额外配置即可本地运行。
4. 文档更新必须给出长期运行排障清单：TS Core（TypeScript 单核心）重启、Fabric mod（Fabric 模组）重连、token（令牌）错误、协议版本错误、心跳超时、`/svs`（服务端女仆命令）未连接。
5. `bash ts-core/scripts/pre_review.sh` 必须全部通过；如修改 `plugin/**`，还必须执行 `cd plugin && ./gradlew build --no-daemon` 并在反馈区记录结果。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-043（任务四十三），且 T-042（任务四十二）已完成。
- [ ] 已确认本任务是 Server Bridge（服务端桥接）同模块批量任务，没有把同模块稳定性拆成多个小任务。
- [ ] 已确认所有改动只在白名单内，未触碰 conversation（对话）、workers（工作线程）、skills（技能）、sandbox（沙箱）、runtime（运行时）和 data（数据层）。
- [ ] 已补齐 TS Core（TypeScript 单核心）接收端生命周期、协议版本、握手顺序、重复消息、心跳超时与脱敏测试。
- [ ] 已补强 Fabric mod（Fabric 模组）端重连、退避、状态提示与 token（令牌）脱敏。
- [ ] 已更新 TS Core（TypeScript 单核心）与 plugin（模组）文档，包含长期运行与实服排障步骤。
- [ ] 已执行 `cd plugin && ./gradlew build --no-daemon` 并记录结果；若未修改 `plugin/**`，需说明原因。
- [ ] 已确认本轮未触碰 LLM（大语言模型）链路；若触碰，已补真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-044**: `/svs`（服务端女仆命令）消息接入 conversation（对话）主线：将 `server_bridge.player_message`（服务端桥接玩家消息） 灰度转成入站消息，形成游戏内 `/svs` → LLM（大语言模型）回复 → MC（Minecraft，我的世界）聊天的可控闭环；必须真实调用本地 OpenAI（开放人工智能）兼容 API（应用程序接口）。
- **T-045**: MC（Minecraft，我的世界）实服动作烟测扩展：集中验证自然语言到 1-2 个低风险技能执行的在线闭环，仍走 BotActor（机器人执行代理）单写者路径。
- **T-046**: 轻面板最小同步：围绕 `/api/status`（状态接口）、`/api/replay`（补拉接口）和 WebSocket（全双工通信协议）推送做最小网页控制台，不做复杂 UI（用户界面）。
