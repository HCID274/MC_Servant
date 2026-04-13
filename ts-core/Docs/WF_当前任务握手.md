# 当前任务握手区

【任务序号】: T-007
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `sandbox`（沙箱） / `diagnostics`（诊断） 模块的最小强类型契约，补齐 `Facade API`（门面接口） 顶层边界、沙箱执行请求 / 结果 / 错误模型，以及 `tasks` / `sandbox` / `llm` 三类 JSONL（结构化日志） 行模型与引用规则，为后续 `conversation`（对话） 代码规划、`workers`（工作线程） 串接和首轮无 MC（Minecraft） 冒烟闭环提供稳定的执行与诊断边界；但不接入真实 `isolated-vm`、`esbuild`、文件系统写入或任何网络 I/O（输入输出）。

**上下文说明**:
1. `T-006` 已完成 `interfaces`（接口层） 契约，网页入口、会话鉴权、实时推送与 replay（补拉） 边界已稳定；当前离无 MC（Minecraft） 联调最近的结构性缺口，转为“沙箱怎么表达调用边界”和“诊断日志怎么表达执行痕迹”。
2. `01_ARCHITECTURE.md` 明确要求：`sandbox`（沙箱） 独占 `isolated-vm`（隔离虚拟机） 集成、`Facade API`（门面接口） 类型定义与转译边界；`diagnostics`（诊断） 独占 JSONL（结构化日志）、LLM（大语言模型） transcript（原始对话记录） 与 run event（运行事件） 视图。两者都必须保持模块解耦，只通过类型与纯函数契约与其他模块通信。
3. `03_SANDBOX_SPEC.md` 与 `05_DATA_SPEC.md` 已给出 `Facade API`（门面接口） 顶层结构、Phase 1（第一阶段） 沙箱执行日志格式、错误分类、`log_ref` / `code_ref`（日志 / 代码引用） 约束；本任务需要把这些文档边界沉淀为可测试的纯类型与纯函数，而不是直接上真实执行器。
4. 本任务仍然受 AGENTS.md 的 Minecraft 事实来源约束：`knowledge`（知识） / `memory`（记忆） 等只读入口可以声明查询边界，但不得硬编码配方、掉落、工具等级等 MC（Minecraft） 事实。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 7.1 节《选型：isolated-vm》、第 7.3 节《Facade API 是 BotActor 的代理》、第 15 节《模块划分》、第 16 节《目录结构》
2. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 4 节《Facade API 完整类型定义》、第 9 节《执行产物与日志》、第 11 节《沙箱执行日志》、第 12 节《错误类型与处置》、第 13 节《配置参数》
3. `ts-core/Docs/05_DATA_SPEC.md` — 第 2.3 节中的 `task_history`（任务历史） 字段说明、第 4 节《JSONL 日志规格》、第 5.2 节《冷数据（JSONL 文件）》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/src/index.ts` — 全文件
7. `ts-core/src/domain/contracts.ts` — 全文件
8. `ts-core/src/data/contracts.ts` — 全文件
9. `ts-core/src/data/logs.ts` — 全文件
10. `ts-core/src/runtime/contracts.ts` — 全文件
11. `ts-core/src/runtime/tasking.ts` — 全文件
12. `ts-core/src/runtime/events.ts` — 全文件
13. `ts-core/src/skills/contracts.ts` — 全文件
14. `ts-core/src/observation/index.ts` — 全文件
15. `ts-core/src/diagnostics/index.ts` — 全文件
16. `ts-core/src/diagnostics/contracts.ts` — 全文件（允许新建）
17. `ts-core/src/diagnostics/logs.ts` — 全文件（允许新建）
18. `ts-core/src/sandbox/index.ts` — 全文件（允许新建）
19. `ts-core/src/sandbox/contracts.ts` — 全文件（允许新建）
20. `ts-core/src/sandbox/facade.ts` — 全文件（允许新建）
21. `ts-core/src/sandbox/execution.ts` — 全文件（允许新建）
22. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
23. `ts-core/src/__tests__/sandbox-diagnostics-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `sandbox`（沙箱） 模块中至少拆清四类概念：`Facade API`（门面接口） 顶层结构、执行请求 / 产物 / 资源限制边界、错误分类与错误载荷、与 `runtime`（运行时） / `skills`（技能） 对齐的最小动作映射；不得启动真实 `isolated-vm`（隔离虚拟机）、不得做真实 `esbuild`（转译器） 转译、不得触碰文件系统 / 网络 / 进程对象。
2. `Facade API`（门面接口） 的写动作必须与现有 Phase 1（第一阶段） `skills`（技能） 目录对齐，不得再造平行动作字符串集；`chat`（聊天） / `owner`（主人） / `world`（世界） / `task`（任务） / `knowledge`（知识） / `memory`（记忆） 等只读边界可以建模查询签名，但不得嵌入自维护 MC（Minecraft） 事实数据。
3. 在 `diagnostics`（诊断） 模块中至少拆清三类 JSONL（结构化日志） 通道：`tasks`（任务执行）、`sandbox`（沙箱执行）、`llm`（大语言模型） 调用。日志行模型、目录分类、保留期与 `log_ref` / `code_ref`（日志 / 代码引用） 必须复用既有 `data/logs.ts`（数据日志规则） 语义，不得引入真实写文件实现。
4. `sandbox`（沙箱） 执行请求 / 结果与错误模型必须对齐 `task_history`（任务历史） 中 `sandbox_code`（沙箱代码） 语义，显式承载 `job_id`、`bot_id`、`intent_epoch`、`log_ref`、可选 `code_ref`、阶段性日志与终态摘要；错误分类至少覆盖文档中的 `StaticCheckError`、`TranspileError`、`SandboxTimeoutError`、`SandboxOOMError`、`FacadeCallError`、`AbortError`、`UnhandledError`。
5. 测试优先覆盖：根导出、`Facade API`（门面接口） 顶层结构、Phase 1（第一阶段） 技能动作对齐、JSONL（结构化日志） 行模型、错误分类、引用路径规则与负向类型约束；不要写依赖真实 `isolated-vm`（隔离虚拟机）、`esbuild`（转译器）、文件系统、数据库或网络的测试。

