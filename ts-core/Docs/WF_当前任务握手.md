# 当前任务握手区

【任务序号】: T-002
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `runtime` 与 `domain` 的执行态模型，补齐 BotActor 状态流转、执行任务载荷、事件类型映射与最小纯函数化校验边界，为后续数据层与 observation（观测）接入提供稳定契约。

**上下文说明**:
1. `T-001` 已完成工程骨架与基础契约落地，当前需要把执行层模型从“枚举占位”推进到“可约束状态流转与事件映射”的纯类型阶段。
2. 本任务仍然不写 Mineflayer、BullMQ、Fastify、数据库或 Socket.io 实现，只允许写纯类型、纯函数、常量表与测试。
3. `T-001` 留下的一个非阻塞注意项是 `domain/index.ts` 的占位导出字符串未同步新命名；本任务允许顺手收口。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 1 节《五条不可破坏的约束》、第 3.1 节《队列划分》、第 3.2 节《全链路数据流》、第 3.3 节《消息入口 Control 快路径规则》
2. `ts-core/Docs/02_RUNTIME_SPEC.md` — 第 1 节《BotActor 核心定位》、第 2 节《状态机完整定义》、第 3 节《中断协议详细规格》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 1 节《ConversationWorker 核心定位》、第 2.2 节《调用流程》、第 2.3 节《cancel 的特殊处理》、第 5.1 节《输出格式选择：skill_call 优先》
4. `ts-core/Docs/05_DATA_SPEC.md` — 第 1 节《持久化分层总览》、第 2.3 节《event_log》、第 2.3 节《task_history》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/src/index.ts` — 全文件
7. `ts-core/src/domain/index.ts` — 全文件
8. `ts-core/src/domain/contracts.ts` — 全文件
9. `ts-core/src/runtime/index.ts` — 全文件
10. `ts-core/src/runtime/contracts.ts` — 全文件
11. `ts-core/src/runtime/state-machine.ts` — 全文件（允许新建）
12. `ts-core/src/runtime/events.ts` — 全文件（允许新建）
13. `ts-core/src/runtime/tasking.ts` — 全文件（允许新建）
14. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
15. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `domain` 与 `runtime` 中拆清三类概念：对话入口任务、执行任务、运行时状态流转。命名必须直接对应白名单文档，不得重新发明同义概念。
2. 抽出执行层任务契约，至少覆盖 `skill_call`、`sandbox_code`、`intent_epoch`、快照时间戳、优先级或中断相关最小字段，并保持为纯类型或纯构造辅助函数，不接队列实现。
3. 建立 `runtime` 的纯函数状态流转模型：至少能表达合法状态集合、触发事件或原因、合法转换校验，以及中断进入 `IDLE` 或 `REFLEXING` 的基础判断；不要写真实 Actor（执行代理）类。
4. 建立事件类型常量或类型映射，至少覆盖 `05_DATA_SPEC.md` 中列出的 `event_log` 核心事件名，并让运行时侧能以类型安全方式引用，而不是散落字符串。
5. 同步更新测试，验证状态流转规则、执行任务类型边界与事件类型清单；测试应优先覆盖纯函数与常量映射，不要写“只检查对象存在”的空心断言。

**验收标准**:
1. `runtime` 目录内新增的执行态模型均为纯类型、纯函数或常量映射，没有 Mineflayer、网络、数据库、队列实例化代码。
2. `BotActor` 状态集合、关键中断来源与基础状态流转规则能在代码中被直接表达，并且测试覆盖至少一个合法转换和一个非法转换或拒绝场景。
3. 执行任务契约已与对话入口任务明确区分，且不再把 ConversationWorker（对话工作线程）输入混入 BotActor（机器人执行代理）执行边界。
4. `event_log` 核心事件名已集中收敛到类型安全出口，命名与 `05_DATA_SPEC.md` 一致。
5. `domain/index.ts` 的占位导出说明已与当前契约命名同步，不再保留 `TaskKind` 旧名残留。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-002`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入 Mineflayer、数据库、队列或网络实现
- [ ] 状态流转与事件命名均对齐白名单文档
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- **问题定位**: （文件名、函数名或行号）
- **期望行为**: （具体说明应该怎么改）
- **修改范围**: （明确只需改哪些地方）
- **历史反馈保留**: 是/否

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-002
- **修改文件**: （列表）
- **执行摘要**: （简述做了什么）
- **自检结果**: （逐项勾选）
- **预检输出摘要**: （粘贴脚本关键输出）
- **遗留疑问**: （如有）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-003: 建立 `data` 模块的 PostgreSQL（关系型数据库）/日志边界，沉淀 schema（模式）、表结构与日志引用抽象。
- T-004: 建立 `observation` 与 `world-model` 的只读快照模型，补齐双数据源融合、威胁评估输入输出与快照边界。
- T-005: 建立 `skills` 模块的 Phase 1 技能目录与 `skill_call` 参数契约，连接执行任务模型与后续沙箱/技能分派边界。
