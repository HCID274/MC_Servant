/** 持久化写入阶段清单。 */
export const TASK_PERSISTENCE_PHASES = [
  "accepted",
  "started",
  "progress",
  "terminal",
  "brain_summary",
] as const;

/** 持久化写入阶段联合类型。 */
export type TaskPersistencePhase = (typeof TASK_PERSISTENCE_PHASES)[number];

/** 持久化写入目标清单。 */
export const PERSISTENCE_TARGETS = [
  "task_history",
  "event_log",
  "jsonl",
  "brain_queue",
  "task_summaries",
  "session_summaries",
] as const;

/** 持久化写入目标联合类型。 */
export type PersistenceTarget = (typeof PERSISTENCE_TARGETS)[number];

/** 持久化底座类型清单。 */
export const PERSISTENCE_STORES = ["postgres", "jsonl", "queue"] as const;

/** 持久化底座联合类型。 */
export type PersistenceStore = (typeof PERSISTENCE_STORES)[number];

/** 单步持久化顺序描述器。 */
export interface PersistenceWriteStep {
  /** 顺序号。 */
  readonly order: number;
  /** 所属阶段。 */
  readonly phase: TaskPersistencePhase;
  /** 写入目标。 */
  readonly target: PersistenceTarget;
  /** 底座类型。 */
  readonly store: PersistenceStore;
  /** 动作名。 */
  readonly operation: "insert" | "update" | "append" | "enqueue";
  /** 简要说明。 */
  readonly description: string;
}

/** 文档收口后的任务生命周期写入顺序。 */
export const TASK_PERSISTENCE_WRITE_SEQUENCE = Object.freeze([
  Object.freeze({
    order: 1,
    phase: "accepted",
    target: "task_history",
    store: "postgres",
    operation: "insert",
    description: "msg 队列入队时先创建 accepted 任务索引",
  }),
  Object.freeze({
    order: 2,
    phase: "accepted",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "accepted 生命周期事件作为 append-only 真理源补齐",
  }),
  Object.freeze({
    order: 3,
    phase: "started",
    target: "task_history",
    store: "postgres",
    operation: "update",
    description: "BotWorker 取出任务时把状态推进到 started",
  }),
  Object.freeze({
    order: 4,
    phase: "started",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "started 生命周期事件进入 event_log",
  }),
  Object.freeze({
    order: 5,
    phase: "progress",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "每步进度先写 event_log 保持审计连续性",
  }),
  Object.freeze({
    order: 6,
    phase: "progress",
    target: "jsonl",
    store: "jsonl",
    operation: "append",
    description: "冷日志按相同步骤追加 JSONL 细节",
  }),
  Object.freeze({
    order: 7,
    phase: "terminal",
    target: "task_history",
    store: "postgres",
    operation: "update",
    description: "真实终态先更新 task_history，failed / interrupted 必须带完整原因",
  }),
  Object.freeze({
    order: 8,
    phase: "terminal",
    target: "event_log",
    store: "postgres",
    operation: "insert",
    description: "终态事件写入 event_log，供 replay 与恢复复用",
  }),
  Object.freeze({
    order: 9,
    phase: "terminal",
    target: "brain_queue",
    store: "queue",
    operation: "enqueue",
    description: "真实终态之后异步触发 BrainWorker 摘要链路",
  }),
  Object.freeze({
    order: 10,
    phase: "brain_summary",
    target: "task_summaries",
    store: "postgres",
    operation: "insert",
    description: "BrainWorker 异步生成 task_summaries",
  }),
] as const satisfies readonly PersistenceWriteStep[]);

/** 读取指定阶段的持久化写入计划。 */
export function createTaskPersistencePlan(input: {
  phase: Exclude<TaskPersistencePhase, "brain_summary">;
}): readonly PersistenceWriteStep[];
/** 读取 BrainWorker（摘要工作线程） 阶段的持久化写入计划。 */
export function createTaskPersistencePlan(input: {
  phase: "brain_summary";
  includeSessionAggregation?: boolean;
}): readonly PersistenceWriteStep[];
/**
 * 获取任务持久化写入计划。
 *
 * 1. 计划分发（Plan Dispatching）：根据任务的生命周期阶段，动态生成对应的数据库写入序列。
 *
 * 1. 顺序一致性：确保全系统（Worker、Brain 等）遵循统一的写入步骤（如先写 event_log 再写 task_history），防止由于竞争导致的审计断档。
 * 2. 扩展性：通过 includeSessionAggregation 标志支持 BrainWorker 阶段的可选会话聚合。
 *
 * @param input 包含阶段和可选聚合标志的输入
 * @returns 经过筛选的持久化写入步骤
 */
export function createTaskPersistencePlan(input: {
  phase: TaskPersistencePhase;
  includeSessionAggregation?: boolean;
}): readonly PersistenceWriteStep[] {
  const selectedSteps = TASK_PERSISTENCE_WRITE_SEQUENCE.filter(
    (step) => step.phase === input.phase,
  );

  if (input.phase !== "brain_summary" || input.includeSessionAggregation !== true) {
    return Object.freeze(selectedSteps);
  }

  return Object.freeze([
    ...selectedSteps,
    Object.freeze({
      order: 11,
      phase: "brain_summary",
      target: "session_summaries",
      store: "postgres",
      operation: "insert",
      description: "满足聚合条件后异步写入 session_summaries",
    }),
  ]);
}
