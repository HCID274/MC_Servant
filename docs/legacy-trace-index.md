# Legacy Trace Index

## Scope

- 主题：run event、step summary、LLM transcript、本地可读日志。
- Phase 1 只保留 diagnostics 骨架，不把 summary 调度继续绑在执行热路径上。
- 本地可读 transcript 是硬要求。

## Entry

## Summary / Event Support

- legacy_path: `backend/application/services/task_job/support.py`
- symbols: `capture_env_snapshot`, `TaskJobReporter.record_event`, `StepSummaryScheduler.schedule`, `TaskFailurePolicy`, `try_fatal_replan`
- migration_symbols: `capture_env_snapshot`, `TaskJobReporter.record_event`
- responsibility: `旧系统的步骤摘要、运行反馈和失败支持`
- migration_fit: `rewrite_with_reference`
- reuse_type: `diagnostics`
- ts_target: `src/diagnostics/run-event-store.ts`, `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/diagnostics/trace-store.ts`, `src/observation/snapshot.ts`
- do_not_copy: `不要保留 detached summary 调度；不要引入 fatal replan`
- notes: `Phase 1 只迁 diagnostics 有关的稳定骨架，不迁重规划链`

### Symbol Notes

#### `capture_env_snapshot`

- role: `摘要前抓取环境快照`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/observation/snapshot.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/observation/snapshot.ts`
- do_not_copy: `沿用旧 snapshot 的副作用路径`
- notes: `保留入口概念，不保留旧实现`

#### `TaskJobReporter.record_event`

- role: `统一记录运行事件`
- migration_fit: `direct_port`
- reuse_type: `diagnostics`
- ts_target: `src/diagnostics/run-event-store.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/diagnostics/trace-store.ts`
- do_not_copy: `事件命名散落在多个模块中`
- notes: `值得迁移的是统一记录入口`

## Trace Store Facade

- legacy_path: `backend/tracing/store.py`
- symbols: `TraceStore`, `record_llm_call`, `record_event`, `record_step_summary`
- migration_symbols: `TraceStore`, `record_llm_call`, `record_event`
- responsibility: `trace 门面，协调结构化 trace 与本地 transcript`
- migration_fit: `rewrite_with_reference`
- reuse_type: `diagnostics`
- ts_target: `src/diagnostics/trace-store.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `sqlite or local store`, `transcript writer`
- do_not_copy: `Python DAO 层样板；只落 DB 不落文本的做法`
- notes: `TS 里可以简化实现，但双写原则必须保留`

### Symbol Notes

#### `TraceStore`

- role: `diagnostics 门面对象`
- migration_fit: `rewrite_with_reference`
- reuse_type: `flow`
- ts_target: `src/diagnostics/trace-store.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/diagnostics/transcript-writer.ts`
- do_not_copy: `Python storage manager/repository 结构原样迁移`
- notes: `保留职责分层，不保留实现外形`

#### `record_llm_call`

- role: `记录 LLM 调用并写本地 transcript`
- migration_fit: `direct_port`
- reuse_type: `diagnostics`
- ts_target: `src/diagnostics/trace-store.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `src/diagnostics/transcript-writer.ts`
- do_not_copy: `只写 sqlite 不写本地文本`
- notes: `这项能力是仓库约束要求保留的`

#### `record_event`

- role: `记录 runtime 事件`
- migration_fit: `direct_port`
- reuse_type: `diagnostics`
- ts_target: `src/diagnostics/run-event-store.ts`
- priority: `P0`
- phase: `phase1`
- depends_on: `event schema`
- do_not_copy: `事件 schema 无集中定义`
- notes: `TS 中建议集中定义 event names`

