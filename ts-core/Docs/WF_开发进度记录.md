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
