# 当前任务握手区

【任务序号】: T-006
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `interfaces`（接口层） 模块的最小会话 / 鉴权 / 推送契约，补齐 HTTP（超文本传输协议） 入口、`Socket.io`（实时推送） 输出与 `event_log`（事件日志） 断线补拉的强类型边界，为后续本地联调与首轮无 MC（Minecraft） 冒烟测试准备统一接口模型，但不启动真实 `Fastify`（Node.js Web 框架） / `Socket.io`（实时推送） 服务，也不接入任何网络 I/O（输入输出）。

**上下文说明**:
1. `T-005` 已完成 `skills`（技能） 模块的技能目录、参数契约与 `SkillRegistry`（技能注册表） 收口；当前离首轮联调最近的缺口转到 `interfaces`（接口层），需要先把网页入口、状态查询、登录鉴权与事件补拉这些“外部边界”稳定下来。
2. `01_ARCHITECTURE.md` 明确要求：`interfaces`（接口层） 只负责 `Fastify`（Node.js Web 框架） 路由、`Socket.io`（实时推送） 推送、游戏聊天适配与 server-bridge（服务端桥接） 入口，不参与 `Bot`（机器人） 执行逻辑；因此本任务只做纯契约与纯函数构造，不得越界触碰 `runtime`（运行时） 内部执行实现。
3. `05_DATA_SPEC.md` 已给出 `sessions`（会话） 表、`event_log`（事件日志） 表与断线补拉查询模式；本任务要把这些持久化约束投影成稳定的接口输入输出模型，避免后续 API（应用编程接口） / 推送层各自再造一套平行命名。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节中 API（应用编程接口） 网关 / 实时推送段落、第 8.2 节《append-only Event Log》、第 8.3 节《断线重连协议》、第 15 节《模块划分》、第 16 节《目录结构》、第 17 节《身份与交互模型》
2. `ts-core/Docs/05_DATA_SPEC.md` — 第 2.3 节中的 `sessions`（会话） / `chat_messages`（聊天消息） / `event_log`（事件日志） 表定义、第 6.1 节《断线补拉》
3. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/src/index.ts` — 全文件
6. `ts-core/src/domain/contracts.ts` — 全文件
7. `ts-core/src/data/contracts.ts` — 全文件
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/runtime/events.ts` — 全文件
10. `ts-core/src/interfaces/index.ts` — 全文件（允许新建）
11. `ts-core/src/interfaces/contracts.ts` — 全文件（允许新建）
12. `ts-core/src/interfaces/api.ts` — 全文件（允许新建）
13. `ts-core/src/interfaces/realtime.ts` — 全文件（允许新建）
14. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
15. `ts-core/src/__tests__/interfaces-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `interfaces`（接口层） 模块中至少拆清四类概念：HTTP（超文本传输协议） 路由输入输出契约、会话 / token（令牌） 鉴权边界、`Socket.io`（实时推送） 事件模型、`event_log`（事件日志） 断线补拉请求 / 响应模型；不得启动真实服务器、注册真实路由、发起真实网络连接。
2. `sessions`（会话） / 鉴权模型必须对齐 `05_DATA_SPEC.md` 中的轻身份约束：登录 token（令牌） 直查表、7 天有效、支持过期判定；当前阶段只做类型与纯函数边界，不写数据库查询实现，不引入 JWT（JSON Web Token） 或额外鉴权依赖。
3. `interfaces`（接口层） 的消息入口必须坚持聊天驱动约束：网页端输入只建模为消息提交 / 状态查询 / 健康检查 / 事件补拉 / 登录鉴权等接口，不得在接口模型里引入直接操作 `Bot`（机器人） 的旁路命令。
4. `event_log`（事件日志） 补拉与实时推送命名必须复用现有 `runtime/events.ts` 中的事件类型，不得再造平行事件字符串集；补拉模型要显式承载 `bot_id`、`after_seq`、`limit`、状态快照与事件列表边界。
5. 测试优先覆盖：接口模块根导出、登录 / 会话 / 消息提交 / 状态查询 / 断线补拉契约、实时推送事件对齐、负向类型约束；不要写依赖真实 `Fastify`（Node.js Web 框架） / `Socket.io`（实时推送） / 数据库 / 文件系统 / 网络的测试。

**验收标准**:
1. `interfaces`（接口层） 模块已落地，不再缺席于 `src/`（源代码） 主线结构与根导出边界。
2. 会话 / token（令牌） 鉴权、`POST /api/message`、`GET /api/status`、`GET /api/health`、`GET /api/replay` 的输入输出契约均已具备强类型模型或纯函数构造边界。
3. `Socket.io`（实时推送） 事件与 `event_log`（事件日志） 补拉结果复用同一套运行时事件命名，不存在平行字符串集或直接 `Bot`（机器人） 控制入口。
4. 新增测试覆盖接口契约、补拉边界、实时事件对齐与根导出；没有真实服务器启动、没有网络 I/O（输入输出）、没有执行链路副作用。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-006`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实 `Fastify`（Node.js Web 框架） / `Socket.io`（实时推送） 启动代码、数据库查询实现或网络 I/O（输入输出）
- [ ] 接口契约、会话鉴权、实时事件与 replay（补拉） 边界已对齐白名单文档和既有运行时事件命名
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-006
- **修改文件**:
  - （待填写）
- **执行摘要**:
  - （待填写）
- **自检结果**:
  - [ ] 任务序号核对为 `T-006`
  - [ ] 仅读取并修改白名单内文件
  - [ ] 新增导出符号均补充中文文档注释
  - [ ] 未引入真实 `Fastify`（Node.js Web 框架） / `Socket.io`（实时推送） 启动代码、数据库查询实现或网络 I/O（输入输出）
  - [ ] 接口契约、会话鉴权、实时事件与 replay（补拉） 边界已对齐白名单文档和既有运行时事件命名
  - [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过
- **预检输出摘要**:
  - （待填写）
- **遗留疑问**: （待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-007: 建立 `sandbox`（沙箱） / `diagnostics`（诊断） 的最小契约，补齐只读 `Facade API`（门面接口）、JSONL（结构化日志） 诊断事件与代码执行边界。
- T-008: 建立 `conversation`（对话） / `workers`（工作线程） 的最小任务流转契约，连接消息分诊、规划输出与队列入口类型。
- T-009: 建立本地应用装配与首轮无 MC（Minecraft） 冒烟闭环骨架，串起 `interfaces`（接口层）、`workers`（工作线程） 与 `runtime`（运行时） 的启动边界。
