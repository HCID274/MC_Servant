# 任务阶段压缩记录

仅 Manager 在一个批次累计满 10 个已完成任务后追加。该文件用于阶段性压缩归档，不替代 `WF_开发进度记录.md`（详细进度记录） 的逐任务明细。

---

## 批次 T-001 ~ T-010

- **阶段主题**: TS Core（TypeScript 单核心） Phase 1（第一阶段） 工程骨架、核心模块纯契约与本地装配闭环
- **覆盖模块**:
  - `domain`（领域）
  - `runtime`（运行时）
  - `data`（数据）
  - `observation`（观测）
  - `world-model`（世界模型）
  - `skills`（技能）
  - `interfaces`（接口层）
  - `sandbox`（沙箱）
  - `diagnostics`（诊断）
  - `conversation`（对话）
  - `workers`（工作线程）
  - `db`（数据库）
  - `app`（应用装配）
- **阶段压缩摘要**:
  - 完成 `pnpm`（包管理器） + `TypeScript strict`（严格模式） + `NodeNext`（Node 模块解析） + `Biome`（格式化 / lint） + `Vitest`（测试） 的主线工程基座，并建立 `pre_review.sh`（预检脚本） 闭环。
  - 以纯函数 / 强类型方式补齐 `runtime`（运行时） 状态机、执行任务、事件枚举、中断协议与最小 `BotActor`（机器人执行代理） 骨架，锁定聊天驱动与单写者约束。
  - 建立 `data`（数据） / `db`（数据库） 契约层，收口 PostgreSQL（关系型数据库） 业务表、迁移元信息、Redis（缓存） 键目录、日志保留策略、环境变量与 Bot 级配置覆盖逻辑。
  - 建立 `observation`（观测） / `world-model`（世界模型） 只读边界，修复快照副本语义与威胁评估强类型约束，保证读取侧不会旁路污染内部状态。
  - 建立 `skills`（技能） Phase 1（第一阶段） 目录、参数模型与注册表；`skill_call`（技能调用） 不再依赖自由字符串 + 自由参数对象的弱类型输入。
  - 建立 `interfaces`（接口层） 的网页会话、消息提交、状态查询、健康检查与 replay（补拉） 契约，并保证会话与目标 Bot（机器人） 绑定一致，不允许跨 Bot 混包进入主线。
  - 建立 `sandbox`（沙箱） / `diagnostics`（诊断） 的最小强类型契约，收口 `Facade API`（门面接口）、资源限制、错误分类、JSONL（结构化日志） 通道、`log_ref` / `code_ref`（日志 / 代码引用） 规则。
  - 建立 `conversation`（对话） / `workers`（工作线程） 的三队列边界、分诊回退、回复 / 规划产物与中断桥接语义，避免工作线程直接耦合对话实现细节。
  - 建立 `app`（应用装配） 组合根与无 MC（Minecraft） 冒烟装配摘要，把 `interfaces`（接口层） / `workers`（工作线程） / `runtime`（运行时） / `db`（数据库） / `data`（数据） / `sandbox`（沙箱） / `diagnostics`（诊断） 的公开契约收口成可测试的单进程启停骨架。
- **阶段结果**:
  - 已形成“无真实外部适配器实例”的本地纯契约闭环，可继续向 `game-chat`（游戏聊天） / `server-bridge`（服务端桥接） ingress（入口） 统一、任务事件闭环、外部认证适配与部署骨架推进。
  - 已确认长期约束：MC（Minecraft） 认证真理源按外部认证源建模，当前部署样例为 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库）；TS Core（TypeScript 单核心） 不接管、不迁移、不双写认证数据。
- **下一批次规划规则**:
  - `T-011` 到 `T-020` 继续按正常详细格式写入 `WF_当前任务握手.md`（当前任务握手） 与 `WF_开发进度记录.md`（详细进度记录）。
  - 当 `T-020` 审查通过后，再将 `T-011` 到 `T-020` 压缩追加到本文件。

---

## 批次 T-011 ~ T-020

- **阶段主题**: 从纯契约骨架转向 MVP（最小可运行闭环） 关键路径，完成外部输入、任务生命周期、外部认证、本地启动、持久化边界与三块真实 I/O（输入输出） 资源接入。
- **覆盖模块**:
  - `interfaces`（接口层）
  - `conversation`（对话）
  - `workers`（工作线程）
  - `runtime`（运行时）
  - `observation`（观测）
  - `app`（应用装配）
  - `db`（数据库）
  - `data`（数据）
  - `diagnostics`（诊断）
  - `domain`（领域）
