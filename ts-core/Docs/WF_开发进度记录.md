# 开发进度记录（Append-Only）

仅 Manager 审查通过后追加，不允许覆盖历史。

---

## T-001

- **审查结论**: 通过
- **核心文件**:
  - `ts-core/package.json`
  - `ts-core/tsconfig.json`
  - `ts-core/biome.json`
  - `ts-core/vitest.config.ts`
  - `ts-core/README.md`
  - `ts-core/src/index.ts`
  - `ts-core/src/domain/contracts.ts`
  - `ts-core/src/runtime/contracts.ts`
  - `ts-core/src/__tests__/scaffold.spec.ts`
- **变更快照**:
  - 建立 `pnpm`、`TypeScript strict`、`NodeNext`、`Biome`、`Vitest` 的最小工程基线，`pre_review.sh` 所需脚本已齐备。
  - 建立 `runtime`、`skills`、`observation`、`world-model`、`diagnostics`、`domain`、`data` 七个模块入口与聚合导出。
  - 沉淀基础契约：区分对话入口任务与执行任务，消息来源对齐为 `web/game/system`，运行时状态与中断来源模型对齐设计文档。
  - 骨架测试已覆盖模块边界清单、基础枚举与最小运行时骨架对象。
- **非阻塞注意项**:
  - `ts-core/src/domain/index.ts` 的 `placeholderExports` 字符串清单仍是旧命名，仅影响占位说明，不影响当前导出面；后续任务顺手收口。

## T-002

- **审查结论**: 通过
- **核心文件**:
  - `ts-core/src/domain/contracts.ts`
  - `ts-core/src/domain/index.ts`
  - `ts-core/src/runtime/contracts.ts`
  - `ts-core/src/runtime/tasking.ts`
  - `ts-core/src/runtime/events.ts`
  - `ts-core/src/runtime/state-machine.ts`
  - `ts-core/src/runtime/index.ts`
  - `ts-core/src/__tests__/runtime-model.spec.ts`
  - `ts-core/src/__tests__/scaffold.spec.ts`
- **变更快照**:
  - 在 `domain` 与 `runtime` 中拆清对话入口任务、执行任务与运行时状态流转三类概念，执行边界不再混入 `ConversationWorker`（对话工作线程）输入。
  - 补齐 `ExecJob`、执行优先级、`task_history` 状态枚举与 `event_log` 事件常量，命名对齐 `05_DATA_SPEC.md` 与 `02_RUNTIME_SPEC.md`。
  - 建立纯函数状态机模型，覆盖合法/非法迁移、中断分流、`state.transition` 审计事件与“未接受迁移不产生日志事件”的约束。
  - 测试已覆盖执行任务构造、事件名清单、合法迁移、非法迁移和中断接受语义，`T-001` 留下的 `domain/index.ts` 占位导出残留已一并收口。

## T-003

- **审查结论**: 通过
- **核心文件**:
  - `ts-core/package.json`
  - `ts-core/pnpm-lock.yaml`
  - `ts-core/src/data/index.ts`
  - `ts-core/src/data/contracts.ts`
  - `ts-core/src/data/schema.ts`
  - `ts-core/src/data/logs.ts`
  - `ts-core/src/__tests__/data-model.spec.ts`
- **变更快照**:
  - 建立 `data` 模块的持久化契约层，补齐 `mc_servant` 核心表 schema 出口、`event_log` / `task_history` 复用现有运行时枚举，以及冷热日志常量。
  - `log_ref` / `code_ref` 的相对路径规则已集中收口，`createDatedStorageRef()` 会在拼接前拒绝 `..`、绝对路径与反斜杠输入，避免路径归一化掩盖非法片段。
  - `sessions` 的未过期 token 部分索引语义、`task_summaries` / `session_summaries` 的 `summary_tsv` 生成列与全文 / 向量检索索引，已明确为独立契约出口。
  - 测试已覆盖核心表结构、事件 / 状态复用、路径逃逸回归，以及部分索引和摘要检索契约存在性；当前没有引入真实 PostgreSQL 连接、迁移执行或文件写入逻辑。

## T-004

- **审查结论**: 通过
- **核心文件**:
  - `ts-core/src/observation/index.ts`
  - `ts-core/src/observation/contracts.ts`
  - `ts-core/src/observation/snapshot.ts`
  - `ts-core/src/world-model/index.ts`
  - `ts-core/src/world-model/contracts.ts`
  - `ts-core/src/world-model/query.ts`
  - `ts-core/src/runtime/contracts.ts`
  - `ts-core/src/__tests__/observation-world-model.spec.ts`
  - `ts-core/src/__tests__/runtime-model.spec.ts`
- **变更快照**:
  - 建立 `observation` 模块的双数据源只读契约层，统一 Mineflayer（Minecraft 协议客户端）与 JAR Bridge（服务端桥接）的原始输入、归一化环境快照、威胁检测输入输出，以及读取时取当前值的只读边界。
  - `EnvironmentSnapshot`（环境快照） 与 `ObservationReadBoundary`（观测只读边界） 已收口为深拷贝 + 冻结语义，`getSnapshot()` 返回副本不再泄露内部引用；`owner` / `world` 读取边界也已改成面向实时缓存源的形状。
  - `ThreatAssessment`（威胁评估） 删除弱类型兼容口，直接与 `runtime`（运行时） 的 reflex（反射）中断来源复用；不再允许 `"high"` 这类平行 threat（威胁） 字符串或最小载荷进入。
  - `world-model`（世界模型） 已补齐资源画像、资源簇、候选块、最优簇查询和 query / refresh（查询 / 刷新） 分离契约；查询返回值及关键嵌套对象已冻结，测试覆盖快照不可变、owner 实时读取、强类型 threat 与 world-model 只读回归。`runtime-model.spec.ts` 的改动仅限用户授权下的最小必要强类型修复。

## T-005

- **审查结论**: 通过
- **核心文件**:
  - `ts-core/src/skills/contracts.ts`
  - `ts-core/src/skills/registry.ts`
  - `ts-core/src/skills/index.ts`
  - `ts-core/src/runtime/tasking.ts`
  - `ts-core/src/__tests__/skills-model.spec.ts`
- **变更快照**:
  - 建立 `skills`（技能） 模块的 Phase 1（第一阶段） 技能目录与参数契约，补齐 `goTo`、`mine`、`cutTree`、`collect`、`equip` 五个技能的强类型参数模型、校验器与只读 `skill_call`（技能调用） 结构。
  - 新增 `SkillRegistry`（技能注册表） 纯函数边界，覆盖创建、注册、按名读取、顺序列举与 Phase 1 默认注册表构造；当前仍保持纯契约层，没有接入真实 Mineflayer（Minecraft 协议客户端） 执行或 `BotActor`（机器人执行代理） 调度。
  - `runtime/tasking.ts` 中的 `createSkillCallJob`（创建技能调用任务） 已与 `skills`（技能） 契约收口，`skill_call`（技能调用） 不再依赖自由字符串 + 自由参数对象的平行集合。
  - 测试已覆盖技能目录、负向类型约束、注册表边界与 `skill_call`（技能调用） 对齐路径；当前根入口无需新增临时兼容层。
