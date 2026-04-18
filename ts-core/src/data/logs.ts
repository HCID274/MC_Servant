/**
 * 日志路径与保留策略管理。
 *
 * 架构职责：
 * 1. 路径规范：定义 JSONL 日志在物理存储（如文件系统）与数据库引用（log_ref/code_ref）之间的映射规则。
 * 2. 安全校验：强制要求存储引用必须是相对路径，防止路径穿越（Path Traversal）等安全风险。
 * 3. 策略分发：维护不同业务目录（tasks, sandbox, llm）的日志保留期限（Retention Policy）。
 */

import { posix as pathPosix } from "node:path";

/** JSONL 日志根目录默认值。 */
export const DEFAULT_LOGS_BASE_DIR = "./logs" as const;

/** JSONL 日志根目录环境变量名。 */
export const LOGS_BASE_DIR_ENV_VAR = "LOGS_DIR" as const;

/** PostgreSQL event_log 默认保留天数。 */
export const EVENT_LOG_RETENTION_DAYS = 30 as const;

/** JSONL 冷日志目录分类。 */
export const JSONL_LOG_DIRECTORIES = ["tasks", "sandbox", "llm"] as const;

/** JSONL 冷日志目录联合类型。 */
export type JsonlLogDirectory = (typeof JSONL_LOG_DIRECTORIES)[number];

/** 数据库中的相对路径引用字段。 */
export const STORAGE_REF_FIELDS = ["log_ref", "code_ref"] as const;

/** 数据库中的相对路径引用字段联合类型。 */
export type StorageRefField = (typeof STORAGE_REF_FIELDS)[number];

/** 冷日志目录保留期配置。 */
export const JSONL_RETENTION_DAYS = {
  tasks: 90,
  sandbox: 90,
  llm: 30,
} as const satisfies Record<JsonlLogDirectory, number>;

/** 单个目录的日志保留策略。 */
export interface JsonlDirectoryPolicy {
  /** 目录名。 */
  directory: JsonlLogDirectory;
  /** 保留天数。 */
  retentionDays: number;
  /** 允许写入的数据库引用字段。 */
  refFields: readonly StorageRefField[];
}

/** JSONL 目录与引用字段的集中规则。 */
export const JSONL_DIRECTORY_POLICIES = {
  tasks: {
    directory: "tasks",
    retentionDays: JSONL_RETENTION_DAYS.tasks,
    refFields: ["log_ref"],
  },
  sandbox: {
    directory: "sandbox",
    retentionDays: JSONL_RETENTION_DAYS.sandbox,
    refFields: ["log_ref", "code_ref"],
  },
  llm: {
    directory: "llm",
    retentionDays: JSONL_RETENTION_DAYS.llm,
    refFields: ["log_ref"],
  },
} as const satisfies Record<JsonlLogDirectory, JsonlDirectoryPolicy>;

/**
 * 判断数据库中的日志引用是否为安全的相对路径。
 *
 * 架构职责：
 * 1. 路径安全审计（Path Security Auditing）：在存储前校验路径合法性，防止路径穿越（Path Traversal）风险。
 *
 * 架构意图：
 * 1. 安全校验：采用严格的白名单策略。禁止绝对路径、禁止 Windows 风格反斜杠、禁止包含 '..' 或 '.' 等特殊段，确保日志引用始终局限在 logs 根目录下。
 *
 * @param value 待校验的路径引用字符串
 * @returns 是否安全合法
 */
export function isValidStorageRef(value: string): boolean {
  if (value.length === 0 || value.includes("\\")) {
    return false;
  }

  if (pathPosix.isAbsolute(value)) {
    return false;
  }

  const normalizedValue = pathPosix.normalize(value);

  if (normalizedValue === "." || normalizedValue !== value) {
    return false;
  }

  const segments = value.split("/");

  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * 校验单个路径片段的合法性。
 *
 * 架构意图：
 * 1. 片段校验：确保日期段或文件名等原子分段符合存储引用的安全契约。
 */
function isValidStorageRefSegment(value: string): boolean {
  if (value.length === 0 || value.includes("\\") || pathPosix.isAbsolute(value)) {
    return false;
  }

  const normalizedValue = pathPosix.normalize(value);

  if (normalizedValue === "." || normalizedValue !== value) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * 创建符合目录规则的日期分桶日志引用。
 *
 * 架构职责：
 * 1. 路径生成（Path Generation）：按照三级目录结构（directory/date/fileName）标准化日志引用格式。
 *
 * 架构意图：
 * 1. 存储一致性：统一全系统的冷日志（tasks, sandbox, llm）分桶策略，便于按日期进行日志归档与清理。
 *
 * @param input 包含目录名、日期段和文件名的输入
 * @returns 组合后的安全存储引用
 */
export function createDatedStorageRef(input: {
  directory: JsonlLogDirectory;
  date: string;
  fileName: string;
}): string {
  if (!isValidStorageRefSegment(input.date) || !isValidStorageRefSegment(input.fileName)) {
    throw new Error("Invalid storage ref segment");
  }

  const storageRef = pathPosix.join(input.directory, input.date, input.fileName);

  if (!isValidStorageRef(storageRef)) {
    throw new Error(`Invalid storage ref: ${storageRef}`);
  }

  return storageRef;
}
