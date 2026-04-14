# 当前任务握手区

【任务序号】: T-011
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `interfaces/game-chat`（接口层 / 游戏聊天） 与 `interfaces/server-bridge`（接口层 / 服务端桥接） 的最小 ingress（入口） 强类型契约，把网页端之外的两条外部输入通道统一收口为可测试的纯消息包边界，为后续“游戏内主人消息进入主线”“服务端桥接事件进入主线”提供同构输入模型；本任务只做消息归一化与边界约束，不接入真实 Mineflayer（Minecraft 协议客户端） / JAR plugin（JAR 插件） / Socket.io（实时推送） / Fastify（高性能 Node.js 框架） / BullMQ（队列） 实例。

**上下文说明**:
1. `T-010` 已建立 `app`（应用装配） 组合根与生命周期骨架，当前主线缺口转为“系统外部输入如何进入统一消息主线”。网页端消息已有 `interfaces/contracts.ts`（接口层契约） 中的标准化包，但游戏聊天与服务端桥接尚未形成独立子模块与统一入口模型。
2. `01_ARCHITECTURE.md`（架构文档） 已把 `interfaces/`（接口层） 明确划分为 `api`（HTTP 接口）、`realtime`（实时推送）、`game-chat`（游戏聊天） 与 `server-bridge`（服务端桥接） 四类边界；其中 `interfaces/` 只负责入口适配与事件广播，不参与 Bot（机器人） 执行逻辑。
3. 已确认 MC（Minecraft） 服务器认证真理源为 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库），并按长期共识将其视为外部认证源；因此本任务禁止把游戏聊天入口与认证库结构、密码字段、PostgreSQL（关系型数据库） 同步逻辑绑死，入口层只负责“消息 / 事件是什么”，不负责“认证数据如何存”。
4. 当前仍坚持最小闭环：只收口统一 ingress（入口） 消息包、桥接事件包、来源判别与基础校验，不做真实聊天监听、真实插件协议、真实入队、真实登录流程或外部数据库访问。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 15 节《模块划分》、第 16 节《目录结构》、第 17 节《身份与交互模型》、第 18 节《Phase 1 范围》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《职责边界》、第 6.1 节《启动序列》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 与消息入口、回复广播、消息标准化相关段落
4. `ts-core/Docs/05_DATA_SPEC.md` — 第 9 节《数据一致性约定》、第 13 节《后续文档依赖》
5. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
6. `ts-core/scripts/pre_review.sh` — 全文件
7. `ts-core/src/index.ts` — 全文件
8. `ts-core/src/domain/contracts.ts` — 全文件
9. `ts-core/src/interfaces/index.ts` — 全文件
10. `ts-core/src/interfaces/contracts.ts` — 全文件
11. `ts-core/src/interfaces/api.ts` — 全文件
12. `ts-core/src/interfaces/realtime.ts` — 全文件
13. `ts-core/src/runtime/events.ts` — 全文件
14. `ts-core/src/workers/index.ts` — 全文件
15. `ts-core/src/workers/contracts.ts` — 全文件
16. `ts-core/src/workers/queues.ts` — 全文件
17. `ts-core/src/conversation/index.ts` — 全文件
18. `ts-core/src/conversation/contracts.ts` — 全文件
19. `ts-core/src/app/index.ts` — 全文件
20. `ts-core/src/app/contracts.ts` — 全文件
21. `ts-core/src/app/bootstrap.ts` — 全文件
22. `ts-core/src/app/smoke.ts` — 全文件
23. `ts-core/src/interfaces/game-chat/index.ts` — 全文件（允许新建）
24. `ts-core/src/interfaces/game-chat/contracts.ts` — 全文件（允许新建）
25. `ts-core/src/interfaces/server-bridge/index.ts` — 全文件（允许新建）
26. `ts-core/src/interfaces/server-bridge/contracts.ts` — 全文件（允许新建）
27. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
28. `ts-core/src/__tests__/interfaces-ingress-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. `game-chat`（游戏聊天） 与 `server-bridge`（服务端桥接） 必须作为 `interfaces`（接口层） 下的子边界建模，只做 ingress（入口） 标准化、来源判别、字段校验与纯数据映射；不得吞并 `conversation`（对话）、`workers`（工作线程） 或 `runtime`（运行时） 的业务职责。
2. 必须把网页端、游戏聊天、服务端桥接三类入口统一到同一套消息 / 事件主线语义：至少保证 `source`（来源）、`bot_id`（机器人标识）、`owner_id`（主人标识，可选时须明确缺席语义）、`message_id`（消息标识） / `event_id`（事件标识）、`channel`（通道） 与 `timestamp`（时间戳） 等关键字段的命名与只读边界一致，不得再造平行字段集。
3. `game-chat`（游戏聊天） 入口必须体现 Phase 1（第一阶段） 的主人约束与命令前缀约束：只建模“可进入主线的标准化消息包”和“应被拒绝 / 忽略的聊天输入判定”，但不得在本任务里接入真实主人绑定查询、真实认证库或真实聊天命令发送。
4. `server-bridge`（服务端桥接） 入口必须建模为只读事件包边界，能够表达“桥接事件进入主线但不直接驱动 Bot 写操作”的约束；不得把它设计成绕过 `runtime`（运行时） 的直接执行通道。
5. 本任务不得引入 EasyAuth（离线服认证模组） / SQLite（嵌入式数据库） / PostgreSQL（关系型数据库） 读取逻辑、不得增加新的核心模块名、不得引入真实 Mineflayer（Minecraft 协议客户端） / Fastify（高性能 Node.js 框架） / Socket.io（实时推送） / BullMQ（队列） / 插件协议依赖；测试优先覆盖根导出、统一字段语义、拒绝路径与只读回归。

**验收标准**:
1. `interfaces/game-chat`（接口层 / 游戏聊天） 与 `interfaces/server-bridge`（接口层 / 服务端桥接） 均已存在最小强类型契约，并从 `interfaces/index.ts`（接口层根入口） 与 `src/index.ts`（源代码根入口） 可见。
2. 三类入口的标准化结果在关键字段命名与来源语义上保持统一，不存在网页 / 游戏 / 桥接各自一套平行消息字段的问题。
3. `game-chat`（游戏聊天） 已能纯函数区分“可进入主线的主人命令消息”与“应拒绝 / 忽略的普通聊天输入”，且不会把真实认证源或真实主人查询耦合进入口层。
4. `server-bridge`（服务端桥接） 已能纯函数表达桥接事件包与只读约束，不会绕过 `runtime`（运行时） / `workers`（工作线程） 直接形成 Bot 写操作入口。
5. 新增测试已覆盖根导出、统一字段边界、拒绝路径与只读语义，且执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-011`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] `game-chat`（游戏聊天） / `server-bridge`（服务端桥接） 仅做入口标准化与字段校验，未吞并 `conversation`（对话） / `workers`（工作线程） / `runtime`（运行时） 职责
- [ ] 三类入口字段命名与 `source`（来源） 语义已统一，不存在新的平行消息字段集
- [ ] 未把 EasyAuth（离线服认证模组） / SQLite（嵌入式数据库） / PostgreSQL（关系型数据库） 读取逻辑耦合进入口层
- [ ] 未引入真实 Mineflayer（Minecraft 协议客户端） / Fastify（高性能 Node.js 框架） / Socket.io（实时推送） / BullMQ（队列） / 插件协议依赖
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- 待填写

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-012: 建立 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 的 accepted / started / terminal（接受 / 开始 / 终态） 事件闭环，补齐无 MC（Minecraft） 任务流转可观测性。
- T-013: 建立外部认证源适配的最小运行时契约，收口“需要认证 / 已认证 / 认证失败”状态与注入式登录密钥边界，但不读取 EasyAuth（离线服认证模组） 数据库。
- T-014: 在本地启动边界与外部认证边界稳定后补部署骨架，收口 `Dockerfile`（容器镜像构建文件） / 启动入口 / 环境变量装配的最小契约。
