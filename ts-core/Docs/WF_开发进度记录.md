# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-011` ~ `T-020`
- 当前已完成任务：`T-011`、`T-012`、`T-013`、`T-014`、`T-015`、`T-016`、`T-017`
- 当前批次摘要：已完成外部输入统一 ingress（入口） 契约、执行任务生命周期闭环契约、`runtime`（运行时） / `data`（数据配置） / `db`（数据库元信息） / `app`（应用装配） 侧的外部认证纯契约与启动语义对齐、最小本地启动 / 容器骨架、`event_log`（事件日志） / `task_history`（任务历史） / `JSONL`（结构化日志） / `replay`（补拉） 的纯持久化边界、“外部认证待执行 → 受控登录命令计划 → ready（就绪） 门控”的最小执行骨架，以及 `domain`（领域） 横切基础层上的共享不变量 / 通用只读辅助收口；接口层、运行时层、装配层、持久化层与基础契约层已经形成同一套可测试的强类型模型。

### 2026-04-14 批次调度调整

- 调整原因：
  当前批次完成到 `T-017`（任务十七） 后，主干纯契约骨架已经覆盖核心模块；继续把 `T-018` ~ `T-020`（任务十八到二十） 全部用于 BrainWorker（摘要工作线程） / 部署文档 / 诊断占位等支线项，会延后真实 I/O（输入输出） 集成风险的暴露，也不利于尽快形成可运行 demo（演示）。
- 新的排序原则：
  保持“按模块批量下发”的切分方式不变，但从 `T-018`（任务十八） 起转为 **MVP（最小可运行闭环） 关键路径优先**。
- 重排结果：
  - `T-018`：改为 PostgreSQL（关系型数据库） / Redis（缓存） 真实连接与 Drizzle（数据库工具） 迁移运行入口
  - `T-019`：改为 BullMQ（任务队列） / Fastify（接口网关） 真实启动骨架
  - `T-020`：改为 Mineflayer（Minecraft 协议客户端） / observation（观测） / BotActor（机器人执行代理） 最小上线闭环
- 后移说明：
  原先计划中的 BrainWorker（摘要工作线程） 摘要 / 检索纯契约、部署文档补写、诊断占位边界，统一后移到关键链路跑通之后再排，默认落到 `T-026+`（任务二十六以后） 区间重新收口。
- 序号规则：
  `T-018`（任务十八） 尚未完成，因此保留原序号并重写任务内容；`T-011` ~ `T-017`（任务十一到十七） 已完成记录保持不变，不回排、不改号。

---

## 详细记录

### T-011（已完成）

- 任务目标：
  建立 `interfaces/game-chat`（接口层 / 游戏聊天） 与 `interfaces/server-bridge`（接口层 / 服务端桥接） 的最小 ingress（入口） 强类型契约，把网页端之外的两条外部输入通道统一收口为可测试的纯消息包 / 事件包边界。

- 审查结论：
  通过。首轮审查曾因 `game-chat`（游戏聊天） 把游戏发送者标识与内部 `owner_id`（主人标识） 混成同一标识空间而打回；本轮已改为显式接收 `owner_resolution`（主人绑定解析结果），并补上“发送者标识与内部 `owner_id` 不同但已匹配主人时仍可 accepted（接受）”的回归测试，逻辑问题已消除。

- 核心文件：
  `ts-core/src/interfaces/contracts.ts`
  `ts-core/src/interfaces/index.ts`
  `ts-core/src/interfaces/game-chat/contracts.ts`
  `ts-core/src/interfaces/server-bridge/contracts.ts`
  `ts-core/src/__tests__/interfaces-ingress-model.spec.ts`

- 变更快照：
  统一网页端、游戏聊天、服务端桥接三类入口的 `bot_id` / `owner_id` / `message_id` 或 `event_id` / `source` / `channel` / `timestamp` 字段语义，并把网页消息包切到统一消息包构造器。
  `game-chat`（游戏聊天） 新增 `owner_resolution`（主人绑定解析结果） 状态模型，accepted（接受） 路径只消费已解析出的内部 `owner_id`，不再通过 `sender_id === owner_id` 做跨标识空间比较。
  `server-bridge`（服务端桥接） 固定输出 `runtime_effect: "observe_only"`，并对嵌套 `payload`（载荷） 保持深只读克隆。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `11` 个测试文件、`56` 条测试全部通过。

