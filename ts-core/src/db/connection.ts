/**
 * 数据库物理连接与资源实例化。
 *
 * 1. 资源抽象：将基础设施配置转换为运行时可操作的 PostgresRuntimeResource 和 RedisRuntimeResource。
 * 2. 连接池管理：封装 pg (PostgreSQL) 连接池和 ioredis 客户端的创建、预热（Warmup）与优雅关闭。
 * 3. 依赖注入支持：提供 RuntimeDependencies 接口，允许在测试环境注入 Mock 客户端或自定义工厂。
 * 4. 驱动适配：建立起 Drizzle ORM 与底层 pg 驱动、ioredis 与 BullMQ 兼容性选项之间的适配层。
 */

import { drizzle } from "drizzle-orm/node-postgres";
import RedisModule from "ioredis";
import type { RedisOptions } from "ioredis";
import { Pool } from "pg";

import type { PostgresConfig, RedisConfig } from "../data/contracts.js";
import { assertNonEmptyString } from "../domain/invariants.js";
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

/** Redis（缓存） 连接描述符。 */
export interface RedisConnectionDescriptor {
  /** 预期驱动名。 */
  readonly driver: "ioredis";
  /** 连接地址。 */
  readonly url: string;
  /** 当前连接是否为单节点模式。 */
  readonly topology: "standalone";
  /** 是否面向 BullMQ（任务队列） 复用。 */
  readonly bullmq_compatible: true;
}

/** PostgreSQL（关系型数据库） 真实连接池配置。 */
export interface PostgresRuntimePoolConfig {
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
  /** 最小连接数。 */
  readonly min: number;
  /** 最大连接数。 */
  readonly max: number;
}

/** PostgreSQL（关系型数据库） 连接池探活时返回的客户端句柄。 */
export interface PostgresPoolClientLike {
  /** 释放探活期间借出的连接。 */
  release(): void;
}

/** PostgreSQL（关系型数据库） 连接池最小能力边界。 */
export interface PostgresPoolLike {
  /** 主动建立并借出一个连接。 */
  connect?(): Promise<PostgresPoolClientLike | undefined>;
  /** 执行 SQL（结构化查询语言） 语句。 */
  query?(sql: string): Promise<unknown>;
  /** 关闭连接池。 */
  end(): Promise<unknown>;
}

/** Drizzle（数据库工具） 最小数据库句柄能力。 */
export interface PostgresDatabaseLike {
  /** Drizzle（数据库工具） 会把底层客户端挂在 `$client` 上。 */
  readonly $client?: unknown;
}

/** PostgreSQL（关系型数据库） 运行时资源。 */
export interface PostgresRuntimeResource {
  /** 资源类型。 */
  readonly kind: "postgres";
  /** 连接描述符。 */
  readonly descriptor: PostgresConnectionDescriptor;
  /** 底层连接池。 */
  readonly pool: PostgresPoolLike;
  /** Drizzle（数据库工具） 数据库句柄。 */
  readonly db: PostgresDatabaseLike;
  /** 关闭资源。 */
  close(): Promise<void>;
}

/** Redis（缓存） 客户端最小能力边界。 */
export interface RedisClientLike {
  /** 建立真实连接。 */
  connect?(): Promise<unknown>;
  /** 平滑关闭连接。 */
  quit?(): Promise<unknown>;
  /** 强制断开连接。 */
  disconnect?(): void;
}

/** Redis（缓存） 运行时连接选项。 */
export interface RedisRuntimeClientOptions {
  /** 是否延迟到显式 `connect`（连接） 时再握手。 */
  readonly lazyConnect: true;
  /** 是否开启就绪检查。 */
  readonly enableReadyCheck: true;
  /** 与 BullMQ（任务队列） 兼容所需的重试配置。 */
  readonly maxRetriesPerRequest: null;
}

/** Redis（缓存） 运行时资源。 */
export interface RedisRuntimeResource {
  /** 资源类型。 */
  readonly kind: "redis";
  /** 连接描述符。 */
  readonly descriptor: RedisConnectionDescriptor;
  /** 运行时连接选项。 */
  readonly options: RedisRuntimeClientOptions;
  /** 底层客户端。 */
  readonly client: RedisClientLike;
  /** 关闭资源。 */
  close(): Promise<void>;
}

