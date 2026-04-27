# 当前任务握手区

【任务序号】: T-042
【当前状态】: 待开发

---

## 任务目标

T-042（任务四十二） 是模块级集成任务：收口 TS Core（TypeScript 单核心）真实在线启动配置与 MC（Minecraft，我的世界）实服烟测入口，让默认 `pnpm start`（启动命令） 不再依赖自定义入口即可启用 Server Bridge（服务端桥接）和 EasyAuth（离线服认证模组）登录命令。

目标验收口径：用户按文档设置本地环境变量后，可以启动 TS Core（TypeScript 单核心）、启动 Fabric mod（Fabric 模组）、让 bot（机器人）进服并执行 EasyAuth（离线服认证模组） `/login <secret>`（登录命令），再通过 `/svs hello`（服务端女仆命令）看到 TS Core `/api/replay`（补拉接口）出现 `server_bridge.player_message`（服务端桥接玩家消息）事件。

本任务只做“可启动、可登录、可手测”的在线装配闭环，不把 `player_message`（玩家消息）接入 conversation（对话）主线，不调用 LLM（大语言模型），不读取或迁移 EasyAuth（离线服认证模组） SQLite（嵌入式数据库）文件，不新增外部认证数据同步。

---

## 上下文说明

- T-041（任务四十一） 已完成 TS Core（TypeScript 单核心） `/ws/server-bridge`（服务端桥接 WebSocket） 接收端、Fabric mod（Fabric 模组） `/svs`（服务端女仆命令）与 replay（补拉）事件写入。
- T-041 遗留的已知运行缺口：`ts-core/src/main.ts`（默认入口）尚未从环境变量注入 `dependencies.serverBridge`，所以用户目前必须写自定义入口才能启用 `/ws/server-bridge`。
- 现有外部认证模型已经支持 `MC_EXTERNAL_AUTH_REQUIRED`（是否需要外部认证） 与 `MC_EXTERNAL_AUTH_SECRET`（外部认证明文密钥） 生成 `/login <secret>`（登录命令），且公开状态必须只显示 `/login <redacted>`（脱敏登录命令）。
- EasyAuth（离线服认证模组） 是外部认证真理源。TS Core（TypeScript 单核心） 现阶段只持有机器人自己的明文密码并走游戏内登录流程；不得把 EasyAuth（离线服认证模组） 的 SQLite（嵌入式数据库） 表结构纳入主业务库或启动依赖。
- 本任务不触碰 LLM（大语言模型）调用链路、Prompt（提示词）、parser（解析器） 或 conversation（对话）路由，因此不需要真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收；但需要给出真实 MC（Minecraft，我的世界）手测步骤与预期现象。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/WF_需求变更索引.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 2.6.1 节、第 3.2 节
- `ts-core/Docs/02_RUNTIME_SPEC.md` 第 1 节、第 2.1 节、第 2.3 节
- `ts-core/Docs/05_DATA_SPEC.md` 第 1 节、第 2.1 节
- `ts-core/src/main.ts`
- `ts-core/src/app/index.ts`
- `ts-core/src/app/entrypoint.ts`
- `ts-core/src/app/bootstrap/contract.ts`
- `ts-core/src/app/bootstrap/directories.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/app/bootstrap/external-auth.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/src/runtime/contracts.ts`
- `ts-core/src/runtime/actor.ts`
- `ts-core/src/runtime/transport/lifecycle.ts`
- `ts-core/src/interfaces/server-bridge/route.ts`
- `ts-core/src/interfaces/server-bridge/protocol.ts`
- `ts-core/src/interfaces/server.ts`
- `ts-core/src/interfaces/api.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/app-smoke-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`
- `ts-core/src/__tests__/external-auth-execution-model.spec.ts`
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`

Coder（编码代理） 本轮允许新增 / 修改：

- `ts-core/src/main.ts`
- `ts-core/src/app/entrypoint.ts`（仅允许补 server-bridge（服务端桥接）启动依赖装配或脱敏状态；不得改 LLM（大语言模型）链路）
- `ts-core/src/app/bootstrap/contract.ts`
- `ts-core/src/app/bootstrap/env.ts`
- `ts-core/src/app/bootstrap/external-auth.ts`
- `ts-core/src/app/bootstrap/types.ts`
- `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
- `ts-core/src/__tests__/app-smoke-model.spec.ts`
- `ts-core/src/__tests__/external-auth-execution-model.spec.ts`
- `ts-core/src/__tests__/runtime-actor-model.spec.ts`（仅当登录命令行为需要补回归）
- `ts-core/src/__tests__/runtime-mineflayer-model.spec.ts`（仅当 Mineflayer（Minecraft 协议客户端）登录 ready（就绪）边界需要补回归）
- `ts-core/README.md`
- `plugin/README.md`
- `plugin/BUILD.md`
- `ts-core/Docs/WF_当前任务握手.md`（仅 Coder（编码代理）反馈区回填）