### T-012（已完成）

- 任务目标：
  建立 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 之间的任务生命周期事件闭环，把 `accepted`（已接受） / `started`（已开始） / `discarded`（已丢弃） / `terminal`（终态） 相关事件与动作收口为可测试的纯契约。

- 审查结论：
  通过。首轮审查曾因 `ts-core/src/workers/contracts.ts` 在 `failed`（失败） / `interrupted`（中断） 终态分支里伪造默认 `error`（错误快照） 与默认中断原因而打回；本轮已改为按 `status`（状态） 判别的强类型联合，并补上缺少 `error`、`interrupt_source`（中断来源） 或 `reason`（中断原因） 时立即抛错的负向回归测试，终态语义已与 `runtime/events.ts`（运行时事件） 和 `02_RUNTIME_SPEC.md`（运行时规格） 对齐。

- 核心文件：
  `ts-core/src/runtime/tasking.ts`
  `ts-core/src/runtime/events.ts`
  `ts-core/src/runtime/index.ts`
  `ts-core/src/workers/contracts.ts`
  `ts-core/src/workers/index.ts`
  `ts-core/src/diagnostics/contracts.ts`
  `ts-core/src/diagnostics/index.ts`
  `ts-core/src/__tests__/runtime-model.spec.ts`
  `ts-core/src/__tests__/conversation-workers-model.spec.ts`
  `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts`
  `ts-core/src/__tests__/runtime-worker-event-model.spec.ts`

- 变更快照：
  `runtime`（运行时） 统一收口 `task.accepted` / `task.started` / `task.discarded` / `task.completed` / `task.failed` / `task.interrupted` 的状态枚举、事件名映射、强类型载荷与 `event_log`（事件日志） 包装边界。
  `workers`（工作线程） 侧将 ConversationWorker（对话工作线程） 的 accepted（已接受） 意图、BotWorker（机器人工作线程） 的 started / discarded / terminal（已开始 / 已丢弃 / 终态） 分流与 BrainWorker（摘要工作线程） 的“只消费真实终态”约束收敛到同一组纯动作构造器。
  `diagnostics`（诊断） 侧补齐与任务生命周期对齐的 tasks（任务执行） 摘要契约，不再维护独立的平行终态字符串集。
  终态校验已在 `workers/contracts.ts`（工作线程契约） 明确禁止默认兜底：`failed` 缺少 `error` 立即抛错，`interrupted` 缺少 `interrupt_source` 或 `reason` 立即抛错。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `12` 个测试文件、`64` 条测试全部通过。

### T-013（已完成）

- 任务目标：
  在 `runtime`（运行时） / `data`（数据配置） / `db`（数据库元信息） / `app`（应用装配） 这一组紧邻模块内，集中完成外部认证契约收口与当前已确认的一致性修补：把“是否需要认证、认证进行中、已认证、认证失败”与“明文登录密钥只允许通过部署注入”收口为同一套纯类型 / 纯函数边界，同时清除 `authme schema`（旧认证模式） 残留、修正 `sandbox`（沙箱） 日志保留期绑定错误、对齐 `INITIALIZING`（初始化） / `REFLEXING`（反射中） 的状态机语义。

- 审查结论：
  通过。本轮改动已把 `runtime`（运行时） 内的外部认证状态、`app/bootstrap`（应用装配） 的纯装配结果、`db/contracts.ts`（数据库契约） 的 `authme`（旧认证模式） 残留，以及 `data/contracts.ts`（数据配置契约） 中 `sandbox`（沙箱） 保留期的错误绑定一起收平；`INITIALIZING`（初始化） 默认起始态和 `REFLEXING`（反射中） 中断排队语义也已与 `02_RUNTIME_SPEC.md`（运行时规格） 对齐。

- 核心文件：
  `ts-core/src/runtime/contracts.ts`
  `ts-core/src/runtime/state-machine.ts`
  `ts-core/src/runtime/index.ts`
  `ts-core/src/data/contracts.ts`
  `ts-core/src/db/contracts.ts`
  `ts-core/src/app/contracts.ts`
  `ts-core/src/app/bootstrap.ts`
  `ts-core/src/__tests__/runtime-model.spec.ts`
  `ts-core/src/__tests__/db-config-model.spec.ts`
  `ts-core/src/__tests__/app-smoke-model.spec.ts`
  `ts-core/src/__tests__/scaffold.spec.ts`

