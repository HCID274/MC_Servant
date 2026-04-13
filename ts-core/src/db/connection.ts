import type { PostgresConfig } from "../data/contracts.js";
import {
  POSTGRES_EXTENSION_CONTRACTS,
  POSTGRES_SCHEMA_CONTRACT,
  type PostgresExtensionContract,
} from "./contracts.js";

/** PostgreSQL（关系型数据库） 连接池描述。 */
export interface PostgresPoolDescriptor {
  /** 最小连接数。 */
  readonly min: number;
  /** 最大连接数。 */
  readonly max: number;
}

/** PostgreSQL（关系型数据库） 连接描述符。 */
export interface PostgresConnectionDescriptor {
  /** 预期驱动名。 */
  readonly driver: "pg";
  /** 主机名。 */
  readonly host: string;
  /** 端口。 */
  readonly port: number;
  /** 数据库名。 */
  readonly database: string;
  /** 用户名。 */
  readonly user: string;
  /** 密码。 */
  readonly password?: string;
  /** 连接池参数。 */
  readonly pool: PostgresPoolDescriptor;
  /** 业务 schema 名称。 */
  readonly schema: typeof POSTGRES_SCHEMA_CONTRACT.businessSchema;
  /** 启动前应确保的扩展。 */
  readonly requiredExtensions: readonly PostgresExtensionContract[];
}

/** 基于纯配置创建 PostgreSQL（关系型数据库） 连接描述符。 */
export function createPostgresConnectionDescriptor(
  config: PostgresConfig,
): PostgresConnectionDescriptor {
  assertNonEmptyString(config.host, "host");
  assertNonEmptyString(config.database, "database");
  assertNonEmptyString(config.user, "user");

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65_535) {
    throw new Error("port must be a valid TCP port");
  }

  if (!Number.isInteger(config.pool.min) || config.pool.min <= 0) {
    throw new Error("pool.min must be a positive integer");
  }

  if (!Number.isInteger(config.pool.max) || config.pool.max <= 0) {
    throw new Error("pool.max must be a positive integer");
  }

  if (config.pool.min > config.pool.max) {
    throw new Error("pool.min must be less than or equal to pool.max");
  }

  if (config.password !== undefined) {
    assertNonEmptyString(config.password, "password");
  }

  return Object.freeze({
    driver: "pg",
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password === undefined
      ? {}
      : {
          password: config.password,
        }),
    pool: Object.freeze({
      min: config.pool.min,
      max: config.pool.max,
    }),
    schema: POSTGRES_SCHEMA_CONTRACT.businessSchema,
    requiredExtensions: POSTGRES_EXTENSION_CONTRACTS,
  });
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}
