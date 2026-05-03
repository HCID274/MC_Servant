import { describe, expect, it } from "vitest";

import {
  createAppBootstrapContract,
  createAppRuntimeResources,
  createDataConfig,
  createDrizzleMigrationMetadata,
  createPostgresConnectionDescriptor,
  createPostgresRuntimeResource,
  createRedisConnectionDescriptor,
  createRedisRuntimeResource,
  runDrizzleMigrations,
} from "../index.js";

describe("db 与 app 的真实 I/O 工厂边界", () => {
  it("应创建可关闭的 PostgreSQL（关系型数据库） 运行时资源", async () => {
    const descriptor = createPostgresConnectionDescriptor(
      createDataConfig({
        env: {
          PG_HOST: "pg.internal",
          PG_DATABASE: "mc_servant",
          PG_USER: "servant",
        },
      }).postgres,
    );
    const lifecycle: string[] = [];

    const resource = await createPostgresRuntimeResource(descriptor, {
      createPool: () => ({
        async connect() {
          lifecycle.push("postgres.connect");
          return {
            release() {
              lifecycle.push("postgres.release");
            },
          };
        },
        async end() {
          lifecycle.push("postgres.end");
        },
      }),
      createDrizzle: () => ({
        $client: "fake-pg",
      }),
    });

    expect(resource.kind).toBe("postgres");
    expect(resource.descriptor).toBe(descriptor);
    expect(resource.db.$client).toBe("fake-pg");
    expect(lifecycle).toEqual(["postgres.connect", "postgres.release"]);

    await resource.close();

    expect(lifecycle).toEqual(["postgres.connect", "postgres.release", "postgres.end"]);
  });

  it("应创建可关闭的 Redis（缓存） 运行时资源，并锁定 BullMQ（任务队列） 兼容选项", async () => {
    const descriptor = createRedisConnectionDescriptor(
      createDataConfig({
        env: {
          REDIS_URL: "redis://cache.internal:6380",
        },
      }).redis,
    );
    const lifecycle: string[] = [];

    const resource = await createRedisRuntimeResource(descriptor, {
      createClient: (_resolvedDescriptor, options) => ({
        async connect() {
          lifecycle.push(`redis.connect:${String(options.maxRetriesPerRequest)}`);
        },
        async quit() {
          lifecycle.push("redis.quit");
        },
      }),
    });

    expect(resource.kind).toBe("redis");
    expect(resource.descriptor).toBe(descriptor);
    expect(resource.options).toEqual({
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
    });
    expect(lifecycle).toEqual(["redis.connect:null"]);

    await resource.close();

    expect(lifecycle).toEqual(["redis.connect:null", "redis.quit"]);
  });

  it("应复用同一份 PostgreSQL（关系型数据库） 描述符执行迁移并先确保扩展", async () => {
    const descriptor = createPostgresConnectionDescriptor(
      createDataConfig({
        env: {
          PG_HOST: "pg.internal",
          PG_DATABASE: "mc_servant",
          PG_USER: "servant",
        },
      }).postgres,
    );
    const metadata = createDrizzleMigrationMetadata({ postgres: descriptor });
    const lifecycle: string[] = [];

    const result = await runDrizzleMigrations({
      metadata,
      dependencies: {
        postgres: {
          createPool: () => ({
            async connect() {
              lifecycle.push("postgres.connect");
              return {
                release() {
                  lifecycle.push("postgres.release");
                },
              };
            },
            async query(sql) {
              lifecycle.push(`postgres.query:${sql}`);
            },
            async end() {
              lifecycle.push("postgres.end");
            },
          }),
          createDrizzle: () => ({
            $client: "fake-db",
          }),
        },
        async migrate(_database, config) {
          lifecycle.push(`migrate:${config.migrationsFolder}`);
        },
      },
    });

    expect(result.metadata.connection).toBe(descriptor);
    expect(result.ensuredExtensions).toEqual([
      "CREATE EXTENSION IF NOT EXISTS vector;",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    ]);
    expect(lifecycle).toEqual([
      "postgres.connect",
      "postgres.release",
      "postgres.query:CREATE EXTENSION IF NOT EXISTS vector;",
      "postgres.query:CREATE EXTENSION IF NOT EXISTS pg_trgm;",
      "migrate:src/db/migrations",
      "postgres.end",
    ]);
  });

  it("应让默认 Drizzle（数据库工具） 迁移器读取本地 migration（迁移） 文件", async () => {
    const descriptor = createPostgresConnectionDescriptor(
      createDataConfig({
        env: {
          PG_HOST: "pg.internal",
          PG_DATABASE: "mc_servant",
          PG_USER: "servant",
        },
      }).postgres,
    );
    const metadata = createDrizzleMigrationMetadata({ postgres: descriptor });
    const lifecycle: string[] = [];

    await runDrizzleMigrations({
      metadata,
      dependencies: {
        postgres: {
          createPool: () => ({
            async connect() {
              lifecycle.push("postgres.connect");
              return {
                release() {
                  lifecycle.push("postgres.release");
                },
              };
            },
            async query(sql) {
              lifecycle.push(`postgres.query:${sql}`);
            },
            async end() {
              lifecycle.push("postgres.end");
            },
          }),
          createDrizzle: () => ({
            dialect: {
              async migrate(
                migrations: readonly {
                  readonly sql: readonly string[];
                  readonly folderMillis: number;
                }[],
                session: unknown,
                config: { migrationsFolder: string },
              ) {
                lifecycle.push(
                  `default-migrate:${config.migrationsFolder}:${String(session)}:${migrations.length}`,
                );
                lifecycle.push(`default-migrate-sql:${migrations[0]?.sql.join("\n").length ?? 0}`);
              },
            },
            session: "fake-session",
          }),
        },
      },
    });

    expect(lifecycle).toContain("default-migrate:src/db/migrations:fake-session:1");
    expect(lifecycle.at(-1)).toBe("postgres.end");
    expect(
      Number(lifecycle.find((entry) => entry.startsWith("default-migrate-sql:"))?.split(":")[1]),
    ).toBeGreaterThan(1000);
  });

  it("应按应用装配顺序创建资源，并在关闭时按逆序释放", async () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-runtime",
      now: "2026-04-14T00:00:00.000Z",
    });
    const lifecycle: string[] = [];

    const resources = await createAppRuntimeResources(bootstrap, {
      postgres: {
        createPool: () => ({
          async connect() {
            lifecycle.push("postgres.connect");
            return {
              release() {
                lifecycle.push("postgres.release");
              },
            };
          },
          async end() {
            lifecycle.push("postgres.end");
          },
        }),
        createDrizzle: () => ({
          $client: "fake-db",
        }),
      },
      redis: {
        createClient: () => ({
          async connect() {
            lifecycle.push("redis.connect");
          },
          async quit() {
            lifecycle.push("redis.quit");
          },
        }),
      },
    });

    expect(resources.directory.create_order).toEqual(["postgres", "redis"]);
    expect(lifecycle).toEqual(["postgres.connect", "postgres.release", "redis.connect"]);

    await resources.close();

    expect(lifecycle).toEqual([
      "postgres.connect",
      "postgres.release",
      "redis.connect",
      "redis.quit",
      "postgres.end",
    ]);
  });

  it("应在 Redis（缓存） 创建失败时清理已完成的 PostgreSQL（关系型数据库） 资源", async () => {
    const bootstrap = createAppBootstrapContract({
      botId: "bot-runtime-fail",
      now: "2026-04-14T00:00:00.000Z",
    });
    const lifecycle: string[] = [];

    await expect(
      createAppRuntimeResources(bootstrap, {
        postgres: {
          createPool: () => ({
            async connect() {
              lifecycle.push("postgres.connect");
              return {
                release() {
                  lifecycle.push("postgres.release");
                },
              };
            },
            async end() {
              lifecycle.push("postgres.end");
            },
          }),
          createDrizzle: () => ({
            $client: "fake-db",
          }),
        },
        redis: {
          createClient: () => ({
            async connect() {
              lifecycle.push("redis.connect");
              throw new Error("redis unavailable");
            },
            async quit() {
              lifecycle.push("redis.quit");
            },
          }),
        },
      }),
    ).rejects.toThrow("redis unavailable");

    expect(lifecycle).toEqual([
      "postgres.connect",
      "postgres.release",
      "redis.connect",
      "redis.quit",
      "postgres.end",
    ]);
  });
});