- **阶段压缩摘要**:
  - `T-011` 统一 Web（网页） / game-chat（游戏聊天） / server-bridge（服务端桥接） 三类 ingress（入口） 标准消息包与事件包，修正游戏发送者标识与内部 `owner_id`（主人标识） 混用问题。
  - `T-012` 打通 `accepted` / `started` / `discarded` / `completed` / `failed` / `interrupted`（已接受 / 已开始 / 已丢弃 / 已完成 / 已失败 / 已中断） 的任务生命周期事件闭环，禁止终态默认兜底伪造。
  - `T-013` 将 EasyAuth（离线服认证模组） 建模为外部认证源，清除 `authme schema`（旧认证模式） 残留，修正 `sandbox`（沙箱） 日志保留环境变量和 `REFLEXING`（反射中） 中断排队语义。
  - `T-014` 补齐 `main.ts`（可执行入口）、启动摘要、`Dockerfile`（容器镜像构建文件）、`.env.example`（环境变量样例） 与运行说明；默认入口仍是 bootstrap-only（仅装配摘要），不自动连接真实外部服务。
  - `T-015` 收口 `event_log`（事件日志） / `task_history`（任务历史） / `JSONL`（结构化日志） / `replay`（补拉） 的纯持久化边界，并按任务类型区分 `tasks/*.jsonl` 与 `sandbox/*.jsonl` 日志引用。
  - `T-016` 把外部认证推进为“状态脱敏 + 一次性执行动作载荷”的纯模型，确保长期状态、应用装配结果和接口快照都不暴露明文密钥。
  - `T-017` 将重复 `assertNonEmptyString`（非空字符串断言） 与 `cloneReadonlyValue`（只读克隆） 收口到 `domain/invariants.ts`（领域不变量），并补记 `domain`（领域） 作为横切基础层。
  - `T-018` 接入 PostgreSQL（关系型数据库） / Redis（缓存） 真实资源工厂与 Drizzle（数据库工具） migration（迁移） 入口，支持依赖注入、warmup（预热） 与失败清理。
  - `T-019` 接入 BullMQ（任务队列） 三队列真实 `Queue`（队列） 与 Fastify（接口网关） 四路由启动骨架，锁定跨 Bot（跨机器人） 请求拒绝和空白输入 `400`（请求错误）。
  - `T-020` 接入 Mineflayer（Minecraft 协议客户端） 传输工厂、observation（观测） 事件驱动缓存和 BotActor（机器人执行代理） `INITIALIZING → IDLE`（初始化到空闲） 最小生命周期；打回修复后不再公开可写 Bot（机器人） 句柄，并补齐 spawn（生成） 前失败清理。
- **阶段结果**:
  - 已形成真实 PostgreSQL（关系型数据库） / Redis（缓存） / BullMQ（任务队列） / Fastify（接口网关） / Mineflayer（Minecraft 协议客户端） 的可注入运行时资源骨架，测试均不依赖真实外部服务。
  - 应用资源关闭顺序已固定为 HTTP（超文本传输协议） / workers（工作线程） → runtime transport（运行时传输） → Redis（缓存） → PostgreSQL（关系型数据库）。
  - 主干已经从“纯契约阶段”切到“可运行链路阶段”，下一批次默认继续沿 MVP（最小可运行闭环） 关键路径推进 ConversationWorker（对话工作线程） / BotWorker（机器人工作线程） / sandbox（沙箱） / demo（演示）。
- **详细明细归档**:
  - `WF_开发进度明细归档/T-011_至_T-020.md`

---

## 批次 T-021 ~ T-030

- **阶段主题**: MC（Minecraft，我的世界） 真实上线闭环、OpenAI（开放人工智能） 兼容 LLM（大语言模型） 接入、多技能执行、sandbox_code（沙箱代码） 执行与架构治理止血。
- **覆盖模块**:
  - `app`（应用装配）
  - `runtime`（运行时）
  - `workers`（工作线程）
  - `conversation`（对话）
  - `interfaces`（接口层）
  - `skills`（技能）
  - `sandbox`（沙箱）
  - `observation`（观测）
  - `diagnostics`（诊断）
  - `data`（数据层）
  - `core-ports`（核心端口层）
  - `domain`（领域基础）
