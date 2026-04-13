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

/** 判断数据库中的日志引用是否为安全的相对路径。 */
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

/** 创建符合目录规则的日期分桶日志引用。 */
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
