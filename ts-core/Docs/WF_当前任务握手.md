# 当前任务握手区

【任务序号】: T-017
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 在 `domain`（领域） + 若干纯契约模块这一组紧邻模块内，集中沉淀可复用的基础 `invariants`（不变量校验） / 只读辅助工具，替换当前散落的重复 `assertNonEmptyString`（非空字符串断言） 与少量重复只读克隆逻辑，并同步补记 `01_ARCHITECTURE.md`（架构文档） 中 `domain`（领域） 作为横切基础层的定位；本任务只做基础工具抽取与文档对齐，不改业务语义、不顺手重构执行流。

**上下文说明**:
1. 当前批次已完成 `runtime`（运行时） / `app`（应用装配） / `interfaces`（接口边界） / `data`（数据层） 的主干纯契约收口，最近几轮审查暴露出的高优先级问题已经清完，适合回收低风险横切重复。
2. 代码中仍有大量逐文件复制的 `assertNonEmptyString`（非空字符串断言），另有少量只读克隆 / 冻结帮助函数分散存在；这不会立即出错，但会放大后续边界调整的维护成本。
3. `domain`（领域） 模块已经实际承担“全局复用核心类型与基础契约”的职责，但 `01_ARCHITECTURE.md`（架构文档） 的七层描述尚未明确它是横切基础层，后续开发者容易误判依赖方向。
4. 本任务必须继续遵守五条不可破坏约束，尤其是“单写者”（唯一写操作权） 与“模块解耦”；抽取基础工具时不得让 `domain`（领域） 反向依赖上层模块，也不得把运行时 / 接口层细节塞进 `domain`。
5. 仍按模块级集中交付：允许在 `domain`（领域） 与白名单中的纯契约 / 纯辅助模块内成组修改；不得扩散到 `skills`（技能） / `observation`（观测） / `world-model`（世界模型） 等与本轮目标无关的模块。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 2 节《七层技术架构》；第 16 节《目录结构》
2. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
3. `ts-core/Docs/WF_需求变更索引.md` — 2026-04-14《MC 认证真理源确认（EasyAuth + SQLite）》条目
4. `ts-core/scripts/pre_review.sh` — 全文件
5. `ts-core/src/domain/contracts.ts` — 全文件
6. `ts-core/src/domain/index.ts` — 全文件
7. `ts-core/src/domain/invariants.ts` — 全文件（可新建）
8. `ts-core/src/runtime/contracts.ts` — 全文件
9. `ts-core/src/interfaces/contracts.ts` — 全文件
10. `ts-core/src/interfaces/api.ts` — 全文件
11. `ts-core/src/interfaces/game-chat/contracts.ts` — 全文件
12. `ts-core/src/interfaces/server-bridge/contracts.ts` — 全文件
13. `ts-core/src/app/bootstrap.ts` — 全文件
14. `ts-core/src/db/contracts.ts` — 全文件
15. `ts-core/src/db/connection.ts` — 全文件
16. `ts-core/src/db/keys.ts` — 全文件
17. `ts-core/src/conversation/chat.ts` — 全文件
18. `ts-core/src/conversation/planning.ts` — 全文件
19. `ts-core/src/conversation/triage.ts` — 全文件
20. `ts-core/src/diagnostics/logs.ts` — 全文件
21. `ts-core/src/workers/contracts.ts` — 全文件
22. `ts-core/src/workers/queues.ts` — 全文件
23. `ts-core/src/sandbox/execution.ts` — 全文件
24. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
25. `ts-core/src/__tests__/domain-invariants-model.spec.ts` — 全文件（可新建）

**核心逻辑要求**:
1. 必须把白名单模块内重复的 `assertNonEmptyString`（非空字符串断言） 收口到 `domain`（领域） 的共享基础工具中，并保持现有报错语义不变；不得为了抽取工具而改变字段名、错误文本或调用时机。
2. 若本轮处理只读克隆 / 冻结辅助逻辑，只允许抽取“与业务无关的通用只读辅助”，不得把某个模块私有的数据形状假设硬塞进共享工具；拿不准时宁可只先统一 `assertNonEmptyString`，不要做过度泛化。
3. `domain`（领域） 只能继续做横切基础层：新工具文件不得 import `runtime`（运行时） / `interfaces`（接口边界） / `app`（应用装配） / `db`（数据库） 等上层模块；消费者只能单向依赖 `domain`。
4. 必须在 `01_ARCHITECTURE.md`（架构文档） 中补充 `domain`（领域） 的定位说明，明确它是跨七层复用的基础契约层，而不是新的业务执行层；文档表述要和现有目录结构、模块解耦原则一致。
5. 本任务不允许顺手修改任何业务流程、状态机语义、认证逻辑、事件协议、持久化字段或测试目标，只做基础工具沉淀与文档对齐。

**验收标准**:
1. 白名单内重复的 `assertNonEmptyString`（非空字符串断言） 已统一改为复用 `domain`（领域） 共享工具，且对外行为与报错文本保持一致。
2. 若抽取了只读辅助逻辑，共享工具不携带模块私有 shape（数据形状） 假设，且未引入新的循环依赖或越层依赖。
3. `01_ARCHITECTURE.md`（架构文档） 已补记 `domain`（领域） 的横切基础层定位，后续开发者可从文档中直接判断依赖方向。
4. 已新增或更新测试，至少覆盖：共享基础工具导出、代表性非空字符串校验行为，以及根导出 / 模块边界未被破坏。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-017`
- [ ] 仅读取并修改白名单内文件
- [ ] 白名单模块内重复的 `assertNonEmptyString`（非空字符串断言） 已统一复用共享基础工具
- [ ] 若抽取了只读辅助逻辑，共享工具未携带模块私有 shape（数据形状） 假设，且未引入循环依赖
- [ ] `01_ARCHITECTURE.md`（架构文档） 已补记 `domain`（领域） 横切基础层定位
- [ ] 未顺手修改业务流程、状态机语义、认证逻辑、事件协议或持久化字段
- [ ] 已新增或更新测试覆盖共享工具导出与代表性校验行为
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）

---

## Coder 执行反馈（仅 Coder 填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-018: 在 `conversation`（对话） / `brain`（摘要） 相关模块内收口摘要输入与检索契约，为后续 pgvector（向量检索） 接入做纯模型准备。
- T-019: 在部署文档与运行说明里补记本地 Fabric（服务端核心） + EasyAuth（离线服认证模组） 运维约束与连服前置条件，但仍不把外部认证接管进 TS Core（TypeScript 单核心）。
- T-020: 在 `runtime`（运行时） / `interfaces`（接口边界） / `diagnostics`（诊断） 之间预留真实登录执行器接线前的效果事件与诊断占位边界。
