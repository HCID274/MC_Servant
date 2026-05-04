import { describe, expect, it } from "vitest";

import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createAppBootstrapContract,
  createAppRuntimeResources,
  createBrainTaskCard,
  createDataConfig,
  createDrizzleMigrationMetadata,
  createPersistedTaskHistoryAcceptedRecord,
  createPersistedTaskHistoryStartedPatch,
  createPersistedTaskHistoryTerminalPatch,
  createPostgresBrainSearchStore,
  createPostgresConnectionDescriptor,
  createPostgresRuntimeResource,
  createPostgresTaskEventPersister,
  createPostgresTaskHistoryStore,
  createRedisConnectionDescriptor,
  createRedisRuntimeResource,
  createSkillCallJob,
  createTaskEventDraft,
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

  it("应通过 Drizzle（数据库 ORM） insert（插入） 端口写入 task_events（任务事件）", async () => {
    const inserts: unknown[] = [];
    const persist = createPostgresTaskEventPersister({
      db: {
        insert: () => ({
          values: async (row: unknown) => {
            inserts.push(row);
          },
        }),
      },
    });

    await persist(
      createTaskEventDraft({
        task_id: "msg-task-event",
        bot_id: "bot-db",
        message_id: "msg-task-event",
        owner_text: "去捡盾牌",
        task_card: createBrainTaskCard({
          task_id: "msg-task-event",
          message_id: "msg-task-event",
          intent_epoch: 3,
          snapshot_ts: 100,
          priority: ExecPriority.Normal,
          owner_text: "去捡盾牌",
          execution: {
            type: ExecutionTaskKind.SkillCall,
            skill: "collect",
            params: {
              itemName: "shield",
              radius: 32,
            },
          },
          result: {
            status: TaskHistoryStatus.Completed,
            total_steps: 1,
            duration_ms: 1200,
          },
        }),
        embedding: [0.1, 0.2],
        created_at: "2026-04-26T01:00:00.000Z",
      }),
    );

    expect(inserts).toEqual([
      expect.objectContaining({
        id: "task-event:bot-db:msg-task-event",
        taskId: "msg-task-event",
        botId: "bot-db",
        messageId: "msg-task-event",
        ownerText: "去捡盾牌",
        embedding: [0.1, 0.2],
        createdAt: new Date("2026-04-26T01:00:00.000Z"),
      }),
    ]);
  });

  it("应通过 PostgreSQL（关系型数据库） 端口写入并更新 task_history（任务历史）", async () => {
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const store = createPostgresTaskHistoryStore({
      db: {
        insert: () => ({
          values: (row: unknown) => ({
            onConflictDoNothing: async () => {
              inserts.push(row);
            },
          }),
        }),
        update: () => ({
          set: (values: unknown) => ({
            where: async () => {
              updates.push(values);
            },
          }),
        }),
      },
    });
    const job = createSkillCallJob({
      message_id: "msg-history",
      intent_epoch: 3,
      snapshot_ts: 100,
      priority: ExecPriority.Normal,
      skill: "goTo",
      params: { x: 10, y: 64, z: 20 },
    });

    await store.insertAccepted(
      createPersistedTaskHistoryAcceptedRecord({
        bot_id: "bot-db",
        job,
        log_ref: "tasks/2026-05-04/msg-history.jsonl",
        created_at: "2026-05-04T01:00:00.000Z",
      }),
    );
    await store.markStarted(
      createPersistedTaskHistoryStartedPatch({
        id: "msg-history",
        started_at: "2026-05-04T01:00:01.000Z",
      }),
    );
    await store.markTerminal(
      createPersistedTaskHistoryTerminalPatch({
        id: "msg-history",
        status: TaskHistoryStatus.Completed,
        finished_at: "2026-05-04T01:00:03.000Z",
        duration_ms: 2000,
        total_steps: 4,
      }),
    );
    await store.markTerminal(
      createPersistedTaskHistoryTerminalPatch({
        id: "msg-history-failed",
        status: TaskHistoryStatus.Failed,
        finished_at: "2026-05-04T01:00:04.000Z",
        duration_ms: 3000,
        total_steps: 5,
        error: { name: "Error", message: "path not found" },
      }),
    );
    await store.markTerminal(
      createPersistedTaskHistoryTerminalPatch({
        id: "msg-history-interrupted",
        status: TaskHistoryStatus.Interrupted,
        finished_at: "2026-05-04T01:00:05.000Z",
        duration_ms: 4000,
        total_steps: 6,
        interrupt_source: { type: "owner" },
        reason: "owner_cancel",
      }),
    );
    await store.markDiscarded({
      id: "msg-history-discarded",
      discarded_at: "2026-05-04T01:00:06.000Z",
    });

    expect(inserts).toEqual([
      expect.objectContaining({
        id: "msg-history",
        botId: "bot-db",
        status: TaskHistoryStatus.Accepted,
        skill: "goTo",
        params: { x: 10, y: 64, z: 20 },
        logRef: "tasks/2026-05-04/msg-history.jsonl",
      }),
    ]);
    expect(updates).toEqual([
      expect.objectContaining({
        status: TaskHistoryStatus.Started,
        startedAt: new Date("2026-05-04T01:00:01.000Z"),
      }),
      expect.objectContaining({
        status: TaskHistoryStatus.Completed,
        finishedAt: new Date("2026-05-04T01:00:03.000Z"),
        durationMs: 2000,
        totalSteps: 4,
      }),
      expect.objectContaining({
        status: TaskHistoryStatus.Failed,
        finishedAt: new Date("2026-05-04T01:00:04.000Z"),
        durationMs: 3000,
        totalSteps: 5,
        error: { name: "Error", message: "path not found" },
      }),
      expect.objectContaining({
        status: TaskHistoryStatus.Interrupted,
        finishedAt: new Date("2026-05-04T01:00:05.000Z"),
        durationMs: 4000,
        totalSteps: 6,
        interruptSource: { type: "owner" },
      }),
      expect.objectContaining({
        status: TaskHistoryStatus.Discarded,
        finishedAt: new Date("2026-05-04T01:00:06.000Z"),
      }),
    ]);
  });

  it("应通过 PostgreSQL（关系型数据库） brain.search（大脑检索） 端口执行 RRF（倒数排序融合） 查询", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresBrainSearchStore({
      db: {
        $client: {
          async query(sql: string, values: readonly unknown[]) {
            queries.push({ sql, values });

            return {
              rows: [
                {
                  id: "event-1",
                  task_id: "msg-collect",
                  owner_text: "去捡盾牌",
                  takeaway: null,
                  task_card: { result: "collect 成功，捡到 shield x1" },
                  created_at: new Date("2026-04-26T01:00:00.000Z"),
                  rrf_score: 0.42,
                },
              ],
            };
          },
        },
      },
      generateEmbedding: async (text) => {
        expect(text).toBe("捡盾牌");

        return [0.1, 0.2, 0.3];
      },
    });

    const result = await store.search({
      bot_id: "bot-db",
      query: "捡盾牌",
      top_k: 20,
    });

    expect(queries).toEqual([
      {
        sql: expect.stringContaining("WITH fts AS"),
        values: ["bot-db", "捡盾牌", "[0.1,0.2,0.3]", 10],
      },
    ]);
    expect(result.hits).toEqual([
      {
        id: "event-1",
        task_id: "msg-collect",
        owner_text: "去捡盾牌",
        task_card: { result: "collect 成功，捡到 shield x1" },
        created_at: "2026-04-26T01:00:00.000Z",
        score: 0.42,
      },
    ]);
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