/** PostgreSQL（关系型数据库） 资源工厂的可注入依赖。 */
export interface PostgresRuntimeDependencies {
  /** 自定义连接池工厂。 */
  readonly createPool?: (config: PostgresRuntimePoolConfig) => PostgresPoolLike;
  /** 自定义 Drizzle（数据库工具） 句柄工厂。 */
  readonly createDrizzle?: (pool: PostgresPoolLike) => PostgresDatabaseLike;
  /** 自定义探活逻辑，供测试注入。 */
  readonly warmupPool?: (pool: PostgresPoolLike) => Promise<void>;
}

/** Redis（缓存） 资源工厂的可注入依赖。 */
export interface RedisRuntimeDependencies {
  /** 自定义客户端工厂。 */
  readonly createClient?: (
    descriptor: RedisConnectionDescriptor,
    options: RedisRuntimeClientOptions,
  ) => RedisClientLike;
  /** 自定义连接逻辑。 */
  readonly connectClient?: (client: RedisClientLike) => Promise<void>;
  /** 自定义关闭逻辑。 */
  readonly closeClient?: (client: RedisClientLike) => Promise<void>;
}

/**
 * 基于纯配置创建 PostgreSQL 连接描述符。
 *
 * 契约绑定（Contract Binding）：验证数据库连接参数，并绑定业务 Schema 契约及必须安装的扩展元信息。
 *
 * 静态描述：将物理连接参数与逻辑架构要求（Schema/Extensions）聚合为不可变的描述符，供资源工厂消费。
 *
 * @param config 基础设施配置
 * @returns 不可变的连接描述符
 */
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

/**
 * 基于纯配置创建 Redis（缓存） 连接描述符。
 *
 * 策略锁定：强制将驱动限制为 ioredis，拓扑限制为独立节点（Standalone），并锁定 BullMQ 兼容模式。
 *
 * @param config Redis 配置
 * @returns Redis 连接描述符
 */
export function createRedisConnectionDescriptor(config: RedisConfig): RedisConnectionDescriptor {
  assertNonEmptyString(config.url, "url");

  return Object.freeze({
    driver: "ioredis",
    url: config.url,
    topology: "standalone",
    bullmq_compatible: true,
  });
}

/**
 * 把 PostgreSQL（关系型数据库） 描述符转换为真实连接池参数。
 *
 * 运行时转换：将静态描述符投影为 pg 驱动所需的物理连接配置。
 */
export function createPostgresRuntimePoolConfig(
  descriptor: PostgresConnectionDescriptor,
): PostgresRuntimePoolConfig {
  return Object.freeze({
    host: descriptor.host,
    port: descriptor.port,
    database: descriptor.database,
    user: descriptor.user,
    ...(descriptor.password === undefined
      ? {}
      : {
          password: descriptor.password,
        }),
    min: descriptor.pool.min,
    max: descriptor.pool.max,
  });
}

/**
 * 创建 Redis（缓存） 运行时连接选项。
 *
 * 健壮性锁定：锁死 lazyConnect 和 maxRetriesPerRequest: null，确保连接行为符合 BullMQ 的严格要求，防止由于重试冲突导致的任务丢失。
 */
export function createRedisRuntimeClientOptions(): RedisRuntimeClientOptions {
  return Object.freeze({
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  });
}

/**
 * 创建 PostgreSQL 真实运行时资源。
 *
 * 封装物理连接的完整生命周期，确保资源安全释放：
 * 1. 物理资源实例化：调用驱动工厂创建连接池，并注入 Drizzle ORM 句柄。
 * 2. 探活与预热（Warmup）：确保在资源返回前物理连接已初步就绪。
 * 3. 闭环管理：封装异步的 close 逻辑，确保数据库连接在系统停机时能被平滑释放，防止连接泄露。
 *
 * @param descriptor 连接描述符
 * @param dependencies 可注入的依赖
 * @returns PostgreSQL 运行时资源
 */