- 变更快照：
  `runtime`（运行时） 新增统一的 `ExternalAuthState`（外部认证状态） / `ExternalAuthSecretBinding`（外部认证密钥绑定） 契约，并将 `createRuntimeScaffold()`（创建运行时骨架） 的默认状态切换为 `INITIALIZING`（初始化）。
  `runtime/state-machine.ts`（运行时状态机） 将 `REFLEXING`（反射中） 收到中断时的处置从 `ignore`（忽略） 改为 `queue`（排队），并让 `resolveTransition()`（状态转换） 可观测暴露 `interrupt_action`（中断处置动作）。
  `data/contracts.ts`（数据配置契约） 为 `sandbox`（沙箱） 日志保留期补上独立的 `SANDBOX_LOG_RETENTION_DAYS` / `SANDBOX_LOG_RETENTION` 环境变量绑定，不再复用任务日志配置。
  `db/contracts.ts`（数据库契约） 的 `readonlySchemas`（只读模式） 已清空，不再暗示外部认证存在于 PostgreSQL（关系型数据库） 业务库内。
  `app/bootstrap.ts`（应用装配） 新增纯函数 `createAppExternalAuthContract()`（创建应用外部认证装配结果），可无 IO（输入输出） 地表达“无需认证 / 缺少密钥失败 / 已注入密钥待认证”三类装配结果，并把结果暴露到 `bootstrap.auth` 与 `runtime.external_auth`。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `12` 个测试文件、`66` 条测试全部通过。

### T-014（已完成）

- 任务目标：
  在 `app`（应用装配） / 项目打包入口这一组模块内，补齐 TS Core（TypeScript 单核心） 的最小本地启动与容器化骨架：建立专用可执行入口、把纯装配结果转成可读的启动摘要，并收口 `Dockerfile`（容器镜像构建文件） / `.dockerignore`（容器忽略文件） / `package.json`（项目清单） 脚本与最小运行说明。

- 审查结论：
  通过。首轮审查曾因 `package.json`（项目清单） 的 `main` / `types`（库入口元信息） 仍指向不存在的构建产物，以及 `Dockerfile`（容器文件） 会把测试产物一起带入运行镜像而打回；本轮已把库入口元信息对齐到真实产物路径，并将运行镜像复制范围收口到 `dist/src`，`tsconfig.json`（编译配置） 也已排除 `src/__tests__`（测试目录），打包边界与运行边界已经一致。

- 核心文件：
  `ts-core/package.json`
  `ts-core/tsconfig.json`
  `ts-core/README.md`
  `ts-core/Dockerfile`
  `ts-core/.dockerignore`
  `ts-core/.env.example`
  `ts-core/src/app/index.ts`
  `ts-core/src/app/entrypoint.ts`
  `ts-core/src/main.ts`
  `ts-core/src/__tests__/app-entrypoint-model.spec.ts`
  `ts-core/src/__tests__/scaffold.spec.ts`

- 变更快照：
  `app/entrypoint.ts`（应用启动入口） 新增纯函数启动摘要构造与可注入输出执行器，`main.ts`（可执行入口） 只负责读取环境变量、装配 `createAppBootstrapContract()`（应用装配结果） 并打印摘要，不混入真实 Redis（缓存） / PostgreSQL（关系型数据库） / Fastify（接口网关） / Socket.io（实时推送） / Mineflayer（Minecraft 协议客户端） 连接。
  `package.json`（项目清单） 的 `dev` / `start`（开发 / 运行） 脚本已经统一切到 `src/main.ts` / `dist/src/main.js`，并把 `main` / `types`（库入口元信息） 对齐到实际编译产物 `dist/src/index.js` 与 `dist/src/index.d.ts`。
  `Dockerfile`（容器文件） / `.dockerignore`（容器忽略文件） / `README.md`（运行说明） / `.env.example`（环境变量样例） 已形成最小单进程容器骨架；运行镜像只复制 `dist/src`，不再把测试产物一并带入。
  `app-entrypoint`（应用启动入口） 测试补齐了脚本 / 镜像命令 / 库入口元信息 / 测试目录排除的关键断言，锁死了本轮修复点。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `13` 个测试文件、`69` 条测试全部通过。

### T-015（已完成）

