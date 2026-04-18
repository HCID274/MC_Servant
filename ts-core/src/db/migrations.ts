/**
 * Drizzle 数据库迁移逻辑。
 *
 * 架构职责：
 * 1. 元数据管理：定义迁移文件路径、Schema 位置及 Drizzle Kit 配置文件。
 * 2. 环境适配：基于基础设施配置生成 Drizzle Kit 可复用的配置快照。
 * 3. 自动化流水线：实现“建立连接 -> 安装扩展（Extension） -> 执行迁移（Migrate） -> 关闭连接”的完整生命周期。
 * 4. 扩展安装：确保 pgvector 等必要的数据库扩展在迁移前已正确安装。
 */

import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";

import type { DataConfigEnvironment } from "../data/contracts.js";
import { createDataConfig } from "../data/index.js";
import {
  type PostgresConnectionDescriptor,
  type PostgresDatabaseLike,
  type PostgresPoolLike,
  type PostgresRuntimeDependencies,
  createPostgresConnectionDescriptor,
  createPostgresRuntimeResource,
} from "./connection.js";
import { POSTGRES_EXTENSION_CONTRACTS } from "./contracts.js";

/** Drizzle schema（模式） 文件。 */
export const DRIZZLE_SCHEMA_FILE = "src/data/schema.ts" as const;

/** Drizzle schema（模式） 所在目录。 */
export const DRIZZLE_SCHEMA_DIRECTORY = "src/data" as const;

/** Drizzle migration（迁移） 目录。 */
export const DRIZZLE_MIGRATIONS_DIRECTORY = "src/db/migrations" as const;

/** Drizzle migration（迁移） 执行入口。 */
export const DRIZZLE_MIGRATION_ENTRYPOINT = "src/db/migrate.ts" as const;

/** Drizzle Kit（迁移工具） 共享配置文件。 */
export const DRIZZLE_CONFIG_FILE = "drizzle.config.ts" as const;

/** Drizzle migration（迁移） 文件命名模式。 */
export const DRIZZLE_MIGRATION_FILE_PATTERN = String.raw`^\d{4}_[a-z0-9_]+\.sql$`;

/** Drizzle（数据库工具） migration（迁移） 元信息。 */
export interface DrizzleMigrationMetadata {
  /** schema 定义文件。 */
  readonly schemaFile: typeof DRIZZLE_SCHEMA_FILE;
  /** schema 定义目录。 */
  readonly schemaDirectory: typeof DRIZZLE_SCHEMA_DIRECTORY;
  /** migration SQL 目录。 */
  readonly migrationsDirectory: typeof DRIZZLE_MIGRATIONS_DIRECTORY;
  /** 共享配置文件。 */
  readonly configFile: typeof DRIZZLE_CONFIG_FILE;
  /** 执行入口文件。 */
  readonly entrypoint: typeof DRIZZLE_MIGRATION_ENTRYPOINT;
  /** 生成 migration 的命令。 */
  readonly generateCommand: string;
  /** 执行 migration 的命令。 */
  readonly migrateCommand: string;
  /** 约定的 migration 文件名模式。 */
  readonly fileNamePattern: string;
  /** 执行前必须存在的 PG 扩展。 */
  readonly requiredExtensions: readonly string[];
  /** 复用的 PostgreSQL（关系型数据库） 连接描述符。 */
  readonly connection: PostgresConnectionDescriptor;
}

/** Drizzle Kit（迁移工具） 共享配置快照。 */
export interface DrizzleKitConfigSnapshot {
  /** 方言。 */
  readonly dialect: "postgresql";
  /** schema 定义文件。 */
  readonly schema: typeof DRIZZLE_SCHEMA_FILE;
  /** migration 输出目录。 */
  readonly out: typeof DRIZZLE_MIGRATIONS_DIRECTORY;
  /** 数据库连接信息。 */
  readonly dbCredentials: {
    /** 主机名。 */
    readonly host: string;
    /** 端口。 */
    readonly port: number;
    /** 用户名。 */
    readonly user: string;
    /** 数据库名。 */
    readonly database: string;
    /** 密码。 */
    readonly password?: string;
  };
  /** 仅允许生成到业务 schema。 */
  readonly schemaFilter: readonly PostgresConnectionDescriptor["schema"][];
}

/** Drizzle（数据库工具） 迁移执行结果。 */
export interface DrizzleMigrationExecutionResult {
  /** 本次复用的配置快照。 */
  readonly metadata: DrizzleMigrationMetadata;
  /** 实际执行的扩展安装 SQL。 */
  readonly ensuredExtensions: readonly string[];
}

/** 可注入的 migration（迁移） 执行依赖。 */
export interface DrizzleMigrationExecutionDependencies {
  /** PostgreSQL（关系型数据库） 资源工厂依赖。 */
  readonly postgres?: PostgresRuntimeDependencies;
  /** 自定义迁移执行器。 */
  readonly migrate?: (
    database: PostgresDatabaseLike,
    config: { migrationsFolder: string },
  ) => Promise<void>;
}