**验收标准**:
1. `sandbox`（沙箱） 模块已落地并接入 `src/`（源代码） 根导出，`diagnostics`（诊断） 不再停留在占位对象层。
2. `Facade API`（门面接口） 顶层结构、执行请求 / 结果、资源限制与错误分类均具备强类型模型或纯函数构造边界，且写动作命名与现有 Phase 1（第一阶段） `skills`（技能） 对齐。
3. `tasks` / `sandbox` / `llm` 三类 JSONL（结构化日志） 行模型、目录分类、保留期与 `log_ref` / `code_ref`（日志 / 代码引用） 规则已收口为稳定契约，没有真实文件写入或转译 / 执行副作用。
4. 新增测试覆盖 `Facade API`（门面接口） 对齐、错误分类、日志模型、根导出与负向类型约束；不存在平行命名集合、MC（Minecraft） 事实硬编码或跨模块实现耦合。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-007`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实 `isolated-vm`（隔离虚拟机） / `esbuild`（转译器） / 文件写入 / 网络 I/O（输入输出）
- [ ] `Facade API`（门面接口） 写动作与 Phase 1（第一阶段） `skills`（技能） 目录对齐，且未硬编码 MC（Minecraft） 事实
- [ ] JSONL（结构化日志） 契约、目录分类与 `log_ref` / `code_ref`（日志 / 代码引用） 规则已对齐文档和既有 `data/logs.ts`（数据日志规则）
- [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: （待填写）
- **修改文件**:
  - （待填写）
- **执行摘要**:
  - （待填写）
- **自检结果**:
  - [ ] 任务序号核对为 `T-007`
  - [ ] 仅读取并修改白名单内文件
  - [ ] 新增导出符号均补充中文文档注释
  - [ ] 未引入真实 `isolated-vm`（隔离虚拟机） / `esbuild`（转译器） / 文件写入 / 网络 I/O（输入输出）
  - [ ] `Facade API`（门面接口） 写动作与 Phase 1（第一阶段） `skills`（技能） 目录对齐，且未硬编码 MC（Minecraft） 事实
  - [ ] JSONL（结构化日志） 契约、目录分类与 `log_ref` / `code_ref`（日志 / 代码引用） 规则已对齐文档和既有 `data/logs.ts`（数据日志规则）
  - [ ] 执行 bash ts-core/scripts/pre_review.sh 全部通过
- **预检输出摘要**:
  - （待填写）
- **遗留疑问**:
  - （待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-008: 建立 `conversation`（对话） / `workers`（工作线程） 的最小任务流转契约，收口消息分诊、规划产物与队列入口类型。
- T-009: 建立 `db`（数据库接入） / `config`（配置） 的最小边界，收口 PostgreSQL（关系型数据库） / Redis（缓存） / 日志路径 / 环境变量契约。
- T-010: 建立本地应用装配与首轮无 MC（Minecraft） 冒烟闭环骨架，串起 `interfaces`（接口层）、`workers`（工作线程）、`runtime`（运行时） 与 `sandbox`（沙箱） 的启动边界。