export async function createPostgresRuntimeResource(
  descriptor: PostgresConnectionDescriptor,
  dependencies: PostgresRuntimeDependencies = {},
): Promise<PostgresRuntimeResource> {
  const poolFactory = dependencies.createPool ?? createDefaultPostgresPool;
  const drizzleFactory = dependencies.createDrizzle ?? createDefaultDrizzleDatabase;
  const pool = poolFactory(createPostgresRuntimePoolConfig(descriptor));

  try {
    await (dependencies.warmupPool ?? warmupPostgresPool)(pool);
    const db = drizzleFactory(pool);

    return Object.freeze({
      kind: "postgres",
      descriptor,
      pool,
      db,
      async close(): Promise<void> {
        await closePostgresPool(pool);
      },
    }) as PostgresRuntimeResource;
  } catch (error) {
    await closePostgresPool(pool).catch(() => undefined);
    throw error;
  }
}

/**
 * 创建 Redis 真实运行时资源。
 *
 * 驱动配置适配（Driver Config Adaptation）：强制锁定 BullMQ 兼容性选项，创建 ioredis 客户端。
 *
 * 统一 IO 接入：将不同的 Redis 用途（状态缓存、任务队列）收口在统一的资源生命周期管理之下。
 *
 * @param descriptor 连接描述符
 * @param dependencies 可注入的依赖
 * @returns Redis 运行时资源
 */
export async function createRedisRuntimeResource(
  descriptor: RedisConnectionDescriptor,
  dependencies: RedisRuntimeDependencies = {},
): Promise<RedisRuntimeResource> {
  const options = createRedisRuntimeClientOptions();
  const clientFactory = dependencies.createClient ?? createDefaultRedisClient;
  const client = clientFactory(descriptor, options);

  try {
    await (dependencies.connectClient ?? connectRedisClient)(client);

    return Object.freeze({
      kind: "redis",
      descriptor,
      options,
      client,
      async close(): Promise<void> {
        await (dependencies.closeClient ?? closeRedisClient)(client);
      },
    });
  } catch (error) {
    await (dependencies.closeClient ?? closeRedisClient)(client).catch(() => undefined);
    throw error;
  }
}

/**
 * 创建默认的 PostgreSQL 连接池。
 */
function createDefaultPostgresPool(config: PostgresRuntimePoolConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ...(config.password === undefined
      ? {}
      : {
          password: config.password,
        }),
    min: config.min,
    max: config.max,
  });
}

/**
 * 创建默认的 Drizzle 数据库句柄。
 */
function createDefaultDrizzleDatabase(pool: PostgresPoolLike): ReturnType<typeof drizzle> {
  return drizzle(pool as Pool);
}

/**
 * 预热 PostgreSQL 连接池。
 */
async function warmupPostgresPool(pool: PostgresPoolLike): Promise<void> {
  if (pool.connect === undefined) {
    return;
  }

  const borrowedClient = await pool.connect();
  borrowedClient?.release();
}

/**
 * 关闭 PostgreSQL 连接池。
 */
async function closePostgresPool(pool: PostgresPoolLike): Promise<void> {
  await pool.end();
}

/**
 * 创建默认的 Redis 客户端。
 */
function createDefaultRedisClient(
  descriptor: RedisConnectionDescriptor,
  options: RedisRuntimeClientOptions,
): RedisClientLike {
  const redisOptions: RedisOptions = {
    lazyConnect: options.lazyConnect,
    enableReadyCheck: options.enableReadyCheck,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
  };

  const RedisConstructor = RedisModule as unknown as new (
    url: string,
    connectionOptions: RedisOptions,
  ) => RedisClientLike;

  return new RedisConstructor(descriptor.url, redisOptions);
}

/**
 * 连接 Redis 客户端。
 */
async function connectRedisClient(client: RedisClientLike): Promise<void> {
  await client.connect?.();
}

/**
 * 关闭 Redis 客户端。
 */
async function closeRedisClient(client: RedisClientLike): Promise<void> {
  if (client.quit !== undefined) {
    await client.quit();
    return;
  }

  client.disconnect?.();
}
