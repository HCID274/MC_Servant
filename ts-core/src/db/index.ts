/**
 * 数据库与基础设施接入模块。
 *
 * 架构职责：
 * 1. 物理连接管理：封装 PostgreSQL (Drizzle ORM) 与 Redis (ioredis) 的连接池管理、描述符生成及资源生命周期（Resource Lifecycle）。
 * 2. 存储契约（Catalog）：定义统一的 Redis 键命名规范（Key Catalog）和任务队列存储模型。
 * 3. 演进管理（Migration）：维护数据库 Schema 的版本演进（Drizzle Migrations）与执行策略。
 * 4. 资源抽象：将具体的基础设施物理细节抽象为运行时可消费的 RuntimeResource。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

export * from "./contracts.js";
export * from "./keys.js";
export * from "./connection.js";
export * from "./migrations.js";

/**
 * db 模块边界声明。
 *
 * 架构意图：
 * 1. 边界定义：明确数据库模块在物理连接（Postgres/Redis）、键空间管理（Keys）及数据演进（Migrations）三个维度的职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
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