/**
 * 创建 Drizzle 迁移元信息快照。
 *
 * 架构职责：
 * 1. 元数据聚合（Metadata Aggregation）：封装所有与迁移相关的物理路径、脚本命令及必要的数据库扩展清单。
 *
 * 架构意图：
 * 1. 环境一致性：确保在不同运行环境（开发、测试、生产）下，数据库迁移遵循统一的拓扑结构和执行契约。
 *
 * @param input 包含可选连接描述符和环境变量的输入
 * @returns 不可变的迁移元信息
 */
export function createDrizzleMigrationMetadata(
  input: {
    postgres?: PostgresConnectionDescriptor;
    env?: DataConfigEnvironment;
  } = {},
): DrizzleMigrationMetadata {
  const postgres =
    input.postgres ??
    createPostgresConnectionDescriptor(
      createDataConfig({
        ...(input.env === undefined ? {} : { env: input.env }),
      }).postgres,
    );

  return Object.freeze({
    schemaFile: DRIZZLE_SCHEMA_FILE,
    schemaDirectory: DRIZZLE_SCHEMA_DIRECTORY,
    migrationsDirectory: DRIZZLE_MIGRATIONS_DIRECTORY,
    configFile: DRIZZLE_CONFIG_FILE,
    entrypoint: DRIZZLE_MIGRATION_ENTRYPOINT,
    generateCommand: `pnpm drizzle-kit generate --config ${DRIZZLE_CONFIG_FILE}`,
    migrateCommand: "pnpm db:migrate",
    fileNamePattern: DRIZZLE_MIGRATION_FILE_PATTERN,
    requiredExtensions: Object.freeze(
      POSTGRES_EXTENSION_CONTRACTS.map((contract) => contract.name),
    ),
    connection: postgres,
  });
}

/**
 * 创建 Drizzle Kit 可复用的配置快照。
 *
 * 架构意图：
 * 1. 外部工具适配：将系统内部的迁移元信息转换为 Drizzle Kit 命令行工具可识别的配置格式。
 *
 * @param metadata 迁移元信息
 * @returns Drizzle Kit 配置快照
 */
export function createDrizzleKitConfigSnapshot(
  metadata: DrizzleMigrationMetadata,
): DrizzleKitConfigSnapshot {
  return Object.freeze({
    dialect: "postgresql",
    schema: metadata.schemaFile,
    out: metadata.migrationsDirectory,
    dbCredentials: Object.freeze({
      host: metadata.connection.host,
      port: metadata.connection.port,
      user: metadata.connection.user,
      database: metadata.connection.database,
      ...(metadata.connection.password === undefined
        ? {}
        : {
            password: metadata.connection.password,
          }),
    }),
    schemaFilter: Object.freeze([metadata.connection.schema] as const),
  });
}

/**
 * 运行 Drizzle 迁移流水线。
 *
 * 架构职责：
 * 1. 自动化流水线驱动（Pipeline Driver）：实现“资源初始化 -> 扩展前置安装 -> 核心迁移执行 -> 资源回收”的完整闭环。
 *
 * 架构意图：
 * 1. 幂等性执行：确保每次启动时，数据库都能平滑演进到最新 Schema，且处理好 vector 等特殊扩展的物理依赖。
 *
 * @param input 包含元数据、环境和注入依赖的输入
 * @returns 迁移执行结果摘要
 */
export async function runDrizzleMigrations(
  input: {
    metadata?: DrizzleMigrationMetadata;
    env?: DataConfigEnvironment;
    dependencies?: DrizzleMigrationExecutionDependencies;
  } = {},
): Promise<DrizzleMigrationExecutionResult> {
  const metadata =
    input.metadata ??
    createDrizzleMigrationMetadata({
      ...(input.env === undefined ? {} : { env: input.env }),
    });
  const postgres = await createPostgresRuntimeResource(
    metadata.connection,
    input.dependencies?.postgres,
  );

  try {
    const ensuredExtensions = await ensurePostgresExtensions(
      postgres.pool,
      POSTGRES_EXTENSION_CONTRACTS.map((contract) => contract.installSql),
    );

    await (input.dependencies?.migrate ?? executeDefaultMigration)(postgres.db, {
      migrationsFolder: metadata.migrationsDirectory,
    });

    return Object.freeze({
      metadata,
      ensuredExtensions,
    });
  } finally {
    await postgres.close();
  }
}

/**
 * 确保 PostgreSQL 扩展已安装。
 *
 * 架构意图：
 * 1. 物理依赖管理：在执行任何 Drizzle 迁移前，确保底层的 vector 等业务关键扩展已经安装，避免 Drizzle 报错。
 */
async function ensurePostgresExtensions(
  pool: PostgresPoolLike,
  extensionSql: readonly string[],
): Promise<readonly string[]> {
  if (pool.query === undefined) {
    return Object.freeze([]);
  }

  const executedSql: string[] = [];

  for (const sql of extensionSql) {
    await pool.query(sql);
    executedSql.push(sql);
  }

  return Object.freeze(executedSql);
}

/**
 * 执行默认迁移器。
 *
 * 架构意图：
 * 1. 驱动适配：封装 Drizzle 官方的 migrate 函数，将其适配到系统内部的 PostgresDatabaseLike 接口。
 */
async function executeDefaultMigration(
  database: PostgresDatabaseLike,
  config: {
    migrationsFolder: string;
  },
): Promise<void> {
  await drizzleMigrate(database as Parameters<typeof drizzleMigrate>[0], config);
}