禁止修改：

- `backend/**`
- `docs/legacy-*.md`
- `AGENTS.md`
- `ts-core/src/conversation/**`
- `ts-core/src/workers/**`
- `ts-core/src/skills/**`
- `ts-core/src/sandbox/**`
- `ts-core/src/data/**`（本任务不做 EasyAuth（离线服认证模组）数据库读取）
- `plugin/src/main/java/**`（本任务默认不改 mod（模组）代码；如实服手测发现命令注册阻塞，先在反馈区说明）
- 任何真实密钥、真实服务器地址、生产地址、个人本地绝对路径。

---

## 核心逻辑要求

1. `ts-core/src/main.ts`（默认入口）必须支持从环境变量启用 Server Bridge（服务端桥接）：
   - `SERVER_BRIDGE_ENABLED`（是否启用）：缺省时按 `SERVER_BRIDGE_ACCESS_TOKEN`（访问令牌）是否存在决定；显式 `false` 时禁用。
   - `SERVER_BRIDGE_ACCESS_TOKEN`（访问令牌）：启用时必填；缺失必须启动失败并给出脱敏错误，不得使用硬编码默认令牌。
   - `SERVER_BRIDGE_PATH`（服务端桥接路径）：可选，默认 `/ws/server-bridge`。
   - token（令牌）只进入依赖注入，不得出现在日志、状态接口、replay（补拉）事件、错误摘要或测试快照。
2. 外部认证登录口径必须保持现有方案二：
   - 使用 `MC_EXTERNAL_AUTH_REQUIRED=true`（需要外部认证） + `MC_EXTERNAL_AUTH_SECRET=<机器人密码>`（外部认证明文密钥） 生成游戏内 `/login <secret>` 命令。
   - `/api/status`（状态接口）和启动摘要只能暴露 `external_auth.status`（外部认证状态）与 `/login <redacted>`（脱敏登录命令预览），不得暴露明文密码。
   - 不读取 EasyAuth（离线服认证模组） SQLite（嵌入式数据库），不把认证状态写入 PostgreSQL（关系型数据库）主业务 schema（结构）。
3. 补齐测试：
   - main（默认入口）配置解析或等价启动依赖装配测试：覆盖未配置、token（令牌）存在启用、显式禁用、启用但缺 token（令牌）失败。
   - 外部认证状态脱敏测试：`MC_EXTERNAL_AUTH_SECRET=hunter2` 时，公开状态和错误摘要不得包含 `hunter2`。
   - 若修改 Mineflayer（Minecraft 协议客户端）登录边界，必须补 `login`（协议登录）与 `spawn`（生成）时序回归。
4. 文档必须给出最短 MC（Minecraft，我的世界）实服手测清单：
   - TS Core（TypeScript 单核心）环境变量清单：PostgreSQL（关系型数据库）、Redis（缓存）、Mineflayer（Minecraft 协议客户端）、EasyAuth（离线服认证模组）、Server Bridge（服务端桥接）。
   - Fabric mod（Fabric 模组）启动参数清单：`mcservant.bridge.enabled`、`mcservant.bridge.url`、`mcservant.bridge.accessToken`。
   - 手测步骤：启动 TS Core → 启动 Fabric server（Fabric 服务端） → bot（机器人）上线并登录 → `/svs hello` → `/api/status` 与 `/api/replay` 验证。
   - 明确预期日志与失败排查：token（令牌）不匹配、EasyAuth（离线服认证模组）密码错误、bot（机器人）未 spawn（生成）、Redis（缓存）/ PostgreSQL（关系型数据库）不可达。
