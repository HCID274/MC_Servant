# 当前任务握手区

【任务序号】: T-005
【当前状态】: 待开发

---

## Manager 任务指令

**任务目标**: 建立 `skills` 模块的 Phase 1（第一阶段） 技能目录、`SkillRegistry`（技能注册表）只读契约与 `skill_call`（技能调用）参数模型，连接 `ConversationWorker`（对话工作线程）产出的单技能任务与后续 `BotActor`（机器人执行代理）/ `sandbox`（沙箱） 分派边界，但不实现任何真实 Mineflayer（Minecraft 协议客户端） 动作。

**上下文说明**:
1. `T-004` 已完成 `observation`（观测） / `world-model`（世界模型） 的只读快照与查询契约；当前主线缺口转到 `skills`（技能） 模块，需要把占位入口升级为可被 `runtime`（运行时） 与后续 `sandbox`（沙箱） 共同复用的强类型目录与注册表。
2. `03_SANDBOX_SPEC.md` 第 10 节明确要求：`skill_call`（技能调用） 与 `sandbox_code`（沙箱代码） 最终都汇聚到 `SkillRegistry`（技能注册表）；因此本任务要先把“技能名、参数、注册入口、查找边界”收口成稳定契约，再由后续任务接入真实执行。
3. 本任务严格控制在 Phase 1（第一阶段） 最小闭环：至少覆盖 `goTo`、`mine`、`cutTree`、`collect`、`equip` 五个主线技能；不实现 `follow`、`attack`、`goToOwner` 等扩展技能的真实契约，也不写任何 Bot（机器人） 行为。

**输入文件白名单（Coder 仅限读取以下文件）**:
1. `ts-core/Docs/01_ARCHITECTURE.md` — 第 15 节《模块划分》
2. `ts-core/Docs/03_SANDBOX_SPEC.md` — 第 10.1 节《SkillRegistry》、第 10.2 节《Facade API 方法与 Skill 的关系》、第 10.3 节《新增 Skill 的步骤》
3. `ts-core/Docs/04_CONVERSATION_SPEC.md` — 第 5.1 节《输出格式选择：skill_call 优先》、第 5.6 节《skill_call 路径的 Prompt》、第 5.7 节《skill_call 输出解析》
4. `ts-core/Docs/09_AGENT_WORKFLOW.md` — 第 4.2 节《Coder Agent》
5. `ts-core/scripts/pre_review.sh` — 全文件
6. `ts-core/src/index.ts` — 全文件
7. `ts-core/src/domain/contracts.ts` — 全文件
8. `ts-core/src/runtime/index.ts` — 全文件
9. `ts-core/src/runtime/tasking.ts` — 全文件
10. `ts-core/src/skills/index.ts` — 全文件
11. `ts-core/src/skills/contracts.ts` — 全文件（允许新建）
12. `ts-core/src/skills/registry.ts` — 全文件（允许新建）
13. `ts-core/src/__tests__/scaffold.spec.ts` — 全文件
14. `ts-core/src/__tests__/runtime-model.spec.ts` — 全文件
15. `ts-core/src/__tests__/skills-model.spec.ts` — 全文件（允许新建）

**核心逻辑要求**:
1. 在 `skills`（技能） 模块中拆清四类概念：技能标识目录、单技能参数契约、注册表条目 / 查找边界、与 `runtime`（运行时） 对接的 `skill_call`（技能调用） 类型桥接；不要写真实技能执行函数、Mineflayer（Minecraft 协议客户端） 调用、BotActor（机器人执行代理） 路由或 `sandbox`（沙箱） 注入代码。
2. Phase 1（第一阶段） 至少补齐五个技能的强类型参数契约：`goTo`、`mine`、`cutTree`、`collect`、`equip`。参数结构要可验证、可区分，不继续停留在自由形态 `Record<string, unknown>`。
3. `SkillRegistry`（技能注册表） 只建立纯类型 + 纯函数边界：至少包含技能定义 / 技能元信息、注册、按名查找、列出已注册技能等能力；当前阶段禁止接入真实实现函数、`AbortSignal`（中断信号） 执行链、异步生成器或 Mineflayer（Minecraft 协议客户端） 依赖。
4. `runtime/tasking.ts` 中的 `skill_call`（技能调用） 创建路径要与 `skills`（技能） 模块对齐：内部构造器或辅助函数必须能把技能名与参数收口到同一套强类型目录，避免后续 `ConversationWorker`（对话工作线程） / `sandbox`（沙箱） 再各自维护一份平行技能字符串集。
5. 测试优先覆盖：五个技能目录与参数类型存在性、注册表查找边界、`skill_call`（技能调用） 构造与技能参数对齐、模块根导出升级；不要写依赖真实 Mineflayer（Minecraft 协议客户端） / `sandbox`（沙箱） / 文件系统 / 网络的测试。

**验收标准**:
1. `skills`（技能） 模块不再停留在纯占位导出，至少暴露技能标识目录、参数契约与注册表纯函数边界。
2. `goTo`、`mine`、`cutTree`、`collect`、`equip` 五个技能均有独立且可验证的参数类型；非法技能名或非法参数组合在类型层不可无约束通过。
3. `runtime`（运行时） 的 `skill_call`（技能调用） 构造路径已与 `skills`（技能） 契约收口，不再让内部调用方默认依赖自由字符串 + 自由参数对象。
4. 新增测试覆盖技能目录、注册表、`skill_call`（技能调用） 对齐与根导出；没有真实技能执行、Mineflayer（Minecraft 协议客户端） 写操作或 `sandbox`（沙箱） 执行逻辑。
5. 执行 `bash ts-core/scripts/pre_review.sh` 后仍能通过。

---

## Coder 自检清单
- [ ] 任务序号核对为 `T-005`
- [ ] 仅读取并修改白名单内文件
- [ ] 新增导出符号均补充中文文档注释
- [ ] 未引入真实技能执行、Mineflayer 写操作、BotActor 调用或 sandbox 注入逻辑
- [ ] 技能目录、参数契约、注册表边界与 skill_call 构造已对齐白名单文档
- [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过

---

## Manager 打回记录（仅 被打回 时填写）
- 暂无

---

## Coder 执行反馈（仅 Coder 填写）
- **回填序号**: T-005
- **修改文件**:
  - （待填写）
- **执行摘要**:
  - （待填写）
- **自检结果**:
  - [ ] 任务序号核对为 `T-005`
  - [ ] 仅读取并修改白名单内文件
  - [ ] 新增导出符号均补充中文文档注释
  - [ ] 未引入真实技能执行、Mineflayer 写操作、BotActor 调用或 sandbox 注入逻辑
  - [ ] 技能目录、参数契约、注册表边界与 skill_call 构造已对齐白名单文档
  - [ ] 执行 `bash ts-core/scripts/pre_review.sh` 全部通过
- **预检输出摘要**:
  - （待填写）
- **遗留疑问**: （待填写）

---

## 队列预览（只读，仅供 Coder 了解后续方向）
- T-006: 建立 `interfaces`（接口层） / 会话边界的最小契约，补齐 `sessions`（会话）、鉴权入口与 `event_log`（事件日志） 断线补拉所需类型出口。
- T-007: 建立 `sandbox`（沙箱） / `diagnostics`（诊断） 的最小契约，补齐只读 `Facade API`（门面接口）、JSONL（结构化日志） 诊断事件与代码执行边界。
- T-008: 建立 `conversation`（对话） / `workers`（工作线程） 的最小任务流转契约，连接消息分诊、规划输出与队列入口类型。
