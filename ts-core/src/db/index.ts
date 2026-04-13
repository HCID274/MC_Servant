import type { ModuleBoundary } from "../domain/contracts.js";

export * from "./contracts.js";
export * from "./keys.js";
export * from "./connection.js";
export * from "./migrations.js";

/** db 模块边界声明。 */
export const dbModuleBoundary = {
  moduleName: "db",
  responsibilities: [
    "声明 PostgreSQL 连接、schema 与扩展的纯元信息边界",
    "统一 Redis 键命名、状态缓存与 BullMQ 键模式契约",
    "集中沉淀 Drizzle migration 目录与命令元信息",
  ],
  placeholderExports: [
    "dbModuleBoundary",
    "POSTGRES_SCHEMA_CONTRACT",
    "createPostgresConnectionDescriptor",
    "createRedisKeyCatalog",
    "createDrizzleMigrationMetadata",
  ],
} satisfies ModuleBoundary;