5. 本任务不得接入 LLM（大语言模型）回复，不得把 `/svs`（服务端女仆命令） 的 `player_message`（玩家消息）转入 conversation（对话）队列；server-bridge（服务端桥接）仍保持 `observe_only`（仅观测）。

---

## 验收标准

1. `bash ts-core/scripts/pre_review.sh` 必须全部通过。
2. 默认入口相关测试必须证明：配置 `SERVER_BRIDGE_ACCESS_TOKEN` 后 `pnpm start`（启动命令）路径会启用 `/ws/server-bridge`（服务端桥接 WebSocket）；显式禁用不会注册；启用但缺 token（令牌）会失败且不泄露密钥。
3. 外部认证相关测试必须证明：EasyAuth（离线服认证模组）登录命令只在 BotActor（机器人执行代理）单写者路径发送，公开状态与日志只出现 `/login <redacted>`（脱敏登录命令），不出现明文密码。
4. 文档必须提供用户可直接执行的 MC（Minecraft，我的世界）实服手测步骤；如果 Coder（编码代理） 当前环境不能连真实 Fabric server（Fabric 服务端），必须在反馈区明确“未做现场加载”，并列出需要用户回报的最小结果项。
5. 若本轮实际触碰 LLM（大语言模型）链路，必须补真实 OpenAI（开放人工智能）兼容 API（应用程序接口）调用结果；否则反馈区明确“未触碰 LLM（大语言模型）链路，无需真实 LLM（大语言模型）验收”。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-042（任务四十二），并确认 T-041（任务四十一）已完成，不再改 T-041 的已通过语义。
- [ ] 已确认本任务只做在线启动配置、EasyAuth（离线服认证模组）登录口径与实服手测说明，不读取 EasyAuth（离线服认证模组） SQLite（嵌入式数据库）。
- [ ] 已让 `ts-core/src/main.ts`（默认入口）可通过环境变量启用 / 禁用 Server Bridge（服务端桥接），且 token（令牌）不落日志、不落状态、不落 replay（补拉）。
- [ ] 已确认外部认证明文密码只用于 BotActor（机器人执行代理）受控 `/login`（登录命令）路径，公开视图全程脱敏。
- [ ] 已补齐默认入口 / 外部认证 / server-bridge（服务端桥接）配置回归测试。
- [ ] 已在 `ts-core/README.md` 和必要的 `plugin/README.md` / `plugin/BUILD.md` 写清 MC（Minecraft，我的世界）实服手测步骤与预期结果。
- [ ] 已说明是否完成真实 Fabric server（Fabric 服务端）现场加载；若未完成，已给出用户回报清单。
- [ ] 已确认未触碰 LLM（大语言模型）链路；若触碰，已补真实 OpenAI（开放人工智能）兼容 API（应用程序接口）验收。
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

暂无。

---

## Coder 执行反馈（仅 Coder 填写）

待填写。

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-043**: Server Bridge（服务端桥接）稳定性补强：双端重连、心跳超时、版本协商、断线诊断与部署文档收口。
- **T-044**: 将 `player_message`（玩家消息） 从 observe_only（仅观测）灰度接入 conversation（对话）主线，形成 `/svs`（服务端女仆命令）到 LLM（大语言模型）回复的可控闭环；触碰 LLM（大语言模型）链路时必须真实调用本地 OpenAI（开放人工智能）兼容 API（应用程序接口）。
- **T-045**: MC（Minecraft，我的世界）实服动作烟测扩展：在真实在线链路中验证 1-2 个低风险技能从自然语言到 BotActor（机器人执行代理）执行的闭环。
