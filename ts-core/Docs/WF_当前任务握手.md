# 当前任务握手区

【任务序号】: T-012
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 之间的任务生命周期事件闭环，把 `accepted`（已接受） / `started`（已开始） / `discarded`（已丢弃） / `terminal`（终态） 相关事件与动作收口为可测试的纯契约，确保“消息入执行队列后如何形成统一事件流与诊断摘要”有同一套强类型表达；本任务只做类型、纯函数与动作建模，不接入真实 BullMQ（队列） / PostgreSQL（关系型数据库） / JSONL（结构化日志） 文件写入。

**上下文说明**:
1. `T-011` 已完成网页端、游戏聊天、服务端桥接三类 ingress（入口） 的统一标准化，当前主线缺口转为“进入主线后的执行任务如何形成 accepted / started / terminal（已接受 / 已开始 / 终态） 事件闭环并保持可观测”。
2. `01_ARCHITECTURE.md`（架构文档） 与 `02_RUNTIME_SPEC.md`（运行时规格） 已明确要求：任务进入 exec（执行） 队列时写 `task.accepted`，BotWorker（机器人工作线程） 取出后进入 `task.started`，执行结束后统一收口到 `task.completed` / `task.failed` / `task.interrupted`，epoch（意图纪元） 过期任务走 `task.discarded`；这些事件同时服务于 event_log（事件日志）、replay（补拉） 与调试。
3. 当前仓内已有 `runtime/events.ts`（运行时事件）、`runtime/tasking.ts`（执行任务）、`workers/contracts.ts`（工作线程动作）、`diagnostics/contracts.ts`（诊断日志） 等骨架，但 accepted / started / discarded / terminal（已接受 / 已开始 / 已丢弃 / 终态） 仍分散在枚举、动作和日志行中，缺少统一的任务生命周期类型闭环。
4. 本任务继续坚持模块边界：`runtime`（运行时） 负责事件类型与状态语义，`workers`（工作线程） 负责消费 / 产出动作建模，`diagnostics`（诊断） 负责日志摘要契约；不得把 PG（关系型数据库） 写入、BullMQ（队列） 实例控制或真实恢复扫描逻辑塞进这批契约层代码。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 3.2 节《全链路数据流》、第 8 节《Event Protocol》、第 15 节《模块划分》、第 18 节《Phase 1 范围》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《职责边界》、第 2 节《状态机》、第 5.1 节《BotWorker 与 BotActor 的关系》、第 6.1 节《启动序列》、第 8 节《事件发射》
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 2.3 节《全表一览》中 `event_log` / `task_history` 段落、第 6 节《event_log 查询模式》、第 9 节《数据一致性约定》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/src/index.ts` — 全文件
7. `ts-core/src/runtime/index.ts` — 全文件
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/runtime/events.ts` — 全文件
10. `ts-core/src/runtime/tasking.ts` — 全文件
11. `ts-core/src/workers/index.ts` — 全文件
12. `ts-core/src/workers/contracts.ts` — 全文件
13. `ts-core/src/workers/queues.ts` — 全文件
14. `ts-core/src/diagnostics/index.ts` — 全文件
15. `ts-core/src/diagnostics/contracts.ts` — 全文件
16. `ts-core/src/interfaces/realtime.ts` — 全文件
17. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件
18. `ts-core/src/__tests__/conversation-workers-model.spec.ts` — 全文件
19. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件
20. `ts-core/src/__tests__/runtime-worker-event-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 必须把 `task.accepted` / `task.started` / `task.discarded` / `task.completed` / `task.failed` / `task.interrupted` 相关 payload（载荷） 与状态语义收口为同一套运行时生命周期契约；不得继续让 `runtime`（运行时）、`workers`（工作线程）、`diagnostics`（诊断） 各自维护一套平行字段名。
2. `workers`（工作线程） 侧必须能纯函数表达以下动作边界：ConversationWorker（对话工作线程） 产出 accepted（已接受） 事件意图，BotWorker（机器人工作线程） 产出 started / discarded / terminal（已开始 / 已丢弃 / 终态） 事件意图，BrainWorker（摘要工作线程） 只消费终态任务；不得把真实队列消费、数据库写入或 Bot 写操作塞进动作构造器。
3. `diagnostics`（诊断） 侧必须补齐与任务生命周期一致的最小 JSONL（结构化日志） 摘要契约，至少保证 started（已开始） 与 terminal（终态） 语义和运行时事件对齐；不得再造与 `TaskHistoryStatus`（任务历史状态） 平行的终态字符串集。
4. 必须显式表达 `discarded`（已丢弃） 与真正终态的区别：`discarded` 表示过期 / 不执行的 exec job（执行任务），不能错误进入 BrainWorker（摘要工作线程） 终态处理链，也不能伪装成 `failed`（失败）。
5. 本任务不得引入真实 BullMQ（队列） / PostgreSQL（关系型数据库） / JSONL（结构化日志） 文件 I/O、不得新增核心模块名、不得接入启动恢复扫描或真实 replay（补拉） 查询；只补齐契约、纯函数与测试。

**验收标准**:
1. `runtime`（运行时） 已存在统一的任务生命周期事件类型 / 载荷构造边界，能够无歧义表达 accepted / started / discarded / terminal（已接受 / 已开始 / 已丢弃 / 终态） 语义。
2. `workers`（工作线程） 已能纯函数产出 accepted（已接受） / started（已开始） / discarded（已丢弃） / terminal（终态） 的动作或事件构造结果，且 BrainWorker（摘要工作线程） 只接收真实终态任务。
3. `diagnostics`（诊断） 中 tasks（任务执行） 通道的开始 / 终态摘要契约已与运行时事件和 `TaskHistoryStatus`（任务历史状态） 对齐，不存在新的平行状态字符串集。
4. 新增或更新测试已覆盖 accepted / started / discarded / terminal（已接受 / 已开始 / 已丢弃 / 终态） 闭环、丢弃与终态分流、根导出可见性与只读边界。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-012`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 仅补齐任务生命周期契约与纯函数，未接入真实 BullMQ（队列） / PostgreSQL（关系型数据库） / JSONL（结构化日志） 文件 I/O
- [ ] `accepted` / `started` / `discarded` / `terminal`（已接受 / 已开始 / 已丢弃 / 终态） 字段命名与 `TaskHistoryStatus`（任务历史状态） 语义已统一，不存在新的平行状态集
- [ ] `discarded`（已丢弃） 未被错误送入 BrainWorker（摘要工作线程） 终态链路
- [ ] 未新增核心模块名，未越过 `runtime`（运行时） / `workers`（工作线程） / `diagnostics`（诊断） 边界吞并其他模块职责
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- 回填序号：
- 修改文件：
- 执行摘要：
- 预检输出摘要：
- 遗留疑问：

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-013: 建立外部认证源适配的最小运行时契约，收口“需要认证 / 已认证 / 认证失败”状态与注入式登录密钥边界，但不读取 EasyAuth（离线服认证模组） 数据库。
- T-014: 在本地启动边界与外部认证边界稳定后补部署骨架，收口 `Dockerfile`（容器镜像构建文件） / 启动入口 / 环境变量装配的最小契约。
- T-015: 收口 `event_log`（事件日志） / replay（补拉） / diagnostics（诊断） 的持久化对齐边界，为后续真实写入层实现预留稳定契约。
