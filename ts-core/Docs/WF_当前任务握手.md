# 当前任务握手区

【任务序号】: T-044
【当前状态】: 待开发

---

## 任务目标

T-044（任务四十四） 是 `/svs`（服务端女仆命令）接入 conversation（对话）主线的模块级批量任务：一次性完成 Server Bridge（服务端桥接）玩家消息从 observe-only（仅观测）事件到 `msg:{botId}`（消息队列）入队、ConversationWorker（对话工作线程）处理、真实 LLM（大语言模型）回复、BotActor（机器人执行代理）聊天写回 MC（Minecraft，我的世界）、replay（补拉）诊断的最小闭环。

目标验收口径：在显式启用后，游戏内执行 `/svs 你好` 应能经 TS Core（TypeScript 单核心）真实 OpenAI（开放人工智能）兼容 API（应用程序接口）生成回复，并通过 Mineflayer（Minecraft 协议客户端）聊天出口写回游戏；未启用时仍保持 T-043（任务四十三）的 observe-only（仅观测）行为。

---

## 上下文说明

- T-041（任务四十一） 已完成 Fabric mod（Fabric 模组） `/svs`（服务端女仆命令）到 `/ws/server-bridge`（服务端桥接 WebSocket）的双端最小闭环。
- T-042（任务四十二） 已完成 `pnpm start`（启动命令）默认入口启用 Server Bridge（服务端桥接）的配置装配。
- T-043（任务四十三） 已完成 Server Bridge（服务端桥接）长期运行稳定性：重连、心跳超时、协议版本、重复消息、断线诊断与 token（令牌）脱敏。
- 当前缺口是聊天驱动主链路：`server_bridge.player_message`（服务端桥接玩家消息）目前只进入 replay（补拉）流，尚未进入 ConversationWorker（对话工作线程），因此 `/svs`（服务端女仆命令）只能被观察，不能触发女仆回复。
- 本任务触碰 LLM（大语言模型）调用链路和在线入口装配，必须执行真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；mock（模拟）测试不能替代真实调用结果。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/WF_需求变更索引.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 1 节、第 3.2 节
- `ts-core/Docs/04_CONVERSATION_SPEC.md` 第 1 节、第 2 节、第 3 节、第 4 节
- `ts-core/Docs/09_AGENT_WORKFLOW.md` 第 2 节、第 3 节、第 4 节
- `ts-core/src/interfaces/server-bridge/contracts.ts`
- `ts-core/src/interfaces/server-bridge/protocol.ts`
- `ts-core/src/interfaces/server-bridge/route.ts`
- `ts-core/src/interfaces/server-bridge/index.ts`
- `ts-core/src/interfaces/contracts.ts`
- `ts-core/src/interfaces/api.ts`
- `ts-core/src/interfaces/server.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/main.ts`
- `ts-core/src/conversation/contracts.ts`
- `ts-core/src/conversation/triage.ts`
- `ts-core/src/conversation/chat.ts`
- `ts-core/src/conversation/llm/**`
- `ts-core/src/workers/contracts.ts`
- `ts-core/src/workers/queues.ts`
- `ts-core/src/workers/conversation-worker/**`
- `ts-core/src/runtime/actor.ts`（仅允许确认 `broadcastReply`（广播回复）出口语义）
- `ts-core/src/runtime/transport.ts`（仅允许确认 `chat`（聊天）出口语义）
- `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts`
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/src/interfaces/server-bridge/**`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/main.ts`
- `ts-core/src/__tests__/interfaces-server-bridge-model.spec.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/conversation-worker-runtime-model.spec.ts`
- `ts-core/src/__tests__/conversation-llm-runtime-model.spec.ts`
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `AGENTS.md`
- `plugin/src/main/java/**`（本任务不改 Fabric mod（Fabric 模组）代码）
- `ts-core/src/runtime/**`（除只读确认外不得修改）
- `ts-core/src/skills/**`
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`
- `ts-core/src/db/**`
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. Server Bridge（服务端桥接）到 conversation（对话）主线必须显式开启：
   - 新增配置必须通过环境变量或依赖注入控制，建议命名为 `SERVER_BRIDGE_CONVERSATION_ENABLED`（服务端桥接对话启用）或同等清晰名称。
   - 未启用时，`server_bridge.player_message`（服务端桥接玩家消息）仍只写 replay（补拉）事件，保持 `runtime_effect: "observe_only"`（运行时影响：仅观测）。
   - 启用后，只允许 `player_message`（玩家消息）进入 `msg:{botId}`（消息队列）；`hello`（握手）、`heartbeat`（心跳）、生命周期诊断事件不得入 conversation（对话）队列。
2. 入队语义必须与 HTTP（超文本传输协议） `/api/message`（消息接口）保持一致：
   - 使用既有 `createConversationWorkerTask()`（创建对话工作线程任务）或等价封装，队列名必须是 `msg:{botId}`。
   - `jobId`（任务标识）必须使用 `message_id`（消息标识），避免重复 `/svs`（服务端女仆命令）消息被隐式重复消费。
   - 入队后应写入最小 `task.accepted`（任务已接受）或等价 replay（补拉）诊断，便于用户从 `/api/replay`（补拉接口）看到“已接入主线”。
3. 回复出口必须走 BotActor（机器人执行代理）单写者：
   - ConversationWorker（对话工作线程）生成的 `chat.reply`（聊天回复）必须继续通过现有 `broadcastReplySink`（广播回复汇点）调用 `createdRuntime.actor.broadcastReply()`（执行代理广播回复）。
   - 不得在 Server Bridge（服务端桥接）路由、接口层或 worker（工作线程）外部直接调用 Mineflayer（Minecraft 协议客户端） `chat()`（聊天）。
   - BotActor（机器人执行代理）未 ready（就绪）或外部认证未完成时，应显式失败并留下诊断，不得伪装成成功。
4. LLM（大语言模型）路径必须保持最小可测：
   - `/svs`（服务端女仆命令）普通闲聊应走真实 `chat_reply`（闲聊回复）路径。
   - 显式 cancel（取消）文本仍应走现有规则分诊和中断语义，不应调用 LLM（大语言模型）。
   - 不要求本任务新增自然语言技能动作；`task`（任务）规划可复用现有 planner（规划器）能力，不扩大技能面。
5. 真实 LLM（大语言模型）验收是硬门槛：
   - 默认真实入口：`LLM_BASE_URL=http://127.0.0.1:8045/v1`，`LLM_API_KEY=sk-local-dev`，`LLM_MODEL=bl-auto`。
   - 若 Coder（编码代理）环境能访问本地网关，必须在反馈区记录真实调用命令、输入摘要、关键输出和结果判断。
   - 若 Coder（编码代理）环境不能访问本地网关，必须回填最短人工手测步骤和预期结果；Manager（管理代理）会等待用户真实手测回报后再最终通过或打回。

---

## 验收标准

1. 未启用 Server Bridge conversation（服务端桥接对话）时，`player_message`（玩家消息）只进入 replay（补拉）流，不入 `msg:{botId}`（消息队列），T-043（任务四十三） observe-only（仅观测）行为不回退。
2. 启用后，`player_message`（玩家消息）会入 `msg:{botId}`（消息队列），并产生可验证的 accepted（已接受）诊断；重复 `message_id`（消息标识）不应重复消费。
3. 在线入口集成测试覆盖 `/svs`（服务端女仆命令）普通闲聊：Server Bridge（服务端桥接）收到消息、ConversationWorker（对话工作线程）生成回复、BotActor（机器人执行代理）聊天写回、`chat.reply`（聊天回复）进入 replay（补拉）。
4. cancel（取消）路径回归测试覆盖：显式取消文本不调用 LLM（大语言模型），仍发出运行时中断并给模板回执。
5. 真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用成功，或已给出用户可执行的最短手测步骤并等待用户回报；`bash ts-core/scripts/pre_review.sh` 必须全部通过。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-044（任务四十四），且 T-043（任务四十三）已完成。
- [ ] 已确认本任务按 conversation（对话）接入链路批量完成，没有把同一链路拆成多个步骤级小任务。
- [ ] 已确认未修改 Fabric mod（Fabric 模组）Java（编程语言）代码、runtime（运行时）、skills（技能）、sandbox（沙箱）、data（数据层）或 db（数据库）目录。
- [ ] 已保留未启用时 observe-only（仅观测）行为，并补测试防止默认行为被改变。
- [ ] 已确保启用后只把 `player_message`（玩家消息）入 conversation（对话）队列，不把 `hello`（握手）/ `heartbeat`（心跳）/ lifecycle（生命周期）事件入队。
- [ ] 已确认所有回复仍通过 BotActor（机器人执行代理）单写者聊天出口，不在接口层直接写 MC（Minecraft，我的世界）聊天。
- [ ] 已完成真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；若无法访问本地网关，已回填最短人工手测步骤和预期结果。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-045**: MC（Minecraft，我的世界）实服动作烟测扩展：集中验证自然语言到 1-2 个低风险技能执行的在线闭环，仍走 BotActor（机器人执行代理）单写者路径；如触碰 LLM（大语言模型）规划，必须真实 API（应用程序接口）验收。
- **T-046**: 轻面板最小同步：围绕 `/api/status`（状态接口）、`/api/replay`（补拉接口）和 WebSocket（全双工通信协议）推送做最小网页控制台，不做复杂 UI（用户界面）。
- **T-047**: 端到端实服回归清单与故障诊断收口：整理 TS Core（TypeScript 单核心）+ Fabric mod（Fabric 模组）+ MC（Minecraft，我的世界）服务器的最短启动、复测、回报模板。