- 任务目标：
  在 `db`（数据库元信息） / `data`（数据持久化契约） / `diagnostics`（诊断） / `interfaces`（接口补拉） 这一组紧邻模块内，集中收口 `event_log`（事件日志） / `task_history`（任务历史） / `JSONL`（结构化日志） / `replay`（补拉） 的纯契约边界，为后续真实写入层与补拉接口实现预留一致、可测试、不可变的持久化模型。

- 审查结论：
  通过。首轮审查曾因 `task_history.log_ref`（任务日志引用） 被硬编码为只接受 `tasks/*.jsonl` 而打回，这会让 `sandbox_code`（沙箱代码） 任务与既有 `diagnostics`（诊断） `sandbox`（沙箱） 通道规则冲突；本轮已改为按任务类型分别校验 `log_ref`，并把回归测试改成覆盖“合法 `sandbox/*.jsonl + sandbox/*.code.ts` 可通过”，`skill_call`（技能调用） 误用 `sandbox` 路径仍会被拒绝。

- 核心文件：
  `ts-core/src/data/contracts.ts`
  `ts-core/src/data/schema.ts`
  `ts-core/src/diagnostics/contracts.ts`
  `ts-core/src/interfaces/api.ts`
  `ts-core/src/interfaces/realtime.ts`
  `ts-core/src/__tests__/data-model.spec.ts`
  `ts-core/src/__tests__/interfaces-model.spec.ts`
  `ts-core/src/__tests__/persistence-replay-model.spec.ts`

- 变更快照：
  `data/contracts.ts`（数据契约） 收口了 `event_log`（事件日志） / `task_history`（任务历史） 的纯记录模型、`step.progress`（步骤进度） 载荷、终态补丁构造器、未闭合任务检测输入输出，以及可测试的 `TASK_PERSISTENCE_WRITE_SEQUENCE`（持久化写入顺序） / `createTaskPersistencePlan()`（持久化计划构造器）。
  `interfaces/api.ts`（补拉接口） / `interfaces/realtime.ts`（实时事件） 明确了 `replay`（补拉） 的 `bot_id + after_seq + limit` 过滤、默认 / 封顶 `50`、升序返回与深只读切边。
  `diagnostics/contracts.ts`（诊断契约） 复用 `data`（数据层） 的步骤状态常量，避免 `progress`（进度） 状态枚举漂移；`data/schema.ts`（数据表结构） 也把 `task_history.error`（任务历史错误快照） 收紧到结构化错误类型。
  本轮返修额外修正了 `task_history.log_ref`（任务日志引用） 的任务类型分流：`skill_call`（技能调用） 对齐 `tasks/*.jsonl`，`sandbox_code`（沙箱代码） 对齐 `sandbox/*.jsonl` + `sandbox/*.code.ts`。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `14` 个测试文件、`76` 条测试全部通过。

### T-016（已完成）

- 任务目标：
  在 `runtime`（运行时） / `app`（应用装配） / `interfaces`（接口边界） 这一组紧邻模块内，补齐“外部认证待执行 → 受控登录命令计划 → 认证完成 / 失败门控”的最小执行骨架，把外部认证从静态状态描述推进到可测试的纯动作模型与就绪门控模型。

- 审查结论：
  通过。首轮审查曾因 `ExternalAuthState`（外部认证状态） 与 `AppBootstrapContract`（应用装配结果） 长期驻留并暴露明文 `secret`（密钥） 而打回；本轮已改为“状态只保留来源 / 引用元信息，明文只存在于一次性执行动作载荷中”，并把 `runtime`（运行时） / `app`（应用装配） 对外边界统一收口为脱敏公开视图，阻塞问题已消除。

- 核心文件：
  `ts-core/src/runtime/contracts.ts`
  `ts-core/src/app/bootstrap.ts`
  `ts-core/src/runtime/index.ts`
  `ts-core/src/__tests__/runtime-model.spec.ts`
  `ts-core/src/__tests__/app-smoke-model.spec.ts`
  `ts-core/src/__tests__/scaffold.spec.ts`
  `ts-core/src/__tests__/external-auth-execution-model.spec.ts`

