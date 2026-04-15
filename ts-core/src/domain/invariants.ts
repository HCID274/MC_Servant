/**
 * 领域不变量校验与只读辅助。
 *
 * 架构职责：
 * 1. 基础校验：提供 assertNonEmptyString 等通用的运行时字段校验，确保领域对象的完整性。
 * 2. 深度冻结：通过 cloneReadonlyValue 实现对象和数组的深层克隆与冻结，强制执行不可变数据（Immutable Data）模式。
 */

/** 断言输入字符串在去除首尾空白后仍非空，用于统一基础字段校验语义。 */
export function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

/**
 * 深克隆并递归冻结对象或数组。
 *
 * 架构意图：
 * 在系统各个模块的“出口”或“入口”处调用，确保传递的数据在后续流程中不会被意外修改，
 * 从而维护系统的状态可预测性。
 *
 * @param value 原始值
 * @returns 冻结后的深层副本
 */
export function cloneReadonlyValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneReadonlyValue(item))) as TValue;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      cloneReadonlyValue(entryValue),
    ]);

    return Object.freeze(Object.fromEntries(entries)) as TValue;
  }

  return value;
}