- **阶段压缩摘要**:
  - `T-021` 打通最窄 MC（Minecraft，我的世界） 在线聊天闭环：真实 `pnpm start`（启动命令） 路径可装配 PostgreSQL（关系型数据库） / Redis（缓存） / BullMQ（任务队列） / Fastify（接口网关） / Mineflayer（Minecraft 协议客户端），并通过 EasyAuth（离线服认证模组） 登录命令后把游戏消息转为回复。
  - `T-022` 打通 `goTo`（前往坐标） 最小真实执行链：ConversationWorker（对话工作线程） 规划入 `bot:{botId}:exec`（执行队列），BotWorker（机器人工作线程） 串行调用 BotActor（机器人执行代理） 单写者入口，`world_ready`（世界交互就绪） 门控前置。
  - `T-023` 接入 OpenAI（开放人工智能） 兼容 `chat.completions`（对话补全） 闲聊最短闭环，配置走 `LLM_BASE_URL`（大语言模型基础地址） / `LLM_API_KEY`（接口密钥） / `LLM_MODEL`（模型名），并补齐真实 `cancel`（取消） 中断 + 模板回执语义。
  - `T-024` 把真实 LLM（大语言模型） 从闲聊扩到最小 `triage`（分诊） + 单技能 `plan`（规划），移除旧正则快路径；在线入口共享同一 LLM（大语言模型） 客户端，意外 `modify`（修改） 分诊会降级为 `chat/normal`（闲聊 / 普通）。
  - `T-025` 扩展真实技能面到 `mine`（挖掘） / `collect`（捡拾） / `equip`（装备），全部复用 BotActor（机器人执行代理） 单写者路径；`collect`（捡拾） 成功标准修正为目标物品背包总数增长。
  - `T-026` 补齐手测观测出口：`/api/status`（状态接口） 暴露只读运行状态与最近一次 LLM（大语言模型） 摘要，`/api/replay`（回放接口） 接入真实或注入事件源，并统一脱敏密钥、密码、连接串与过长错误摘要。
  - `T-027` 打通 `sandbox_code`（沙箱代码） 真实执行链：`isolated-vm`（隔离虚拟机） + `esbuild`（转译器） + Facade API（门面接口） 桥接 BotActor（机器人执行代理）；同时引入渐进披露、`describe()`（描述） 与 LRU（最近最少使用） 热队列治理上下文成本。
  - `T-028` 新增 `core-ports`（核心端口层） 并下沉共享类型，打断 `runtime`（运行时） 与 `skills`（技能） / `observation`（观测） / `diagnostics`（诊断） / `data`（数据） 的循环依赖；`pre_review.sh`（评审前预检脚本） 纳入 `madge`（依赖图工具） 循环检测。
  - `T-029` 拆分五个超大文件，保留兼容 barrel（聚合导出） 入口；`app/bootstrap`（应用引导）、`data/contracts`（数据契约）、`runtime/transport`（运行时传输）、`conversation/llm`（对话大语言模型）、`workers/conversation-worker`（对话工作线程） 已按职责拆入子目录，并把 `MineflayerBotHandle`（Mineflayer 机器人句柄） 切成能力 port（端口）。
  - `T-030` 完成架构治理收口：`executeStage()`（阶段执行模板） 统一 LLM（大语言模型） 三段调用，技能规划改为表驱动，Prompt（提示词） 模板独立组织并去除具体 MC（Minecraft，我的世界） 示例事实，接口错误工厂与命名约定落入稳定文档。
- **阶段结果**:
  - 当前主干已经具备真实 MC（Minecraft，我的世界） 上线、真实 LLM（大语言模型） 闲聊 / 分诊 / 单技能规划、真实技能执行、观测查询、事件回放与 sandbox_code（沙箱代码） 执行能力。
  - 依赖图已经由 `madge`（依赖图工具） 守门为无循环，架构治理后的下一批次可以继续推进对话智能增强，而不再先补纯契约。
  - T-028（任务二十八） 至 T-030（任务三十） 的架构治理备忘已完成并被本批次摘要吸收，独立 `WF_架构治理批次计划.md`（架构治理批次计划） 不再作为默认上下文保留。
  - 下一批次默认从 `T-031`（任务三十一） 开始，先做 `chat_reply`（闲聊回复） 注入 BotActor（机器人执行代理） 状态只读投影，再推进 composite output（复合输出）。
- **详细明细归档**:
  - `WF_开发进度明细归档/T-021_至_T-030.md`
