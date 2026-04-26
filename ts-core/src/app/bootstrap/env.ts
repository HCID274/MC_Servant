import type { DataConfigEnvironment } from "../../data/index.js";
import { assertNonEmptyString } from "../../domain/invariants.js";

/**
 * 将未知输入转换为可选的普通对象。
 *
 * 类型防御：在解析外部配置时提供第一层类型校验。
 */
export function asOptionalPlainObject(
  value: unknown,
  fieldName: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

/**
 * 从环境变量读取可选布尔值。
 *
 * 宽容解析：支持 1/true/yes/on 等多种布尔表达方式。
 */
export function readOptionalBoolean(
  env: DataConfigEnvironment,
  fieldName: string,
): boolean | undefined {
  const value = env[fieldName];

  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${fieldName} must be a boolean string`);
}

/**
 * 从普通对象读取可选布尔字段。
 */
export function readOptionalBooleanField(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }

  return value;
}

/**
 * 内部辅助函数，读取可选环境变量并确保非空。
 */
export function readOptionalEnvValue(
  env: DataConfigEnvironment,
  fieldName: string,
): string | undefined {
  const value = env[fieldName];

  if (value === undefined || value === "") {
    return undefined;
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${fieldName} must not be blank`);
  }

  return normalizedValue;
}

/**
 * 从环境变量读取可选字符串。
 */
export function readOptionalString(
  env: DataConfigEnvironment,
  fieldName: string,
): string | undefined {
  return readOptionalEnvValue(env, fieldName);
}

/**
 * 从环境变量读取可选整数并校验边界。
 */
export function readOptionalInteger(
  env: DataConfigEnvironment,
  fieldName: string,
  bounds?: {
    min?: number;
    max?: number;
  },
): number | undefined {
  const value = readOptionalEnvValue(env, fieldName);

  if (value === undefined) {
    return undefined;
  }

  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${fieldName} must be an integer string`);
  }

  const integerValue = Number(value);

  if (!Number.isSafeInteger(integerValue)) {
    throw new Error(`${fieldName} must be an integer string`);
  }

  if (bounds?.min !== undefined && integerValue < bounds.min) {
    throw new Error(`${fieldName} must be at least ${bounds.min}`);
  }

  if (bounds?.max !== undefined && integerValue > bounds.max) {
    throw new Error(`${fieldName} must be at most ${bounds.max}`);
  }

  return integerValue;
}

/**
 * 从对象中读取可选字符串字段。
 */
export function readOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  assertNonEmptyString(value, fieldName);

  return value.trim();
}
