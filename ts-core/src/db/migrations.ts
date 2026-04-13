import { POSTGRES_EXTENSION_CONTRACTS } from "./contracts.js";

/** Drizzle migration（迁移） 目录元信息。 */
export interface DrizzleMigrationMetadata {
  /** schema 定义目录。 */
  readonly schemaDirectory: string;
  /** migration SQL 目录。 */
  readonly migrationsDirectory: string;
  /** 未来执行入口文件。 */
  readonly entrypoint: string;
  /** 生成 migration 的命令。 */
  readonly generateCommand: string;
  /** 执行 migration 的命令。 */
  readonly migrateCommand: string;
  /** 约定的 migration 文件名模式。 */
  readonly fileNamePattern: string;
  /** 执行前必须存在的 PG 扩展。 */
  readonly requiredExtensions: readonly string[];
}

/** Drizzle schema（模式） 目录。 */
export const DRIZZLE_SCHEMA_DIRECTORY = "src/db/schema" as const;

/** Drizzle migration（迁移） 目录。 */
export const DRIZZLE_MIGRATIONS_DIRECTORY = "src/db/migrations" as const;

/** 未来 migration（迁移） 执行入口。 */
export const DRIZZLE_MIGRATION_ENTRYPOINT = "src/db/migrate.ts" as const;

/** Drizzle migration（迁移） 文件命名模式。 */
export const DRIZZLE_MIGRATION_FILE_PATTERN = String.raw`^\d{4}_[a-z0-9_]+\.sql$`;

/** 创建 Drizzle migration（迁移） 元信息快照。 */
export function createDrizzleMigrationMetadata(): DrizzleMigrationMetadata {
  return Object.freeze({
    schemaDirectory: DRIZZLE_SCHEMA_DIRECTORY,
    migrationsDirectory: DRIZZLE_MIGRATIONS_DIRECTORY,
    entrypoint: DRIZZLE_MIGRATION_ENTRYPOINT,
    generateCommand: "pnpm drizzle-kit generate",
    migrateCommand: "pnpm drizzle-kit migrate",
    fileNamePattern: DRIZZLE_MIGRATION_FILE_PATTERN,
    requiredExtensions: Object.freeze(
      POSTGRES_EXTENSION_CONTRACTS.map((contract) => contract.name),
    ),
  });
}
