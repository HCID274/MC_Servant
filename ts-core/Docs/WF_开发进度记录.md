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