- 变更快照：
  `runtime/contracts.ts`（运行时契约） 已将 `pending`（待执行） / `authenticated`（已认证） 状态中的明文 `secret`（密钥） 移出长期状态，只保留 `secret_source`（密钥来源） 与 `secret_reference`（密钥引用） 等元信息；`createExternalAuthExecutionPlan()`（外部认证执行计划构造器） 只有在显式注入一次性 `ExternalAuthSecretBinding`（密钥绑定） 时才会生成带明文 `/login ...` 的最小动作载荷。
  `app/bootstrap.ts`（应用装配） 不再把原始 `runtime.external_auth`（运行时外部认证状态） 与带明文动作的 `runtime.scaffold`（运行时骨架） 直接暴露到公开装配结果；公开边界已改为脱敏 `ExternalAuthPublicState`（外部认证公开状态） 与去明文化的 `AppRuntimeScaffoldContract`（应用运行时骨架公开契约）。
  回归测试已从“能读到明文”改为锁定“只有执行动作计划含明文，状态对象、骨架公开视图、装配输出与接口快照均不含明文”，同时保留 `ready_gate`（就绪门控） 与 `pending`（待执行） / `failed`（失败） 阻断路径断言。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `15` 个测试文件、`80` 条测试全部通过。

### T-017（已完成）

- 任务目标：
  在 `domain`（领域） + 若干纯契约模块这一组紧邻模块内，集中沉淀可复用的基础 `invariants`（不变量校验） / 只读辅助工具，替换当前散落的重复 `assertNonEmptyString`（非空字符串断言） 与少量重复只读克隆逻辑，并同步补记 `01_ARCHITECTURE.md`（架构文档） 中 `domain`（领域） 作为横切基础层的定位。

- 审查结论：
  通过。本轮抽取保持在“真通用基础工具”边界内，没有把运行时、接口层或数据层私有 shape（数据形状） 倒灌进 `domain`（领域）；白名单内重复的 `assertNonEmptyString`（非空字符串断言） 已全部收口到共享实现，`cloneReadonlyValue`（通用深只读克隆） 的替换点也仍保持原有深克隆 / 深冻结语义，没有引入新的业务语义漂移。

- 核心文件：
  `ts-core/Docs/01_ARCHITECTURE.md`
  `ts-core/src/domain/index.ts`
  `ts-core/src/domain/invariants.ts`
  `ts-core/src/runtime/contracts.ts`
  `ts-core/src/interfaces/contracts.ts`
  `ts-core/src/interfaces/api.ts`
  `ts-core/src/interfaces/game-chat/contracts.ts`
  `ts-core/src/interfaces/server-bridge/contracts.ts`
  `ts-core/src/app/bootstrap.ts`
  `ts-core/src/db/contracts.ts`
  `ts-core/src/db/connection.ts`
  `ts-core/src/db/keys.ts`
  `ts-core/src/conversation/chat.ts`
  `ts-core/src/conversation/planning.ts`
  `ts-core/src/conversation/triage.ts`
  `ts-core/src/diagnostics/logs.ts`
  `ts-core/src/workers/contracts.ts`
  `ts-core/src/workers/queues.ts`
  `ts-core/src/sandbox/execution.ts`
  `ts-core/src/__tests__/scaffold.spec.ts`
  `ts-core/src/__tests__/domain-invariants-model.spec.ts`

- 变更快照：
  `domain/invariants.ts`（领域基础不变量） 新增共享 `assertNonEmptyString`（非空字符串断言） 与 `cloneReadonlyValue`（通用深只读克隆），`domain/index.ts`（领域根导出） 与模块边界说明也已同步暴露这两个共享工具。
  `runtime`（运行时） / `interfaces`（接口边界） / `app`（应用装配） / `db`（数据库） / `conversation`（对话） / `diagnostics`（诊断） / `workers`（工作线程） / `sandbox`（沙箱） 白名单模块已移除本地重复实现，统一改为单向依赖 `domain`（领域） 共享基础工具。
  `01_ARCHITECTURE.md`（架构文档） 已明确 `domain`（领域） 是跨七层复用的横切基础契约层，而不是新的业务执行层；目录结构说明也同步补记了 `domain/`（领域目录） 的职责边界。
  新增 `domain-invariants-model.spec.ts`（领域基础不变量测试），并更新 `scaffold.spec.ts`（工程骨架测试），锁定共享导出、代表性报错语义、深只读冻结行为以及根导出可见性。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `16` 个测试文件、`83` 条测试全部通过。
