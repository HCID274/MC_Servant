import type { ModuleBoundary } from "../domain/contracts.js";

export * from "./contracts.js";
export * from "./keys.js";
export * from "./connection.js";
export * from "./migrations.js";

/** db 模块边界声明。 */
export const dbModuleBoundary = {
  moduleName: "db",
  responsibilities: [
    "声明 PostgreSQL 连接、schema 与扩展，以及真实资源工厂边界",
    "统一 Redis 键命名、状态缓存、BullMQ 键模式与真实连接工厂契约",
    "集中沉淀 Drizzle migration 共享配置与执行入口",
  ],
  placeholderExports: [
    "dbModuleBoundary",
    "POSTGRES_SCHEMA_CONTRACT",
    "createPostgresConnectionDescriptor",
    "createPostgresRuntimeResource",
    "createRedisConnectionDescriptor",
    "createRedisRuntimeResource",
    "createRedisKeyCatalog",
    "createDrizzleMigrationMetadata",
    "runDrizzleMigrations",
  ],
} satisfies ModuleBoundary;
