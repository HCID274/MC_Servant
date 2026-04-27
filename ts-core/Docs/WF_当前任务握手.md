# 当前任务握手区

【任务序号】: T-039
【当前状态】: 待开发

---

## 任务目标

T-039（任务三十九） 正式启动 T-Fabric-Bridge-01（Fabric 服务端桥接第一步）：将 `plugin/`（服务端插件源码）从历史 Paper（服务端插件平台）工程改为 Fabric mod（Fabric 模组）工程基线，并交付最小可加载 mod（模组）与 `ServerBridgeTransport`（服务端桥接传输）接口骨架。

本任务只做 Fabric（模组加载器）工程迁移的第一步，不实现真实 TS Core（TypeScript 单核心）接收服务，不接入 `interfaces/server-bridge/`（服务端桥接接口）运行时，不做完整 `/svs`（游戏命令）消息链路。

---

## 上下文说明

- 用户已确认 T-039（任务三十九）走方案 Y（捆绑串行）：`plugin/`（服务端插件源码）全面重写为 Fabric mod（Fabric 模组），并与 TS Core（TypeScript 单核心）端 `server-bridge`（服务端桥接）通信落地在同一批次连续完成。
- 决策来源：
  - `WF_当前任务握手.md`（当前任务握手）下方 T-缺-C（任务缺口 C）行。
  - `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节 Server Bridge（服务端桥接）平台与依赖选型。
- 锁定选型：
  - Fabric Loader（Fabric 加载器）0.15.x+
  - Fabric Loom（Fabric 构建插件）
  - Fabric API（Fabric 应用程序接口）`0.97.3+1.20.4`
  - Brigadier（命令解析库）与 `fabric-command-api-v2`（Fabric 命令接口）
  - OkHttp（外部 WebSocket 客户端）用于 mod（模组）到 TS Core（TypeScript 单核心）的外部进程通信
  - Gson（JSON 结构化消息库）
  - `fabric-permissions-api`（Fabric 权限接口，LuckPerms 软依赖）
  - 原版 `text_display`（文字显示实体）作为后续全息替代方向
- 硬警告：`fabric-networking-api-v1`（Fabric 内部网络接口）只允许用于 MC（Minecraft，我的世界）客户端与 MC（Minecraft，我的世界）服务端之间的自定义 packet（数据包）。严禁把它误用为 mod（模组）到 TS Core（TypeScript 单核心）外部进程通信通道。

---

## 输入文件白名单

Coder（编码代理） 本轮允许读取：

- `ts-core/agent.md`
- `ts-core/Docs/WF_当前任务握手.md`
- `ts-core/Docs/01_ARCHITECTURE.md` 第 2.6.1 节
- `plugin/pom.xml`
- `plugin/src/main/resources/plugin.yml`
- `plugin/src/main/resources/config.yml`
- `plugin/README.md`
- `plugin/BUILD.md`
- `plugin/src/main/java/com/mcservant/**`

Coder（编码代理） 本轮允许新增 / 修改 / 删除：

- `plugin/settings.gradle`
- `plugin/build.gradle`
- `plugin/gradle.properties`
- `plugin/src/main/resources/fabric.mod.json`
- `plugin/src/main/resources/mcservant.mixins.json`（仅当 Fabric Loom（Fabric 构建插件）配置确实需要）
- `plugin/src/main/resources/config.yml`
- `plugin/src/main/java/com/mcservant/**`
- `plugin/README.md`
- `plugin/BUILD.md`
- `plugin/pom.xml`、`plugin/mvnw`、`plugin/mvnw.cmd`、`plugin/.mvn/**`、`plugin/src/main/resources/plugin.yml`（仅用于移除或替换历史 Paper（服务端插件平台）/ Maven（构建工具）遗留入口）

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

1. 将 `plugin/`（服务端插件源码）的构建入口切换为 Gradle（构建工具）+ Fabric Loom（Fabric 构建插件），不再以 Maven（构建工具）/ Paper API（服务端插件接口）为主构建链。
2. 创建最小 Fabric mod（Fabric 模组）入口类，服务端启动时能输出清晰日志，表明 MCServant（项目插件名）模组已加载。
3. 新增 `ServerBridgeTransport`（服务端桥接传输）接口，至少覆盖连接、断开、发送字符串消息、连接状态查询四类能力；OkHttp（网络客户端）实现可以先做骨架，但业务代码不得直接依赖 OkHttp（网络客户端）具体类。
4. 新增桥接配置模型，至少包含 `enabled`（启用）、`url`（地址）、`accessToken`（访问令牌）、`heartbeatIntervalSeconds`（心跳间隔秒数）等字段；默认配置只能使用本地开发值和占位令牌，不能写入真实密钥。
5. 保留包名或模块命名的连续性，但移除 Paper（服务端插件平台）专属入口、Bukkit（服务端接口）事件、CommandAPI（命令接口库）、DecentHolograms（全息插件）和 AuthMe（认证插件）强绑定。
6. README（说明文档）与 BUILD（构建说明）必须同步更新为 Fabric（模组加载器）版本，明确构建命令、产物位置、部署到 Fabric 服务器 `mods/`（模组目录）的方式。

---

## 验收标准

1. `plugin/`（服务端插件源码）中存在可构建的 Fabric Loom（Fabric 构建插件）工程基线，关键版本与 `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节一致。
2. Fabric mod（Fabric 模组）元信息完整，包含模组标识、版本、入口点、依赖声明；不再依赖 Paper（服务端插件平台）/ Bukkit（服务端接口）/ CommandAPI（命令接口库）。
3. `ServerBridgeTransport`（服务端桥接传输）接口和 OkHttp（网络客户端）传输骨架存在，外部通信实现被接口隔离，没有把 Java（编程语言）侧细节泄漏到 TS Core（TypeScript 单核心）。
4. 本任务不得修改 TS Core（TypeScript 单核心）源码，也不得引入 MC（Minecraft，我的世界）事实硬编码。
5. Coder（编码代理）必须运行并记录 `cd plugin && ./gradlew build` 的结果；如果当前环境缺失 Gradle（构建工具）包装器或网络依赖下载失败，必须记录具体失败原因与最短本地复测命令。

---

## Coder 自检清单

- [ ] 已核对任务序号为 T-039（任务三十九），并确认当前状态为“待开发”。
- [ ] 已读取 `WF_当前任务握手.md`（当前任务握手）T-缺-C（任务缺口 C）与 `01_ARCHITECTURE.md`（架构文档）第 2.6.1 节，不再询问方案选择。
- [ ] `plugin/`（服务端插件源码）已切换到 Fabric Loom（Fabric 构建插件）工程基线，历史 Paper（服务端插件平台）入口不再作为主入口。
- [ ] 已新增最小 Fabric mod（Fabric 模组）入口、`fabric.mod.json`（模组元信息）与桥接配置模型。
- [ ] 已新增 `ServerBridgeTransport`（服务端桥接传输）接口，并将 OkHttp（网络客户端）细节隔离在实现类内。
- [ ] 已更新 `plugin/README.md` 与 `plugin/BUILD.md`，说明 Fabric（模组加载器）构建和部署方式。
- [ ] 已确认没有修改 TS Core（TypeScript 单核心）源码、根 `AGENTS.md`、旧 `backend/` 或 legacy（旧系统迁移）索引。
- [ ] 执行 `cd plugin && ./gradlew build` 并记录结果；若失败，记录具体环境原因和复测命令。
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过；如因本任务只改 Java（编程语言）/ Gradle（构建工具）且 TS Core（TypeScript 单核心）无变更，也仍需执行并记录结果。

---

## Manager 打回记录（仅 被打回 时填写）

（暂无）

---

## Coder 执行反馈（仅 Coder 填写）

（待 Coder（编码代理） 开发完成后填写。）

---

## 队列预览（只读，仅供 Coder 了解后续方向）

- **T-039**: T-Fabric-Bridge-01（Fabric 服务端桥接第一步） 工程基线、最小可加载 mod（模组）与 `ServerBridgeTransport`（服务端桥接传输）接口骨架。
- **T-040**: T-Fabric-Bridge-02（Fabric 服务端桥接第二步） OkHttp（网络客户端）真实连接、握手、心跳与本地 WebSocket（全双工通信协议）联调脚本。
- **T-041**: T-Fabric-Bridge-03（Fabric 服务端桥接第三步） `/svs`（游戏命令）命令体系、玩家消息发送与 TS Core（TypeScript 单核心）端 `server-bridge`（服务端桥接）接收骨架。

---

### Phase 1（第一阶段） 必做项遗漏补登（2026-04-26 由用户审计后追加，Manager（管理代理） 排期前必读，禁止再次误删）

下列三项是 `01_ARCHITECTURE.md`（架构文档） 第 18 节 Phase 1（第一阶段） 必做表与第 12 / 4.2 / 2 节明确承诺、但截至当前批次仍需排期的盲区。Manager（管理代理） 在排定后续任务前，必须先把它们纳入候选，不得再被新增对话能力优先级覆盖；本节由用户审计追加，Manager（管理代理） 不得在轮换批次时静默删除，如需重排请保留本节并显式更新候选编号。

- **T-缺-A（已完成 T-037）：`minecraft-data`（MC 事实包） 集成**
  - 缺口现状：`world-model/`（世界模型） 模块壳完整，但此前未引入 `minecraft-data`（MC 事实依赖包）。文档第 12.1 节承诺的“MC 常识 = 本地确定性 API（应用程序接口）查询”此前未通路。
  - 排期状态：已作为 T-037（任务三十七） 完成并通过审查。

- **T-缺-B（已完成 T-038）：脊髓反射动作硬编码到 BotActor（机器人执行代理）**
  - 缺口现状：observation（观测） 已能产出 `threat_level`（威胁等级） 并向 BotActor（机器人执行代理） 发中断信号，`runtime/state-machine.ts`（运行时状态机） 已有 `REFLEXING`（反射中） 状态，但文档承诺的反射动作仍未在 BotActor（机器人执行代理） 内硬编码执行。
  - 排期状态：已作为 T-038（任务三十八） 完成并通过审查。

- **T-缺-C（已确认 T-039 路径，2026-04-27 更新）：JAR（自定义服务端插件） 桥接通信落地 — 走方案 Y（捆绑串行）**
  - 缺口现状：`interfaces/server-bridge/`（服务端桥接接口） 目前只有 `contracts.ts`（契约） + `index.ts`（导出），无真实通信；同时 `plugin/`（服务端插件源码） 是 Paper 平台 JAR，与已全面迁移到 Fabric 的生产服务器不匹配，**实际上从未在当前服务器上跑通过**。
  - 已锁定决策（用户 2026-04-27 确认）：T-039 走方案 Y，把 `plugin/` 全面重写为 Fabric mod，与 TS Core（TypeScript 单核心） 端通信落地一起在同一批次（建议拆为 T-Fabric-Bridge 系列子任务）完成。
  - 已锁定依赖选型：Fabric Loader + Fabric Loom + Fabric API `0.97.3+1.20.4` + Brigadier + `fabric-command-api-v2` + **OkHttp**（外部 WebSocket，为未来跨机部署铺路） + Gson + `fabric-permissions-api`（LuckPerms 软依赖） + 原版 `text_display` 实体；详见 `01_ARCHITECTURE.md`（架构文档） 第 2.6.1 节 v0.4 修订。
  - 硬警告：`fabric-networking-api-v1` 仅用于 MC（Minecraft，我的世界） 客户端 ↔ MC 服务端自定义 packet（数据包），**严禁** 误用为 mod ↔ TS Core（TypeScript 单核心） 外部进程通信通道；该警告必须显式写进 T-Fabric-Bridge 派发的 input 白名单上下文。
  - Manager（管理代理） 行动项：T-039 当前的"前置确认"段落可以解锁，正式派发前请按 `01_ARCHITECTURE.md` 第 2.6.1 节锁定的选型表，把 T-039 拆为独立的 T-Fabric-Bridge 子任务序列（推荐拆分思路：① Gradle/Loom 工程基线 + 最小 mod 加载验证，② OkHttp 客户端 + 握手 + 心跳，③ `/svs` 命令体系 + 玩家消息发送，④ EasyAuth 状态对接，⑤ TS Core 端 server-bridge 接收骨架 + 端到端联调）。

---

### 潜在代码债备忘（2026-04-26 由用户审计追加，未排期但已记账，禁止误删）

下列条目不构成 Phase 1（第一阶段） 必做项缺口，也不影响当前批次推进；仅作为"代码已经在不优雅的状态，未来某次架构治理批次应集中处理"的提示。Manager（管理代理） 不需要立即排期，但在下一次架构治理批次（参考历史 T-028 ~ T-030）启动时，应把本节作为候选清单读入。

- **代码债 D-1：`src/app/entrypoint.ts` 已达 804 行，需要按职责拆分**
  - 现状：T-029（任务二十九） 已完成 `app/bootstrap/` 子目录拆分（11 文件），但 `entrypoint.ts` 本体仍以 804 行单文件承载在线运行时装配、启停顺序、健康检查投影、状态投影注入等多个职责，是当前 `src/` 中最大的单文件之一。
  - 建议拆分方向（仅为参考，最终由治理批次的 Manager（管理代理） 决定）：`online-runtime-assemble.ts`（在线运行时装配） / `online-runtime-lifecycle.ts`（在线运行时启停） / `health-snapshot.ts`（健康投影） / `state-projection-wiring.ts`（状态投影接线）。
  - 触发条件：当 `entrypoint.ts` 再次因为新增能力而显著膨胀（例如 T-034（任务三十四） 实时推送装配 / T-036（任务三十六） memory（记忆） 注入装配 / 后续真实 provider（提供器） 装配陆续接入），优先级即应升至下一次架构治理批次的候选首位。
  - 不做范围：不在此条记账下做任何"顺手拆一下"的零散修改；拆分必须作为独立任务由 Manager（管理代理） 派发，避免与功能任务混在同一 commit。

- **架构文档 v0.4 同步范围说明（2026-04-27 更新）**
  - 已同步：`01_ARCHITECTURE.md`（架构文档） 第 2 节七层架构图、第 15 节模块表、第 16 节目录结构 已按当前实际代码追认 `app/`（应用装配） 与 `core-ports/`（核心端口） 两层，并升级为反映子目录拆分的两层视图。
  - 已同步（2026-04-27 新增）：`01_ARCHITECTURE.md`（架构文档） 第 2.6.1 节 Server Bridge 平台与依赖选型，记录 Paper → Fabric 迁移决策、OkHttp / Gson / `fabric-permissions-api` / `text_display` 锁定选型、Transport 隔离约束、`fabric-networking-api-v1` 误用警告。该小节作为 T-039 / T-Fabric-Bridge 系列任务派发的硬约束。
  - 未同步（语义级，留待整批次收口后再做）：BotActor（机器人执行代理） 状态机 6 态图（含 `INITIALIZING` / `DEAD` / `SHUTDOWN`）、`createRuntimeReadyGate`（运行时就绪门控） 显式建模、`broadcastReply`（广播回复） 收口于单写者、`ConversationCompositeTriage`（对话复合分诊） 升级 Triage Prompt（分诊提示词） 设计、BotActor（机器人执行代理）反射动作执行闭环 等差异。这些属于"代码语义级演进"，建议等 T-033 ~ T-040 批次收口后由 Manager（管理代理） 统一推进 v0.4 文档跃迁，不要在功能任务中夹带文档语义改动。
