import { isValidStorageRef } from "../logs.js";
import { DEFAULT_UNCLOSED_TASK_LIMIT } from "./tables.js";

/** 未闭合任务排序所需的最小事件结构。 */
interface UnclosedTaskSortableEvent {
  /** 可选事件序号。 */
  readonly seq?: number;
  /** 创建时间。 */
  readonly created_at: string;
}

/** 克隆持久化数据值。 */

export function clonePersistedValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => clonePersistedValue(item))) as TValue;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      clonePersistedValue(entryValue),
    ]);

    return Object.freeze(Object.fromEntries(entries)) as TValue;
  }

  return value;
}
/** 断言持久化标识符的合法性。 */

export function assertPersistedIdentifier(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
/** 断言持久化时间戳的合法性。 */

export function assertPersistedTimestamp(value: string, fieldName: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
}
/** 断言数值是否为正整数。 */

export function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}
/** 断言数值是否为非负整数。 */

export function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}
/** 断言任务历史日志引用的合法性。 */

export function assertTaskHistoryLogRef(value: string, channel: "tasks" | "sandbox"): void {
  if (!isValidStorageRef(value) || !value.startsWith(`${channel}/`) || !value.endsWith(".jsonl")) {
    throw new Error(`task_history.log_ref must point to ${channel}/*.jsonl: ${value}`);
  }
}
/** 断言沙箱代码引用的合法性。 */

export function assertSandboxCodeRef(value: string): void {
  if (!isValidStorageRef(value) || !value.startsWith("sandbox/") || !value.endsWith(".code.ts")) {
    throw new Error(`task_history.code_ref must point to sandbox/*.code.ts: ${value}`);
  }
}
/** 归一化未关闭任务的数量限制。 */

export function normalizeUnclosedTaskLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_UNCLOSED_TASK_LIMIT;
  }

  assertPositiveInteger(limit, "limit");
  return limit;
}
/** 断言重放请求的 Bot 绑定是否匹配。 */

export function assertReplayBotBinding(
  expectedBotId: string,
  actualBotId: string,
  fieldName: string,
): void {
  if (expectedBotId !== actualBotId) {
    throw new Error(`${fieldName} must match bot_id`);
  }
}
/** 比较未关闭任务候选者的优先级。 */

export function compareUnclosedTaskCandidates(
  left: UnclosedTaskSortableEvent,
  right: UnclosedTaskSortableEvent,
): number {
  if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) {
    return right.seq - left.seq;
  }

  return Date.parse(right.created_at) - Date.parse(left.created_at);
}
